//! Client pour l'API PRIM d'Île-de-France Mobilités (SIRI Lite JSON).
//! Doc : https://prim.iledefrance-mobilites.fr

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const BASE: &str = "https://prim.iledefrance-mobilites.fr/marketplace";

/// Un passage prévu d'une course à un quai.
#[derive(Debug, Clone)]
pub struct Call {
    pub quay: String,
    pub arrival_ms: Option<i64>,
    pub departure_ms: Option<i64>,
    pub state: CallState,
}

/// État signalé par la RATP dans `CallNote` / `ArrivalProximityText`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CallState {
    #[default]
    Scheduled,
    /// « Métro à l'approche »
    Approaching,
    /// « Métro à quai »
    AtStop,
}

fn call_state(c: &Value) -> CallState {
    let mut texts = Vec::new();
    for key in ["CallNote", "ArrivalProximityText", "DepartureProximityText"] {
        if let Some(t) = val(c, key) {
            texts.push(t.to_lowercase());
        }
    }
    if c.get("VehicleAtStop").and_then(Value::as_bool) == Some(true) || texts.iter().any(|t| t.contains("à quai") || t.contains("a quai")) {
        CallState::AtStop
    } else if texts.iter().any(|t| t.contains("approche")) {
        CallState::Approaching
    } else {
        CallState::Scheduled
    }
}

/// Une course (un train) avec ses prochains arrêts.
#[derive(Debug, Clone)]
pub struct Journey {
    #[allow(dead_code)]
    pub id: String,
    pub destination: String,
    /// quai terminus de la course (permet de connaître le sens)
    pub dest_quay: Option<String>,
    pub calls: Vec<Call>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Departure {
    pub line_id: String,
    pub destination: String,
    pub direction: String,
    pub expected_ms: Option<i64>,
    pub aimed_ms: Option<i64>,
    pub platform: Option<String>,
    pub at_stop: bool,
    pub status: Option<String>,
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("metro-live/0.1")
        .build()
        .expect("client http")
}

/// Dernier segment non vide d'un identifiant SIRI :
/// "STIF:StopPoint:Q:463193:" -> "463193", "STIF:Line::C01371:" -> "C01371"
pub fn tail_id(s: &str) -> &str {
    s.split(':').filter(|p| !p.is_empty()).next_back().unwrap_or(s)
}

fn val<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    let f = v.get(key)?;
    f.get("value")
        .and_then(Value::as_str)
        .or_else(|| f.as_str())
        .or_else(|| f.get(0).and_then(|x| x.get("value")).and_then(Value::as_str))
}

fn time_ms(v: &Value, key: &str) -> Option<i64> {
    let s = v.get(key)?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// Quota journalier d'un service PRIM, lu dans les en-têtes de réponse.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub limit: Option<u32>,
    pub remaining: Option<u32>,
    /// remise à zéro du compteur
    pub reset_at_ms: Option<i64>,
    /// quota épuisé : aucun appel avant cette date
    pub blocked_until_ms: Option<i64>,
}

fn quotas() -> &'static Mutex<HashMap<String, Quota>> {
    static Q: OnceLock<Mutex<HashMap<String, Quota>>> = OnceLock::new();
    Q.get_or_init(Default::default)
}

/// "…/marketplace/estimated-timetable" -> "estimated-timetable"
fn service(url: &str) -> String {
    url.split("/marketplace/").nth(1).unwrap_or(url).to_string()
}

pub fn quota(service_name: &str) -> Quota {
    quotas().lock().unwrap().get(service_name).copied().unwrap_or_default()
}

/// Date jusqu'à laquelle le service est bloqué (quota épuisé), si c'est le cas.
pub fn blocked_until(service_name: &str) -> Option<i64> {
    let now = chrono::Utc::now().timestamp_millis();
    quota(service_name).blocked_until_ms.filter(|&t| t > now)
}

fn header_num(h: &reqwest::header::HeaderMap, name: &str) -> Option<i64> {
    h.get(name)?.to_str().ok()?.trim().parse().ok()
}

pub fn quota_error(until_ms: i64) -> String {
    let at = chrono::DateTime::from_timestamp_millis(until_ms)
        .map(|d| d.with_timezone(&chrono_tz::Europe::Paris).format("%H:%M").to_string())
        .unwrap_or_default();
    format!("Quota PRIM épuisé (1 000 requêtes par jour) : reprise à {at}")
}

