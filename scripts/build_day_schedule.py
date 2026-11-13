#!/usr/bin/env python3
"""Génère src/data/journee.json : toutes les courses d'une journée type (semaine, samedi,
dimanche) du métro et du RER, d'après les horaires théoriques du GTFS IDFM. C'est ce que rejoue
la vue « Journée en accéléré ».

Usage : python3 scripts/build_day_schedule.py <dossier_gtfs_décompressé> [sortie.json]
GTFS : https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip (il faut calendar.txt et
calendar_dates.txt en plus des fichiers lus par build_metro_data.py).

À relancer après build_metro_data.py : les stations sont désignées par leur index dans
metro.json. Les courses qui ont les mêmes arrêts et les mêmes temps de parcours partagent un
« gabarit » ; une course n'est alors plus qu'un numéro de gabarit et une heure de départ.
"""
import csv, json, sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

gtfs = Path(sys.argv[1])
racine = Path(__file__).resolve().parent.parent
out = Path(sys.argv[2]) if len(sys.argv) > 2 else racine / "src/data/journee.json"
metro = json.loads((racine / "src/data/metro.json").read_text(encoding="utf-8"))
LIGNES = {l["id"]: l for l in metro["lines"]}
# identifiant de station GTFS -> index dans la ligne
INDEX = {lid: {s["id"]: i for i, s in enumerate(l["stations"])} for lid, l in LIGNES.items()}

# Une journée de service va de 5 h à 2 h du matin : les courses d'après minuit (notées 00:xx ou
# 24:xx selon les lignes) sont toutes rangées à la fin de la journée, au-delà de 24 h.
COUPURE = 3 * 3600 + 1800

# jour type -> jours de la semaine acceptés (lundi = 0) ; le mardi et le jeudi sont les plus « normaux »
TYPES = {"semaine": (1, 3), "samedi": (5,), "dimanche": (6,)}


