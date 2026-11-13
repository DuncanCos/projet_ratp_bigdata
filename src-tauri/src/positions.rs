//! Estimation de la position des trains.
//!
//! Le métro n'expose pas de GPS : on déduit la position des trains à partir
//! des prochains passages (SIRI Estimated Timetable). Si le prochain train
//! attendu en B (dans un sens donné) arrive dans moins que le temps de
//! parcours A→B, il est forcément sur le segment A→B ; l'avancement est
//! calculé avec le temps de parcours médian du segment (issu du GTFS). Le front
//! anime ensuite entre `depart_at` et `arrive_at`.
//!
//! RER : une course SIRI est un vrai train (identifiant stable, liste de ses
//! arrêts, directs compris). On place donc chaque course entre la gare qu'elle
//! vient de quitter et la prochaine qu'elle dessert (`from_vehicles`).

use crate::prim::{CallState, Journey};
use crate::topology::Line;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextStop {
    pub station: usize,
    pub at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Train {
    pub id: String,
    pub line_id: String,
    /// index de station de départ du segment
    pub from: usize,
    /// index de station d'arrivée (== from si le train est à quai)
    pub to: usize,
    pub depart_at_ms: i64,
    pub arrive_at_ms: i64,
    pub at_station: bool,
    pub destination: String,
    pub next_stops: Vec<NextStop>,
}

/// Un passage annoncé à une station.
struct Pred<'a> {
    station: usize,
    dest: Option<usize>,
    arr: i64,
    dep: i64,
    state: CallState,
    name: &'a str,
}

impl Pred<'_> {
    /// Ordre de priorité : un train à quai ou à l'approche est forcément le
    /// prochain, quelle que soit l'heure (souvent déjà passée) qui l'accompagne.
    fn rank(&self) -> (u8, i64) {
        let r = match self.state {
            CallState::AtStop => 0,
            CallState::Approaching => 1,
            CallState::Scheduled => 2,
        };
        (r, self.arr)
    }
}

/// Temps maximum d'arrêt en station avant de considérer l'annonce comme périmée.
const MAX_DWELL_MS: i64 = 60_000;