pub async fn get_json(http: &reqwest::Client, key: &str, url: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let svc = service(url);
    if let Some(until) = blocked_until(&svc) {
        return Err(quota_error(until)); // inutile d'appeler : on connaît la réponse
    }
    let resp = http
        .get(url)
        .query(query)
        .header("apikey", key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Réseau : {e}"))?;
    let status = resp.status();
    let now = chrono::Utc::now().timestamp_millis();
    {
        let h = resp.headers();
        let reset = header_num(h, "ratelimit-reset").map(|s| now + s * 1000);
        let mut q = quotas().lock().unwrap();
        let e = q.entry(svc.clone()).or_default();
        e.limit = header_num(h, "x-ratelimit-limit-day").map(|v| v as u32).or(e.limit);
        e.remaining = header_num(h, "x-ratelimit-remaining-day").map(|v| v as u32).or(e.remaining);
        e.reset_at_ms = reset.or(e.reset_at_ms);
        if status.as_u16() == 429 {
            let retry = header_num(h, "retry-after").map(|s| now + s * 1000).or(reset).unwrap_or(now + 3_600_000);
            e.blocked_until_ms = Some(retry);
            e.remaining = Some(0);
            return Err(quota_error(retry));
        }
        e.blocked_until_ms = None;
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("Clé API PRIM refusée (401/403)".into());
    }
    if !status.is_success() {
        return Err(format!("PRIM a répondu {status}"));
    }
    resp.json::<Value>().await.map_err(|e| format!("Réponse invalide : {e}"))
}

/// Estimated Timetable pour une ligne : toutes les courses en circulation
/// avec leurs prochains passages.
pub async fn estimated_timetable(http: &reqwest::Client, key: &str, line_id: &str) -> Result<Vec<Journey>, String> {
    let line_ref = format!("STIF:Line::{line_id}:");
    let v = get_json(http, key, &format!("{BASE}/estimated-timetable"), &[("LineRef", &line_ref)]).await?;
    Ok(parse_estimated_timetable(&v, line_id))
}

/// Arrêt supprimé (`ArrivalStatus` / `DepartureStatus` « cancelled »).
fn cancelled(c: &Value) -> bool {
    ["ArrivalStatus", "DepartureStatus"]
        .iter()
        .any(|k| c.get(*k).and_then(Value::as_str).is_some_and(|s| s.eq_ignore_ascii_case("cancelled")))
}

pub fn parse_estimated_timetable(v: &Value, line_id: &str) -> Vec<Journey> {
    let mut out = Vec::new();
    let deliveries = v
        .pointer("/Siri/ServiceDelivery/EstimatedTimetableDelivery")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for d in &deliveries {
        for frame in d.get("EstimatedJourneyVersionFrame").and_then(Value::as_array).into_iter().flatten() {
            for j in frame.get("EstimatedVehicleJourney").and_then(Value::as_array).into_iter().flatten() {
                if val(j, "LineRef").map(tail_id) != Some(line_id) {
                    continue;
                }
                // course supprimée (RER) : aucun train à placer
                if j.get("Cancellation").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let calls_v = j
                    .pointer("/EstimatedCalls/EstimatedCall")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut calls: Vec<Call> = calls_v
                    .iter()
                    .filter(|c| !cancelled(c))
                    .filter_map(|c| {
                        Some(Call {
                            quay: tail_id(val(c, "StopPointRef")?).to_string(),
                            arrival_ms: time_ms(c, "ExpectedArrivalTime").or_else(|| time_ms(c, "AimedArrivalTime")),
                            departure_ms: time_ms(c, "ExpectedDepartureTime")
                                .or_else(|| time_ms(c, "AimedDepartureTime")),
                            state: call_state(c),
                        })
                    })
                    .collect();
                calls.sort_by_key(|c| c.arrival_ms.or(c.departure_ms).unwrap_or(i64::MAX));
                let destination = val(j, "DestinationName")
                    .or_else(|| calls_v.first().and_then(|c| val(c, "DestinationDisplay")))
                    .unwrap_or("")
                    .to_string();
                let id = val(j, "DatedVehicleJourneyRef")
                    .or_else(|| j.pointer("/FramedVehicleJourneyRef/DatedVehicleJourneyRef").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                if !calls.is_empty() {
                    let dest_quay = val(j, "DestinationRef").map(|d| tail_id(d).to_string());
                    out.push(Journey { id, destination, dest_quay, calls });
                }
            }
        }
    }
    out
}

/// Stop Monitoring pour une zone d'arrêt (station), filtré sur une ligne.
pub async fn stop_monitoring(
    http: &reqwest::Client,
    key: &str,
    station_id: &str,
    line_id: &str,
) -> Result<Vec<Departure>, String> {
    let monitoring = format!("STIF:StopArea:SP:{}:", tail_id(station_id));
    let line_ref = format!("STIF:Line::{line_id}:");
    let v = get_json(
        http,
        key,
        &format!("{BASE}/stop-monitoring"),
        &[("MonitoringRef", &monitoring), ("LineRef", &line_ref)],
    )
    .await?;
    let mut out = Vec::new();
    for d in v
        .pointer("/Siri/ServiceDelivery/StopMonitoringDelivery")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for visit in d.get("MonitoredStopVisit").and_then(Value::as_array).into_iter().flatten() {
            let Some(mvj) = visit.get("MonitoredVehicleJourney") else { continue };
            let lid = val(mvj, "LineRef").map(tail_id).unwrap_or("");
            if lid != line_id {
                continue;
            }
            let call = mvj.get("MonitoredCall").cloned().unwrap_or(Value::Null);
            out.push(Departure {
                line_id: lid.to_string(),
                destination: val(mvj, "DestinationName")
                    .or_else(|| val(&call, "DestinationDisplay"))
                    .unwrap_or("")
                    .to_string(),
                direction: val(mvj, "DirectionName").unwrap_or("").to_string(),
                expected_ms: time_ms(&call, "ExpectedDepartureTime").or_else(|| time_ms(&call, "ExpectedArrivalTime")),
                aimed_ms: time_ms(&call, "AimedDepartureTime").or_else(|| time_ms(&call, "AimedArrivalTime")),
                platform: val(&call, "ArrivalPlatformName").map(str::to_string),
                at_stop: call.get("VehicleAtStop").and_then(Value::as_bool).unwrap_or(false),
                status: call
                    .get("DepartureStatus")
                    .or_else(|| call.get("ArrivalStatus"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
    }
    out.sort_by_key(|d| d.expected_ms.unwrap_or(i64::MAX));
    Ok(out)
}
