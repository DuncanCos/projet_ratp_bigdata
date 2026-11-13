//! Archivage du temps réel : chaque vraie réponse PRIM (positions des trains
//! d'une ligne, passages à une station) est envoyée à l'API de données locale
//! (`pipeline/`), qui l'écrit dans Cassandra. Envoi en tâche de fond, erreurs
//! ignorées : la stack de données est souvent arrêtée.

use crate::positions::Train;
use crate::prim::{self, Departure};
use crate::topology::{Line, Station};
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct Position {
    pub ligne: String,
    pub train: String,
    pub de: u32,
    pub vers: u32,
    pub depart_ms: i64,
    pub arrivee_ms: i64,
    pub a_quai: bool,
    pub destination: String,
}

#[derive(Debug, Serialize)]
pub struct Passage {
    pub ligne: String,
    pub station: u32,
    pub destination: String,
    pub direction: String,
    pub attendu_ms: i64,
    pub prevu_ms: Option<i64>,
    pub quai: Option<String>,
    pub a_quai: bool,
    pub statut: Option<String>,
}

/// Corps de `POST /api/temps-reel`.
#[derive(Debug, Default, Serialize)]
pub struct Releve {
    pub releve_ms: i64,
    pub positions: Vec<Position>,
    pub passages: Vec<Passage>,
}

/// Identifiant de zone d'une station (« IDFM:71517 » -> 71517), clé commune
/// avec les validations de fréquentation.
fn zone(st: &Station) -> Option<u32> {
    prim::tail_id(&st.id).parse().ok()
}

pub fn positions(line: &Line, trains: &[Train], releve_ms: i64) -> Releve {
    let positions = trains
        .iter()
        .filter_map(|t| {
            Some(Position {
                ligne: line.id.clone(),
                train: t.id.clone(),
                de: zone(line.stations.get(t.from)?)?,
                vers: zone(line.stations.get(t.to)?)?,
                depart_ms: t.depart_at_ms,
                arrivee_ms: t.arrive_at_ms,
                a_quai: t.at_station,
                destination: t.destination.clone(),
            })
        })
        .collect();
    Releve { releve_ms, positions, ..Default::default() }
}

pub fn passages(line: &Line, station: &Station, deps: &[Departure], releve_ms: i64) -> Releve {
    let Some(z) = zone(station) else { return Releve { releve_ms, ..Default::default() } };
    let passages = deps
        .iter()
        .filter_map(|d| {
            Some(Passage {
                ligne: line.id.clone(),
                station: z,
                destination: d.destination.clone(),
                direction: d.direction.clone(),
                attendu_ms: d.expected_ms?,
                prevu_ms: d.aimed_ms,
                quai: d.platform.clone(),
                a_quai: d.at_stop,
                statut: d.status.clone(),
            })
        })
        .collect();
    Releve { releve_ms, passages, ..Default::default() }
}

/// Envoi sans attendre ni signaler d'erreur. `METRO_DATA_API` : adresse de
/// l'API de données (défaut http://localhost:8000).
pub fn send(http: &reqwest::Client, releve: Releve) {
    if releve.positions.is_empty() && releve.passages.is_empty() {
        return;
    }
    let base = std::env::var("METRO_DATA_API").unwrap_or_else(|_| "http://localhost:8000".into());
    let url = format!("{}/api/temps-reel", base.trim_end_matches('/'));
    let http = http.clone();
    tauri::async_runtime::spawn(async move {
        let _ = http.post(url).timeout(Duration::from_secs(2)).json(&releve).send().await;
    });
}
