//! Topologie statique des lignes de métro et de RER (générée depuis le GTFS
//! IDFM par `scripts/build_metro_data.py`), embarquée dans le binaire.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

static RAW: &str = include_str!("../../src/data/metro.json");

#[derive(Debug, Deserialize)]
pub struct Network {
    pub lines: Vec<Line>,
}

#[derive(Debug, Deserialize)]
pub struct Line {
    pub id: String,
    #[allow(dead_code)]
    pub name: String,
    /// "metro" ou "rer"
    #[serde(default)]
    pub mode: String,
    pub stations: Vec<Station>,
    /// parcours (toutes les gares, dans l'ordre des voies) : tracé, branches
    pub patterns: Vec<Pattern>,
    /// RER : missions réelles (gares desservies seulement). Vide pour le métro,
    /// où chaque parcours est aussi une mission.
    #[serde(default)]
    pub services: Vec<Pattern>,
    pub segments: Vec<Segment>,
    /// quai (identifiant numérique) -> index de station
    #[serde(skip)]
    pub quay_index: HashMap<String, usize>,
    /// (from, to) -> secondes de trajet
    #[serde(skip)]
    pub seg_seconds: HashMap<(usize, usize), u32>,
}

#[derive(Debug, Deserialize)]
pub struct Station {
    pub id: String,
    #[allow(dead_code)]
    pub name: String,
    pub quays: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Pattern {
    #[allow(dead_code)]
    pub direction: u8,
    pub headsign: String,
    /// nombre de courses dans le GTFS (fréquence relative)
    #[serde(default)]
    pub trips: u32,
    pub stations: Vec<usize>,
}

#[derive(Debug, Deserialize)]
pub struct Segment {
    pub from: usize,
    pub to: usize,
    pub seconds: u32,
}

impl Line {
    pub fn is_rer(&self) -> bool {
        self.mode == "rer"
    }

    /// Missions de la ligne : les `services` pour un RER, les parcours sinon.
    pub fn missions(&self) -> &[Pattern] {
        if self.services.is_empty() { &self.patterns } else { &self.services }
    }

    /// Durée de trajet entre deux arrêts consécutifs d'une mission (90 s par défaut).
    pub fn travel(&self, from: usize, to: usize) -> u32 {
        self.seg_seconds.get(&(from, to)).copied().unwrap_or(90)
    }

    /// Gare desservie juste avant `next` par un train dont les prochains arrêts
    /// sont `upcoming` (en commençant par `next`) et le terminus `dest`. On
    /// cherche la mission qui colle le mieux à ces arrêts ; `None` si `next`
    /// est son origine (train pas encore parti) ou si rien ne correspond.
    pub fn mission_predecessor(&self, upcoming: &[usize], dest: Option<usize>) -> Option<usize> {
        let first = *upcoming.first()?;
        let mut best: Option<((usize, bool, bool, u32), Option<usize>)> = None;
        for p in self.missions() {
            let Some(k) = p.stations.iter().position(|&s| s == first) else { continue };
            let matched = upcoming.iter().zip(&p.stations[k..]).take_while(|(a, b)| a == b).count();
            let same_dest = dest.is_some_and(|d| p.stations.last() == Some(&d));
            let score = (matched, same_dest, k == 0, p.trips);
            if best.as_ref().is_none_or(|(b, _)| score > *b) {
                best = Some((score, k.checked_sub(1).map(|i| p.stations[i])));
            }
        }
        best.and_then(|(_, prev)| prev)
    }

    /// Station précédant `next` pour un train allant vers `dest` (station
    /// terminus) et/ou dont l'arrêt suivant est `after`. Sert à deviner d'où
    /// vient un train dont on ne connaît que les prochains arrêts.
    #[allow(dead_code)]
    pub fn predecessor(&self, next: usize, after: Option<usize>, dest: Option<usize>, headsign: &str) -> Option<usize> {
        let mut best: Option<(u8, usize)> = None;
        for p in &self.patterns {
            for (i, &s) in p.stations.iter().enumerate() {
                if s != next || i == 0 {
                    continue;
                }
                let follows = after.is_some_and(|a| p.stations.get(i + 1) == Some(&a));
                let same_dest = dest.is_some_and(|d| p.stations.last() == Some(&d))
                    || (!headsign.is_empty() && headsign.to_lowercase().starts_with(&p.headsign.to_lowercase()));
                let score = 1 + follows as u8 * 2 + same_dest as u8 * 2;
                if best.is_none_or(|(b, _)| score > b) {
                    best = Some((score, p.stations[i - 1]));
                }
            }
        }
        best.map(|(_, s)| s)
    }
}

pub fn network() -> &'static Network {
    static NET: OnceLock<Network> = OnceLock::new();
    NET.get_or_init(|| {
        let mut net: Network = serde_json::from_str(RAW).expect("metro.json invalide");
        for line in &mut net.lines {
            for (i, st) in line.stations.iter().enumerate() {
                for q in &st.quays {
                    line.quay_index.insert(q.clone(), i);
                }
            }
            for s in &line.segments {
                line.seg_seconds.insert((s.from, s.to), s.seconds);
            }
        }
        net
    })
}

pub fn line(id: &str) -> Option<&'static Line> {
    network().lines.iter().find(|l| l.id == id)
}