def rows(name):
    with open(gtfs / name, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def secs(hms):
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def jour(aaaammjj):
    return date(int(aaaammjj[:4]), int(aaaammjj[4:6]), int(aaaammjj[6:]))


route_ligne = {r["route_id"]: r["route_id"].split(":")[-1] for r in rows("routes.txt")
               if r["route_id"].split(":")[-1] in LIGNES}
trips = {t["trip_id"]: t for t in rows("trips.txt") if t["route_id"] in route_ligne}
par_service = Counter(t["service_id"] for t in trips.values())

# services en circulation chaque jour : calendar.txt, corrigé par calendar_dates.txt
actifs = defaultdict(set)
JOURS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
for c in rows("calendar.txt"):
    if c["service_id"] not in par_service:
        continue
    d, fin = jour(c["start_date"]), jour(c["end_date"])
    while d <= fin:
        if c[JOURS[d.weekday()]] == "1":
            actifs[d].add(c["service_id"])
        d += timedelta(days=1)
if (gtfs / "calendar_dates.txt").exists():
    for c in rows("calendar_dates.txt"):
        if c["service_id"] not in par_service:
            continue
        if c["exception_type"] == "1":
            actifs[jour(c["date"])].add(c["service_id"])
        else:
            actifs[jour(c["date"])].discard(c["service_id"])

# pour chaque jour type : la date qui a le plus de courses (écarte les jours de travaux ou fériés)
choisis = {}
for nom, semaine in TYPES.items():
    cands = [(sum(par_service[s] for s in sv), d) for d, sv in actifs.items() if d.weekday() in semaine]
    if not cands:
        sys.exit(f"aucun {nom} dans le GTFS")
    n = max(c for c, _ in cands)
    choisis[nom] = min(d for c, d in cands if c == n)
    print(f"{nom}: {choisis[nom]} ({n} courses)", file=sys.stderr)

types_du_service = defaultdict(list)
for nom, d in choisis.items():
    for s in actifs[d]:
        types_du_service[s].append(nom)
trips = {tid: t for tid, t in trips.items() if t["service_id"] in types_du_service}

parent = {s["stop_id"]: s.get("parent_station") or s["stop_id"] for s in rows("stops.txt")}

arrets = defaultdict(list)
with open(gtfs / "stop_times.txt", newline="", encoding="utf-8-sig") as f:
    r = csv.reader(f)
    col = {c: i for i, c in enumerate(next(r))}
    ti, si, qi, ai, di = (col[c] for c in ("trip_id", "stop_sequence", "stop_id", "arrival_time", "departure_time"))
    for row in r:
        if row[ti] in trips:
            arrets[row[ti]].append((int(row[si]), row[qi], secs(row[ai]), secs(row[di] or row[ai])))


def sens_rer(ligne, seq):
    """0 si la mission va dans le sens des parcours affichés, 1 sinon (le direction_id du GTFS n'est pas fiable)."""
    for p in ligne["patterns"]:
        commun = [x for x in seq if x in p["stations"]]
        if len(commun) >= 2:
            return 0 if p["stations"].index(commun[0]) < p["stations"].index(commun[-1]) else 1
    return 0


gabarits = defaultdict(dict)     # ligne -> clé -> numéro
courses = {nom: defaultdict(list) for nom in TYPES}
ecartees = Counter()
for tid, seq in arrets.items():
    t = trips[tid]
    lid = route_ligne[t["route_id"]]
    ligne, idx = LIGNES[lid], INDEX[lid]
    seq.sort()
    pas = []  # (station, arrivée, départ)
    for _, q, arr, dep in seq:
        s = idx.get(parent.get(q, q))
        if s is None:
            continue  # gare des seules missions rares, absente de metro.json
        if pas and pas[-1][0] == s:
            pas[-1] = (s, pas[-1][1], max(dep, arr))
        else:
            pas.append((s, arr, max(dep, arr)))
    stations = tuple(p[0] for p in pas)
    if len(pas) < 2 or len(set(stations)) != len(stations):
        ecartees[lid] += 1
        continue
    depart = pas[0][2]
    if depart < COUPURE:
        pas = [(s, a + 86400, d + 86400) for s, a, d in pas]
        depart += 86400
    sens = int(t["direction_id"] or 0) if ligne["mode"] == "metro" else sens_rer(ligne, stations)
    cle = (sens, stations, tuple(p[1] - depart for p in pas[1:]), tuple(p[2] - p[1] for p in pas[1:-1]))
    g = gabarits[lid].setdefault(cle, len(gabarits[lid]))
    for nom in types_du_service[t["service_id"]]:
        courses[nom][lid].append((depart, g))

lignes_out = {}
for lid in LIGNES:
    lignes_out[lid] = []
    for (sens, stations, arr, pause), _ in sorted(gabarits[lid].items(), key=lambda kv: kv[1]):
        g = {"sens": sens, "arrets": list(stations), "t": [0, *arr]}
        if any(pause):
            g["p"] = [0, *pause, 0]  # arrêt en gare, en secondes (absent : non renseigné par le GTFS)
        lignes_out[lid].append(g)
    n = {nom: len(courses[nom][lid]) for nom in TYPES}
    print(f"{LIGNES[lid]['mode']} {LIGNES[lid]['name']}: {len(lignes_out[lid])} gabarits, courses {n}"
          + (f", {ecartees[lid]} écartées" if ecartees[lid] else ""), file=sys.stderr)

data = {
    "generatedFrom": "IDFM GTFS",
    # période couverte par le GTFS : en dehors, les horaires affichés ne sont qu'un jour type
    "validite": {"debut": min(actifs).isoformat(), "fin": max(actifs).isoformat()},
    "gabarits": lignes_out,
    # courses à plat, triées par heure de départ : [départ en secondes depuis minuit, gabarit, départ, gabarit…]
    "jours": {nom: {"date": choisis[nom].isoformat(),
                    "courses": {lid: [x for c in sorted(courses[nom][lid]) for x in c] for lid in LIGNES}}
              for nom in TYPES},
}
out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
print("écrit", out, f"({out.stat().st_size // 1024} ko)", file=sys.stderr)
