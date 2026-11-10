mod positions;
mod prim;
mod topology;
mod traffic;

use positions::Train;
use prim::{Departure, Journey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{Manager, State};
use tokio::sync::Mutex;

/// Durée de vie du cache par ligne : évite d'épuiser le quota PRIM si
/// plusieurs vues demandent la même ligne.
const CACHE_TTL: Duration = Duration::from_secs(20);

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Config {
    api_key: Option<String>,
}

struct AppState {
    http: reqwest::Client,
    config_path: PathBuf,
    config: Mutex<Config>,
    cache: Mutex<HashMap<String, (Instant, Vec<Journey>)>>,
    traffic: Mutex<Option<(Instant, traffic::TrafficInfo)>>,
}

impl AppState {
    async fn api_key(&self) -> Option<String> {
        let saved = self.config.lock().await.api_key.clone();
        saved
            .or_else(|| std::env::var("PRIM_API_KEY").ok())
            .filter(|k| !k.trim().is_empty())
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    has_key: bool,
    key_from_env: bool,
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let saved = state.config.lock().await.api_key.is_some();
    let has_key = state.api_key().await.is_some();
    Ok(Settings { has_key, key_from_env: has_key && !saved })
}

#[tauri::command]
async fn set_api_key(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    let mut cfg = state.config.lock().await;
    cfg.api_key = if key.is_empty() { None } else { Some(key) };
    if let Some(dir) = state.config_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&*cfg).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;
    state.cache.lock().await.clear();
    *state.traffic.lock().await = None;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainsResponse {
    /// aucune clé API : tout est simulé
    demo: bool,
    fetched_at_ms: i64,
    trains: Vec<Train>,
    /// lignes réellement en temps réel (les autres : horaires théoriques)
    live_lines: Vec<String>,
    errors: HashMap<String, String>,
    quota: prim::Quota,
    /// quota épuisé jusqu'à cette date : temps réel indisponible
    quota_blocked_until_ms: Option<i64>,
}

async fn journeys_for(state: &AppState, key: &str, line_id: &str) -> Result<Vec<Journey>, String> {
    if let Some((at, j)) = state.cache.lock().await.get(line_id) {
        if at.elapsed() < CACHE_TTL {
            return Ok(j.clone());
        }
    }
    let j = prim::estimated_timetable(&state.http, key, line_id).await?;
    state.cache.lock().await.insert(line_id.to_string(), (Instant::now(), j.clone()));
    Ok(j)
}

/// Positions des trains. `live_ids` : lignes à interroger en temps réel (le
/// quota PRIM est de 1 000 requêtes par jour) ; les autres lignes de
/// `line_ids` sont placées d'après les horaires théoriques.
#[tauri::command]
async fn get_trains(
    state: State<'_, AppState>,
    line_ids: Vec<String>,
    live_ids: Vec<String>,
) -> Result<TrainsResponse, String> {
    let now = now_ms();
    let lines: Vec<_> = line_ids.iter().filter_map(|id| topology::line(id)).collect();
    let key = state.api_key().await;
    let blocked = prim::blocked_until("estimated-timetable");
    let mut trains = Vec::new();
    let mut errors = HashMap::new();
    let mut live_lines = Vec::new();

    if let (Some(key), None) = (&key, blocked) {
        let live: Vec<_> = lines.iter().filter(|l| live_ids.contains(&l.id)).collect();
        let results = futures::future::join_all(live.iter().map(|l| journeys_for(&state, key, &l.id))).await;
        for (line, res) in live.iter().zip(results) {
            match res {
                Ok(j) => {
                    trains.extend(positions::from_journeys(line, &j, now_ms()));
                    live_lines.push(line.id.clone());
                }
                Err(e) => {
                    errors.insert(line.id.clone(), e);
                }
            }
        }
    }
    // tout ce qui n'est pas en temps réel : horaires théoriques
    for l in &lines {
        if !live_lines.contains(&l.id) {
            trains.extend(positions::simulate(l, now));
        }
    }
    Ok(TrainsResponse {
        demo: key.is_none(),
        fetched_at_ms: now,
        trains,
        live_lines,
        errors,
        quota: prim::quota("estimated-timetable"),
        quota_blocked_until_ms: prim::blocked_until("estimated-timetable"),
    })
}

/// L'info trafic change peu : un appel toutes les 2 minutes au plus.
const TRAFFIC_TTL: Duration = Duration::from_secs(120);

/// Perturbations en cours et à venir (7 jours) sur les lignes de métro.
#[tauri::command]
async fn get_traffic(state: State<'_, AppState>) -> Result<traffic::TrafficInfo, String> {
    let Some(key) = state.api_key().await else {
        return Ok(traffic::TrafficInfo { demo: true, fetched_at_ms: now_ms(), lines: HashMap::new() });
    };
    if let Some((at, info)) = &*state.traffic.lock().await {
        if at.elapsed() < TRAFFIC_TTL {
            return Ok(info.clone());
        }
    }
    let v = prim::get_json(&state.http, &key, &format!("{}/disruptions_bulk/disruptions/v2", prim::BASE), &[]).await?;
    let now = now_ms();
    let info = traffic::TrafficInfo { demo: false, fetched_at_ms: now, lines: traffic::parse(&v, now) };
    *state.traffic.lock().await = Some((Instant::now(), info.clone()));
    Ok(info)
}

/// Prochains passages d'une ligne à une station.
#[tauri::command]
async fn get_departures(
    state: State<'_, AppState>,
    line_id: String,
    station_index: usize,
) -> Result<Vec<Departure>, String> {
    let line = topology::line(&line_id).ok_or("Ligne inconnue")?;
    let station = line.stations.get(station_index).ok_or("Station inconnue")?;
    match state.api_key().await {
        Some(key) => prim::stop_monitoring(&state.http, &key, &station.id, &line_id).await,
        None => {
            let now = now_ms();
            let mut deps: Vec<Departure> = positions::simulate(line, now)
                .into_iter()
                .filter_map(|t| {
                    let ns = t.next_stops.iter().find(|n| n.station == station_index)?;
                    Some(Departure {
                        line_id: line_id.clone(),
                        destination: t.destination.clone(),
                        direction: String::new(),
                        expected_ms: Some(ns.at_ms),
                        aimed_ms: None,
                        platform: None,
                        at_stop: t.at_station && t.from == station_index,
                        status: Some("démo".into()),
                    })
                })
                .collect();
            deps.sort_by_key(|d| d.expected_ms);
            Ok(deps)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let config_path = dir.join("config.json");
            let config = std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            app.manage(AppState {
                http: prim::client(),
                config_path,
                config: Mutex::new(config),
                cache: Mutex::new(HashMap::new()),
                traffic: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_settings, set_api_key, get_trains, get_departures, get_traffic])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topology_loads() {
        let net = topology::network();
        assert_eq!(net.lines.len(), 21);
        assert_eq!(net.lines.iter().filter(|l| l.is_rer()).count(), 5);
        let l1 = topology::line("C01371").unwrap();
        assert_eq!(l1.stations.len(), 25);
        assert!(l1.quay_index.contains_key("463193"));
    }

    #[test]
    fn simulation_produces_trains() {
        for l in &topology::network().lines {
            let t = positions::simulate(l, now_ms());
            assert!(!t.is_empty(), "ligne {}", l.name);
        }
    }

    /// RER A : ligne et missions (Marne-la-Vallée, Cergy…).
    fn rer_a() -> &'static topology::Line {
        topology::line("C01742").unwrap()
    }

    #[test]
    fn rer_train_between_calls() {
        let l = rer_a();
        let sv = &l.services[0];
        let now = 1_000_000_000_000;
        let q = |k: usize| l.stations[sv.stations[k]].quays[0].clone();
        let call = |k: usize, at: i64| prim::Call { quay: q(k), arrival_ms: Some(at), departure_ms: Some(at + 30_000), state: prim::CallState::Scheduled };
        // course qui a quitté l'arrêt 3 il y a 30 s et arrive à l'arrêt 4 dans 60 s
        let j = Journey {
            id: "RER-1".into(),
            destination: String::new(),
            dest_quay: Some(q(sv.stations.len() - 1)),
            calls: vec![call(3, now - 60_000), call(4, now + 60_000), call(5, now + 200_000)],
        };
        let t = positions::from_journeys(l, &[j], now);
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].from, t[0].to, t[0].at_station), (sv.stations[3], sv.stations[4], false));
        assert_eq!(t[0].depart_at_ms, now - 30_000);
        assert_eq!(t[0].destination, l.stations[*sv.stations.last().unwrap()].name);
        assert!(t[0].id.contains("RER-1"));

        // seuls les arrêts à venir sont connus : la gare précédente vient des missions
        let j = Journey { id: "RER-2".into(), destination: String::new(), dest_quay: None, calls: vec![call(6, now + 30_000), call(7, now + 200_000)] };
        let t = positions::from_journeys(l, &[j], now);
        assert_eq!((t[0].from, t[0].to), (sv.stations[5], sv.stations[6]));

        // à quai, puis course pas encore partie de son origine (lointaine) : ignorée
        let j = Journey { id: "RER-3".into(), destination: String::new(), dest_quay: None, calls: vec![call(2, now - 10_000)] };
        let far = Journey { id: "RER-4".into(), destination: String::new(), dest_quay: None, calls: vec![call(0, now + 20 * 60_000), call(1, now + 22 * 60_000)] };
        let t = positions::from_journeys(l, &[j, far], now);
        assert_eq!(t.len(), 1);
        assert!(t[0].at_station && t[0].from == sv.stations[2]);
    }

    #[test]
    fn rer_express_hop_uses_mission_times() {
        // une mission directe (arrêts non consécutifs sur les voies) a ses propres temps
        for l in topology::network().lines.iter().filter(|l| l.is_rer()) {
            for sv in &l.services {
                for w in sv.stations.windows(2) {
                    assert!(l.seg_seconds.contains_key(&(w[0], w[1])), "RER {} {:?}", l.name, w);
                }
            }
            // les parcours affichés passent par toutes les gares de la ligne
            let mut seen = std::collections::HashSet::new();
            l.patterns.iter().for_each(|p| seen.extend(p.stations.iter().copied()));
            assert_eq!(seen.len(), l.stations.len(), "RER {}", l.name);
        }
    }

    #[test]
    fn journey_positioning() {
        let l1 = topology::line("C01371").unwrap();
        let p = &l1.patterns[0];
        let (a, b, c) = (p.stations[3], p.stations[4], p.stations[5]);
        let q = |s: usize| l1.stations[s].quays[0].clone();
        let now = 1_000_000_000_000;
        let j = Journey {
            id: "x".into(),
            destination: p.headsign.clone(),
            dest_quay: None,
            calls: vec![
                prim::Call { quay: q(b), arrival_ms: Some(now + 30_000), departure_ms: Some(now + 50_000), state: prim::CallState::Scheduled },
                prim::Call { quay: q(c), arrival_ms: Some(now + 400_000), departure_ms: None, state: prim::CallState::Scheduled },
            ],
        };
        let t = positions::from_journeys(l1, &[j], now);
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].from, t[0].to), (a, b));
        assert!(!t[0].at_station);
    }

    #[test]
    fn single_call_uses_destination_quay() {
        let l1 = topology::line("C01371").unwrap();
        let now = 1_000_000_000_000;
        for p in &l1.patterns {
            let (a, b) = (p.stations[5], p.stations[6]);
            let last = *p.stations.last().unwrap();
            let j = Journey {
                id: "y".into(),
                destination: "Terminus (libellé différent)".into(),
                dest_quay: Some(l1.stations[last].quays[0].clone()),
                calls: vec![prim::Call {
                    quay: l1.stations[b].quays[0].clone(),
                    arrival_ms: Some(now + 20_000),
                    departure_ms: Some(now + 40_000),
                    state: prim::CallState::Scheduled,
                }],
            };
            let t = positions::from_journeys(l1, &[j], now);
            assert_eq!((t[0].from, t[0].to), (a, b), "sens {}", p.direction);
        }
    }

    #[test]
    fn at_stop_and_approaching_with_past_times() {
        let l1 = topology::line("C01371").unwrap();
        let p = &l1.patterns[0];
        let last = *p.stations.last().unwrap();
        let now = 1_000_000_000_000;
        let call = |s: usize, state| prim::Call {
            quay: l1.stations[s].quays[0].clone(),
            arrival_ms: Some(now - 30_000),
            departure_ms: Some(now - 30_000),
            state,
        };
        let j = Journey {
            id: "z".into(),
            destination: p.headsign.clone(),
            dest_quay: Some(l1.stations[last].quays[0].clone()),
            calls: vec![call(p.stations[3], prim::CallState::AtStop), call(p.stations[10], prim::CallState::Approaching)],
        };
        let t = positions::from_journeys(l1, &[j], now);
        assert_eq!(t.len(), 2);
        assert!(t.iter().any(|t| t.at_station && t.from == p.stations[3]));
        assert!(t.iter().any(|t| !t.at_station && t.to == p.stations[10] && t.from == p.stations[9]));
    }

    /// Vérification sur une vraie réponse PRIM :
    /// ET_JSON=chemin/vers/reponse.json [LINE=C01377] cargo test real_response -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_response() {
        let path = std::env::var("ET_JSON").expect("ET_JSON");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let ts = v.pointer("/Siri/ServiceDelivery/ResponseTimestamp").and_then(|t| t.as_str()).unwrap();
        let now = chrono::DateTime::parse_from_rfc3339(ts).unwrap().timestamp_millis();
        let line_id = std::env::var("LINE").unwrap_or_else(|_| "C01371".into());
        let l1 = topology::line(&line_id).unwrap();
        let journeys = prim::parse_estimated_timetable(&v, &line_id);
        let known = journeys.iter().flat_map(|j| &j.calls).filter(|c| l1.quay_index.contains_key(&c.quay)).count();
        let total: usize = journeys.iter().map(|j| j.calls.len()).sum();
        println!("quais reconnus : {known}/{total}");
        let trains = positions::from_journeys(l1, &journeys, now);
        println!("{} courses -> {} trains", journeys.len(), trains.len());
        for t in &trains {
            println!(
                "{:>28} -> {:<28} vers {:<26} {}",
                l1.stations[t.from].name, l1.stations[t.to].name, t.destination,
                if t.at_station { "à quai" } else { "" }
            );
        }
    }

    #[test]
    fn html_messages() {
        assert_eq!(
            traffic::html_to_text("<p>P&#233;riode : les soir&#233;es.<br><br>Bus &amp; RER</p>"),
            "Période : les soirées.\nBus & RER"
        );
    }

    /// INFO_JSON=disruptions.json cargo test real_traffic -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_traffic() {
        let path = std::env::var("INFO_JSON").expect("INFO_JSON");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let now = chrono::DateTime::parse_from_rfc3339(v["lastUpdatedDate"].as_str().unwrap()).unwrap().timestamp_millis();
        let info = traffic::parse(&v, now);
        for l in &topology::network().lines {
            for d in info.get(&l.id).into_iter().flatten() {
                let names: Vec<_> = d.stations.iter().map(|&s| l.stations[s].name.as_str()).collect();
                println!(
                    "{:>3} {:<10} {:<11} {} | {} | {:?}{}",
                    l.name, if d.active { "EN COURS" } else { "à venir" }, d.severity, d.title,
                    chrono::DateTime::from_timestamp_millis(d.begin_ms).unwrap().with_timezone(&chrono_tz::Europe::Paris).format("%d/%m %H:%M"),
                    names, if d.whole_line { " [ligne]" } else { "" }
                );
            }
        }
    }

    #[test]
    fn tail_ids() {
        assert_eq!(prim::tail_id("STIF:StopPoint:Q:463193:"), "463193");
        assert_eq!(prim::tail_id("STIF:Line::C01371:"), "C01371");
    }
}