pub fn from_journeys(line: &Line, journeys: &[Journey], now: i64) -> Vec<Train> {
    if line.is_rer() {
        return from_vehicles(line, journeys, now);
    }
    // Dans le flux RATP, une « course » SIRI n'est pas un train physique : elle
    // regroupe le n-ième prochain passage de chaque station. On raisonne donc
    // station par station : pour chaque sens, on ne garde que le PROCHAIN
    // passage annoncé à chaque station.
    let preds: Vec<Pred> = journeys
        .iter()
        .flat_map(|j| {
            let dest = j.dest_quay.as_ref().and_then(|q| line.quay_index.get(q).copied());
            j.calls.iter().filter_map(move |c| {
                let arr = c.arrival_ms.or(c.departure_ms).unwrap_or(now);
                Some(Pred {
                    station: *line.quay_index.get(&c.quay)?,
                    dest,
                    arr,
                    dep: c.departure_ms.unwrap_or(arr).max(arr),
                    state: c.state,
                    name: &j.destination,
                })
            })
        })
        .filter(|p| match p.state {
            // « à quai » : garde-fou contre les annonces périmées
            CallState::AtStop => p.dep >= now - 5 * 60_000,
            CallState::Approaching => p.dep >= now - 3 * 60_000,
            CallState::Scheduled => p.dep >= now,
        })
        .collect();

    // (pattern, position dans le pattern) -> prochain passage
    let mut next: HashMap<(usize, usize), &Pred> = HashMap::new();
    for pr in &preds {
        for (pi, p) in line.patterns.iter().enumerate() {
            let Some(k) = p.stations.iter().position(|&s| s == pr.station) else { continue };
            let fits = match pr.dest {
                Some(d) => p.stations[k..].contains(&d),
                None => pr.name.to_lowercase().starts_with(&p.headsign.to_lowercase()),
            };
            if fits {
                let e = next.entry((pi, k)).or_insert(pr);
                if pr.rank() < e.rank() {
                    *e = pr;
                }
            }
        }
    }

    let mut trains: Vec<Train> = Vec::new();
    // (station, sens) déjà occupés par un train à quai ou arrivant
    let mut occupied: HashSet<(usize, u8)> = HashSet::new();
    let mut seen = HashSet::new();
    // trains qui attendent peut-être à quai, déduits dans un second temps
    let mut dwell_candidates = Vec::new();
    let mut keys: Vec<_> = next.keys().copied().collect();
    keys.sort();
    for (pi, k) in keys {
        let pr = next[&(pi, k)];
        let p = &line.patterns[pi];
        let to = pr.station;
        if !seen.insert((to, pr.arr, pr.state as u8)) {
            continue; // même passage déjà placé via une autre branche
        }
        // le quai terminus fait foi ; le libellé SIRI sert de repli
        let destination = match pr.dest {
            Some(d) => line.stations[d].name.clone(),
            None if !pr.name.is_empty() => pr.name.to_string(),
            None => p.headsign.clone(),
        };
        let make = |from: usize, depart_at_ms: i64, arrive_at_ms: i64, at_station: bool| Train {
            id: format!("{}-{from}-{to}-{}", line.id, p.direction),
            line_id: line.id.clone(),
            from,
            to: if at_station { from } else { to },
            depart_at_ms,
            arrive_at_ms,
            at_station,
            destination: destination.clone(),
            next_stops: vec![NextStop { station: to, at_ms: pr.arr.max(now) }],
        };

        let at_quay = pr.state == CallState::AtStop
            || (pr.state == CallState::Scheduled && pr.arr <= now && pr.dep > pr.arr)
            || (k == 0 && pr.arr <= now)
            || (k == 0 && pr.state == CallState::Approaching);
        if at_quay {
            occupied.insert((to, p.direction));
            trains.push(make(to, now, pr.dep.max(now + 20_000), true));
            continue;
        }
        if k == 0 {
            // terminus de départ : train en attente s'il part bientôt
            if pr.arr - now < 120_000 {
                occupied.insert((to, p.direction));
                trains.push(make(to, now, pr.arr, true));
            }
            continue;
        }
        let from = p.stations[k - 1];
        let travel = line.travel(from, to) as i64 * 1000;
        let remaining = pr.arr - now;
        if pr.state == CallState::Approaching {
            // en approche : fin du segment, au moins quelques secondes
            occupied.insert((to, p.direction));
            let arr = pr.arr.max(now + 8_000);
            trains.push(make(from, arr - travel, arr, false));
        } else if remaining <= travel {
            occupied.insert((to, p.direction));
            trains.push(make(from, pr.arr - travel, pr.arr, false));
        } else if remaining <= travel + MAX_DWELL_MS {
            // il n'a pas encore quitté `from` : il y est sans doute à quai
            dwell_candidates.push((from, p.direction, make(from, now, pr.arr - travel, true)));
        }
    }
    for (from, dir, t) in dwell_candidates {
        if occupied.insert((from, dir)) {
            trains.push(t);
        }
    }
    unique_ids(&mut trains);
    trains
}

/// Identifiants uniques (le front s'en sert comme clé).
fn unique_ids(trains: &mut [Train]) {
    let mut ids: HashMap<String, usize> = HashMap::new();
    for t in trains {
        let n = ids.entry(t.id.clone()).or_insert(0);
        if *n > 0 {
            t.id = format!("{}-{n}", t.id);
        }
        *n += 1;
    }
}

/// Arrêt d'une course RER sur une gare connue de la ligne.
struct Stop {
    station: usize,
    arr: i64,
    dep: i64,
    state: CallState,
}

