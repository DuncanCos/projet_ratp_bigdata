//! Info trafic : perturbations et travaux sur les lignes de métro.
//! Source : PRIM « disruptions_bulk/disruptions/v2 » (un appel pour tout le réseau).

use crate::topology::{self, Line};
use chrono::{NaiveDateTime, TimeZone};
use chrono_tz::Europe::Paris;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

/// On n'affiche que ce qui commence dans les 7 prochains jours.
const HORIZON_MS: i64 = 7 * 24 * 3_600_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disruption {
    pub id: String,
    pub title: String,
    pub short_message: String,
    pub message: String,
    /// BLOQUANTE | PERTURBEE | INFORMATION
    pub severity: String,
    /// TRAVAUX | PERTURBATION | INFORMATION
    pub cause: String,
    /// en cours à l'instant de la requête
    pub active: bool,
    /// période en cours, ou prochaine période à venir
    pub begin_ms: i64,
    pub end_ms: i64,
    /// stations (index dans la ligne) touchées
    pub stations: Vec<usize>,
    /// toute la ligne est concernée
    pub whole_line: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficInfo {
    pub demo: bool,
    pub fetched_at_ms: i64,
    /// id de ligne (ex. C01371) -> perturbations, les plus graves d'abord
    pub lines: HashMap<String, Vec<Disruption>>,
}

/// "20261111T044500" en heure de Paris -> epoch ms
fn paris_ms(s: &str) -> Option<i64> {
    let naive = NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%S").ok()?;
    Paris.from_local_datetime(&naive).earliest().map(|d| d.timestamp_millis())
}

fn tail(s: &str) -> &str {
    s.rsplit(':').next().unwrap_or(s)
}

/// Texte brut à partir du HTML des messages (balises retirées, entités décodées).
pub fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('>') else {
            rest = "";
            break;
        };
        let tag = rest[i + 1..i + j].trim_start_matches('/').to_lowercase();
        if tag.starts_with("br") || tag.starts_with("p") || tag.starts_with("li") || tag.starts_with("div") {
            out.push('\n');
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);

    let mut decoded = String::new();
    let mut s = out.as_str();
    while let Some(i) = s.find('&') {
        decoded.push_str(&s[..i]);
        let after = &s[i..];
        match after.find(';').filter(|&k| k <= 10) {
            Some(k) => {
                let ent = &after[1..k];
                let ch = match ent {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ if ent.starts_with("#x") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
                    _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                    _ => None,
                };
                match ch {
                    Some(c) => decoded.push(c),
                    None => decoded.push_str(&after[..=k]),
                }
                s = &after[k + 1..];
            }
            None => {
                decoded.push('&');
                s = &after[1..];
            }
        }
    }
    decoded.push_str(s);
    // lignes vides multiples -> une seule
    decoded
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn station_by_area(line: &Line, area_id: &str) -> Option<usize> {
    let id = tail(area_id);
    line.stations.iter().position(|s| tail(&s.id) == id)
}

/// Stations entre `a` et `b` inclus, le long d'un pattern qui contient les deux.
fn stations_between(line: &Line, a: usize, b: usize) -> Vec<usize> {
    for p in &line.patterns {
        let (Some(i), Some(j)) = (
            p.stations.iter().position(|&s| s == a),
            p.stations.iter().position(|&s| s == b),
        ) else {
            continue;
        };
        let (lo, hi) = (i.min(j), i.max(j));
        return p.stations[lo..=hi].to_vec();
    }
    vec![a, b]
}

fn severity_rank(s: &str) -> u8 {
    match s {
        "BLOQUANTE" => 0,
        "PERTURBEE" => 1,
        _ => 2,
    }
}

pub fn parse(v: &Value, now: i64) -> HashMap<String, Vec<Disruption>> {
    let disruptions: HashMap<&str, &Value> = v
        .get("disruptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|d| Some((d.get("id")?.as_str()?, d)))
        .collect();

    let mut out: HashMap<String, Vec<Disruption>> = HashMap::new();
    for l in v.get("lines").and_then(Value::as_array).into_iter().flatten() {
        let Some(line) = l.get("id").and_then(Value::as_str).and_then(|id| topology::line(tail(id))) else {
            continue; // pas une ligne de métro connue
        };
        // disruption id -> (stations, toute la ligne)
        let mut impacts: HashMap<&str, (BTreeSet<usize>, bool)> = HashMap::new();
        for o in l.get("impactedObjects").and_then(Value::as_array).into_iter().flatten() {
            let kind = o.get("type").and_then(Value::as_str).unwrap_or("");
            let oid = o.get("id").and_then(Value::as_str).unwrap_or("");
            for did in o.get("disruptionIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                let e = impacts.entry(did).or_default();
                match kind {
                    "line" => e.1 = true,
                    "stop_point" => {
                        if let Some(&s) = line.quay_index.get(tail(oid)) {
                            e.0.insert(s);
                        }
                    }
                    "stop_area" => {
                        if let Some(s) = station_by_area(line, oid) {
                            e.0.insert(s);
                        }
                    }
                    _ => {}
                }
            }
        }

        let mut list = Vec::new();
        for (did, (mut stations, whole_line)) in impacts {
            let Some(d) = disruptions.get(did) else { continue };
            // tronçons interrompus : toutes les stations entre from et to
            for sec in d.get("impactedSections").and_then(Value::as_array).into_iter().flatten() {
                if sec.get("lineId").and_then(Value::as_str).map(tail) != Some(line.id.as_str()) {
                    continue;
                }
                let from = sec.pointer("/from/id").and_then(Value::as_str).and_then(|a| station_by_area(line, a));
                let to = sec.pointer("/to/id").and_then(Value::as_str).and_then(|a| station_by_area(line, a));
                if let (Some(a), Some(b)) = (from, to) {
                    stations.extend(stations_between(line, a, b));
                }
            }
            // période en cours, sinon prochaine période dans l'horizon
            let periods: Vec<(i64, i64)> = d
                .get("applicationPeriods")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|p| {
                    Some((paris_ms(p.get("begin")?.as_str()?)?, paris_ms(p.get("end")?.as_str()?)?))
                })
                .filter(|&(_, e)| e > now)
                .collect();
            let current = periods.iter().find(|&&(b, e)| b <= now && now < e);
            let upcoming = periods.iter().filter(|&&(b, _)| b > now && b < now + HORIZON_MS).min();
            let Some(&(begin_ms, end_ms)) = current.or(upcoming) else { continue };
            let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            list.push(Disruption {
                id: did.to_string(),
                title: s("title"),
                short_message: s("shortMessage"),
                message: html_to_text(&s("message")),
                severity: s("severity"),
                cause: s("cause"),
                active: current.is_some(),
                begin_ms,
                end_ms,
                stations: stations.into_iter().collect(),
                whole_line,
            });
        }
        list.sort_by_key(|d| (!d.active, severity_rank(&d.severity), d.begin_ms));
        // même annonce publiée plusieurs fois (une par période) : on garde la première
        let mut titles = std::collections::HashSet::new();
        list.retain(|d| titles.insert((d.title.clone(), d.active)));
        if !list.is_empty() {
            out.insert(line.id.clone(), list);
        }
    }
    out
}