/// Délai au-delà duquel un train RER annoncé au départ de son origine n'est
/// pas encore affiché (il n'est sans doute pas à quai).
const RER_ORIGIN_MS: i64 = 5 * 60_000;
/// Arrêt maximal en gare avant de considérer qu'un train RER est parti.
const RER_MAX_DWELL_MS: i64 = 3 * 60_000;

/// RER : une course SIRI = un train. Il est à quai à son prochain arrêt si
/// l'heure d'arrivée est passée, sinon en route depuis l'arrêt précédent
/// (connu dans la course, ou déduit des missions du GTFS).
fn from_vehicles(line: &Line, journeys: &[Journey], now: i64) -> Vec<Train> {
    let mut trains = Vec::new();
    for (ji, j) in journeys.iter().enumerate() {
        let mut stops: Vec<Stop> = Vec::new();
        for c in &j.calls {
            let Some(&station) = line.quay_index.get(&c.quay) else { continue };
            let Some(arr) = c.arrival_ms.or(c.departure_ms) else { continue };
            let dep = c.departure_ms.unwrap_or(arr).max(arr);
            if stops.last().is_some_and(|s| s.station == station) {
                continue;
            }
            stops.push(Stop { station, arr, dep, state: c.state });
        }
        let dest = j.dest_quay.as_ref().and_then(|q| line.quay_index.get(q).copied());
        // prochain arrêt : le premier que le train n'a pas encore quitté
        let Some(n) = stops.iter().position(|s| s.dep >= now || (s.state == CallState::AtStop && s.dep >= now - 60_000))
        else {
            continue; // course terminée
        };
        let next = &stops[n];
        let destination = match dest.or(stops.last().map(|s| s.station)) {
            Some(d) => line.stations[d].name.clone(),
            None => j.destination.clone(),
        };
        let next_stops: Vec<NextStop> =
            stops[n..].iter().take(4).map(|s| NextStop { station: s.station, at_ms: s.arr.max(now) }).collect();
        let id = if j.id.is_empty() { format!("{}-rer-{ji}", line.id) } else { format!("{}-{}", line.id, j.id) };
        let train = |from: usize, to: usize, depart_at_ms: i64, arrive_at_ms: i64, at_station: bool| Train {
            id: id.clone(),
            line_id: line.id.clone(),
            from,
            to,
            depart_at_ms,
            arrive_at_ms,
            at_station,
            destination: destination.clone(),
            next_stops: next_stops.clone(),
        };

        // à quai au prochain arrêt
        if next.state == CallState::AtStop || next.arr <= now {
            trains.push(train(next.station, next.station, now, next.dep.max(now + 20_000), true));
            continue;
        }
        // en route : gare précédente dans la course, sinon d'après les missions
        let upcoming: Vec<usize> = stops[n..].iter().map(|s| s.station).collect();
        let prev = if n > 0 {
            Some((stops[n - 1].station, Some(stops[n - 1].dep)))
        } else {
            line.mission_predecessor(&upcoming, dest).map(|p| (p, None))
        };
        let Some((from, left_at)) = prev else {
            // origine de la course : le train attend à quai s'il part bientôt
            if next.arr - now < RER_ORIGIN_MS {
                trains.push(train(next.station, next.station, now, next.dep.max(now + 20_000), true));
            }
            continue;
        };
        let travel = line.seg_seconds.get(&(from, next.station)).map(|&s| s as i64 * 1000).unwrap_or(120_000);
        let depart = left_at.filter(|&t| t <= now).unwrap_or(next.arr - travel);
        if depart <= now || next.state == CallState::Approaching {
            let arr = if next.state == CallState::Approaching { next.arr.max(now + 8_000) } else { next.arr };
            trains.push(train(from, next.station, depart.min(now), arr, false));
        } else if depart - now <= RER_MAX_DWELL_MS {
            // pas encore parti de la gare précédente
            trains.push(train(from, from, now, depart, true));
        }
    }
    unique_ids(&mut trains);
    trains
}
