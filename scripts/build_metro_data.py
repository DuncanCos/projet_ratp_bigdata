#!/usr/bin/env python3
"""Génère src/data/metro.json (métro et RER) à partir du GTFS IDFM.

Usage : python3 scripts/build_metro_data.py <dossier_gtfs_décompressé> [sortie.json]
GTFS : https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip

Pour chaque ligne de métro on extrait :
  - les stations (regroupement des quais par parent_station) avec coordonnées
  - la liste des quais (identifiants utilisés par l'API temps réel SIRI de PRIM)
  - les "patterns" : séquences ordonnées de stations par sens (gère les branches)
  - le temps de parcours médian entre deux stations consécutives

Pour les RER (missions omnibus, semi-directes, directes), voir `build_rer` :
le tracé est reconstitué à partir des arrêts physiquement voisins, et les
missions sont gardées à part (`services`) pour la simulation et le temps réel.
"""
import csv, json, math, sys, statistics, unicodedata, urllib.parse, urllib.request
from collections import defaultdict, Counter
from pathlib import Path

gtfs = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "src/data/metro.json"

ORDER = ["1", "2", "3", "3B", "4", "5", "6", "7", "7B", "8", "9", "10", "11", "12", "13", "14"]
RER_ORDER = ["A", "B", "C", "D", "E"]

def rows(name):
    with open(gtfs / name, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)

routes = {}
for r in rows("routes.txt"):
    if r["route_type"] == "1" and r["agency_id"] == "IDFM:Operator_100" and r["route_short_name"] in ORDER:
        routes[r["route_id"]] = dict(r, mode="metro")
    # RER : route_type 2 ; les « Remplacement RER B » (bus) sont de type 3
    elif r["route_type"] == "2" and r["route_short_name"] in RER_ORDER and r["route_long_name"] == r["route_short_name"]:
        routes[r["route_id"]] = dict(r, mode="rer")
print("lignes :", sorted(r["route_short_name"] for r in routes.values()), file=sys.stderr)

def sort_key(r):
    return (0, ORDER.index(r["route_short_name"])) if r["mode"] == "metro" else (1, RER_ORDER.index(r["route_short_name"]))

trips = {}
for t in rows("trips.txt"):
    if t["route_id"] in routes:
        trips[t["trip_id"]] = t

def secs(hms):
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)

trip_stops = defaultdict(list)
metro_shape_ids = {t["shape_id"] for t in trips.values() if t["shape_id"]}
shapes = defaultdict(list)
if (gtfs / "shapes.txt").exists():
    for r in rows("shapes.txt"):
        if r["shape_id"] in metro_shape_ids:
            shapes[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
    for v in shapes.values():
        v.sort()
else:
    print("shapes.txt absent : tracés en ligne droite", file=sys.stderr)
for st in rows("stop_times.txt"):
    if st["trip_id"] in trips:
        trip_stops[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"], secs(st["arrival_time"])))

needed = {s for v in trip_stops.values() for _, s, _ in v}
stops = {}
for s in rows("stops.txt"):
    stops[s["stop_id"]] = s

def station_of(quay):
    p = stops[quay].get("parent_station") or quay
    return p

def norm(name):
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return "".join(ch for ch in n if ch.isalnum())

def dist_m(a, b):
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0]))
    dy = (a[0] - b[0]) * 110540
    return math.hypot(dx, dy)

def idfm_quays(arrtype):
    """Tous les quais d'un mode du référentiel des arrêts IDFM. Métro : certains
    (ex. Carrefour Pleyel 22239) sont utilisés par le temps réel mais absents du
    GTFS. RER : le GTFS ne donne que la zone d'arrêt (`zdaid`), le temps réel
    SIRI désigne les quais."""
    out, offset = [], 0
    base = "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets/records"
    while True:
        url = (f"{base}?where=arrtype%3D%22{arrtype}%22&select=arrid,arrname,arrgeopoint,arraccessibility,"
               f"arraudiblesignals,arrvisualsigns,zdaid&limit=100&offset={offset}")
        with urllib.request.urlopen(url, timeout=60) as resp:
            page = json.load(resp)["results"]
        out += page
        if len(page) < 100:
            return out
        offset += 100

try:
    EXTRA = idfm_quays("metro")
    RAIL = idfm_quays("rail")
    print("quais référentiel IDFM : métro", len(EXTRA), "ferré", len(RAIL), file=sys.stderr)
except Exception as e:  # le script reste utilisable hors ligne
    print("référentiel IDFM indisponible :", e, file=sys.stderr)
    EXTRA, RAIL = [], []
# zone d'arrêt ferrée -> quais
RAIL_BY_ZDA = defaultdict(set)
for q in RAIL:
    if q.get("zdaid"):
        RAIL_BY_ZDA[str(q["zdaid"])].add(str(q["arrid"]))

def simplify(pts, tol_m=2.0):
    """Douglas-Peucker (distances en mètres, approximation plane locale)."""
    if len(pts) < 3:
        return list(range(len(pts)))
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        best, bi = 0.0, None
        ax, ay = pts[a][1] * 73000, pts[a][0] * 111000
        bx, by = pts[b][1] * 73000, pts[b][0] * 111000
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1e-9
        for i in range(a + 1, b):
            px, py = pts[i][1] * 73000, pts[i][0] * 111000
            d = abs(dy * (px - ax) - dx * (py - ay)) / L
            if d > best:
                best, bi = d, i
        if bi is not None and best > tol_m:
            keep.add(bi)
            stack += [(a, bi), (bi, b)]
    return sorted(keep)

ANCHOR_MAX_M = 250  # le centre des grandes stations peut être loin des voies

def anchor(raw, st_objs):
    """Associe chaque station à un point du tracé en respectant l'ordre
    (programmation dynamique : indices croissants, somme des distances minimale).
    Une station trop loin du tracé reste non accrochée (None)."""
    n = len(raw)
    INF = float("inf")
    prev_cost = [0.0] * n
    back = []
    for st in st_objs:
        p = (st["lat"], st["lon"])
        # coût cumulé : min sur j <= i du coût précédent (minimum préfixe)
        best_j, best_c = [0] * n, [INF] * n
        m, mj = INF, 0
        for i in range(n):
            if prev_cost[i] < m:
                m, mj = prev_cost[i], i
            best_c[i], best_j[i] = m, mj
        cur = [best_c[i] + min(dist_m(raw[i], p), ANCHOR_MAX_M * 2) for i in range(n)]
        back.append(best_j)
        prev_cost = cur
    i = min(range(n), key=lambda i: prev_cost[i])
    idx = []
    for k in range(len(st_objs) - 1, -1, -1):
        idx.append(i)
        i = back[k][i]
    idx.reverse()
    return [i if dist_m(raw[i], (st["lat"], st["lon"])) <= ANCHOR_MAX_M else None for i, st in zip(idx, st_objs)]

def path_len(pts):
    return sum(dist_m(a, b) for a, b in zip(pts, pts[1:]))

def segment_points(raw, anchors, kept):
    """Points du tracé entre deux stations consécutives (None si non couvert)."""
    out = [None]
    for k in range(1, len(anchors)):
        a, b = anchors[k - 1], anchors[k]
        # garde-fou : un tronçon qui fait un grand détour (dépôt, boucle) est ignoré
        if a is not None and b is not None and b > a and path_len(raw[a:b + 1]) <= 2.5 * dist_m(raw[a], raw[b]) + 300:
            out.append([raw[a]] + [raw[i] for i in range(a + 1, b) if i in kept] + [raw[b]])
        else:
            out.append(None)
    return out

def build_path(raw, anchors, st_objs):
    kept = set(simplify(raw)) if len(raw) >= 2 else set()
    segs = segment_points(raw, anchors, kept)
    path, station_points, covered = [], [], 0
    for k, st in enumerate(st_objs):
        b = anchors[k]
        here = raw[b] if b is not None else (st["lat"], st["lon"])
        if segs[k] is not None:
            path += segs[k][1:-1]
            covered += 1
        path.append(here)
        station_points.append(len(path) - 1)
    return path, station_points, covered

def merged_geometry(st_objs, shape_ids):
    """Comme `pattern_geometry`, mais tronçon par tronçon : chaque tronçon prend
    le premier tracé (dans l'ordre de `shape_ids`) qui le couvre. Utile pour les
    RER, dont aucune mission ne parcourt seule tout un parcours reconstitué."""
    n = len(st_objs)
    best = [None] * n
    anchor_pt = [None] * n
    for sid in shape_ids:
        raw = [(lat, lon) for _, lat, lon in shapes.get(sid, [])]
        if len(raw) < 2:
            continue
        anchors = anchor(raw, st_objs)
        segs = segment_points(raw, anchors, set(simplify(raw)))
        for k in range(n):
            if anchor_pt[k] is None and anchors[k] is not None:
                anchor_pt[k] = raw[anchors[k]]
            if best[k] is None and segs[k] is not None:
                best[k] = segs[k]
        if all(b is not None for b in best[1:]):
            break
    path, station_points = [], []
    for k, st in enumerate(st_objs):
        # la station se place au bout du tronçon qui y arrive, sinon sur un tracé, sinon à sa position
        here = best[k][-1] if best[k] else (best[k + 1][0] if k + 1 < n and best[k + 1] else
                                            anchor_pt[k] or (st["lat"], st["lon"]))
        if best[k] is not None:
            if path and path[-1] != best[k][0]:
                path.append(best[k][0])
            path += best[k][1:-1]
        path.append(here)
        station_points.append(len(path) - 1)
    covered = sum(b is not None for b in best[1:])
    return {
        "shape": [[round(lat, 5), round(lon, 5)] for lat, lon in path],
        "stationPoints": station_points,
        "shapeCoverage": round(covered / max(1, n - 1), 2),
    }

def pattern_geometry(st_objs, shape_counter):
    """Tracé réel d'un pattern + position de chaque station sur ce tracé.

    Les tracés GTFS ne couvrent pas toujours tout (ex. ligne 4 vers Bagneux) :
    les tronçons non couverts sont reliés en ligne droite. On essaie les tracés
    les plus utilisés et on garde celui qui couvre le mieux le parcours."""
    best = None
    for sid, _ in shape_counter.most_common(4):
        raw = [(lat, lon) for _, lat, lon in shapes.get(sid, [])]
        if len(raw) < 2:
            continue
        built = build_path(raw, anchor(raw, st_objs), st_objs)
        if best is None or built[2] > best[2]:
            best = built
    if best is None:
        best = build_path([], [None] * len(st_objs), st_objs)
    path, station_points, covered = best
    return {
        "shape": [[round(lat, 5), round(lon, 5)] for lat, lon in path],
        "stationPoints": station_points,
        "shapeCoverage": round(covered / max(1, len(st_objs) - 1), 2),
    }

REF = {q["arrid"]: q for q in EXTRA + RAIL}

def flag(v):
    return {"true": True, "false": False}.get(str(v).lower())

def accessibility(own_quays):
    """Accessibilité d'une station pour une ligne, à partir de ses quais (GTFS
    wheelchair_boarding, référentiel IDFM) : "yes" si tous les quais le sont,
    "partial" si seulement certains, "no", ou None si inconnu."""
    def combine(values):
        values = [v for v in values if v is not None]
        if not values:
            return None
        return "yes" if all(values) else "partial" if any(values) else "no"
    wheel = []
    for q in own_quays:
        g = {"1": True, "2": False}.get(stops.get("IDFM:" + q, {}).get("wheelchair_boarding", ""))
        wheel.append(g if g is not None else flag(REF.get(q, {}).get("arraccessibility")))
    return {
        "wheelchair": combine(wheel),
        "audible": combine([flag(REF.get(q, {}).get("arraudiblesignals")) for q in own_quays]),
        "visual": combine([flag(REF.get(q, {}).get("arrvisualsigns")) for q in own_quays]),
    }

def rer_accessibility(own_full, zde):
    """Accessibilité d'une gare RER : GTFS (zone d'arrêt), sinon quais du référentiel."""
    def combine(values):
        values = [v for v in values if v is not None]
        if not values:
            return None
        return "yes" if all(values) else "partial" if any(values) else "no"
    gtfs_wheel = [{"1": True, "2": False}.get(stops.get(q, {}).get("wheelchair_boarding", "")) for q in own_full]
    ref = lambda key: [flag(REF.get(q, {}).get(key)) for q in zde]
    wheel = gtfs_wheel if any(v is not None for v in gtfs_wheel) else ref("arraccessibility")
    return {"wheelchair": combine(wheel), "audible": combine(ref("arraudiblesignals")), "visual": combine(ref("arrvisualsigns"))}

def build_rer(rid, r):
    """Une ligne de RER.

    Les missions RER ne desservent pas toutes les gares (directs, semi-directs),
    et le `direction_id` du GTFS n'est pas fiable. On en déduit :
      - les gares physiquement voisines : deux arrêts consécutifs d'une mission,
        sauf si une autre mission dessert une gare entre les deux ;
      - les `patterns` (tracé, plan de ligne, branches) : des parcours omnibus
        reconstitués, qui couvrent toutes les voies ;
      - les `services` : les missions réelles (arrêts desservis), pour la
        simulation et le placement des trains temps réel ;
      - les `segments` : temps médian entre deux arrêts consécutifs d'une
        mission, directs compris (utilisés par l'itinéraire)."""
    stations = {}
    patterns = Counter()
    pattern_shapes = defaultdict(Counter)
    seg_times = defaultdict(list)
    for tid, seq in trip_stops.items():
        t = trips[tid]
        if t["route_id"] != rid:
            continue
        seq.sort()
        st_seq = []
        for _, q, arr in seq:
            sid = station_of(q)
            if sid not in stations:
                parent = stops.get(sid, stops[q])
                stations[sid] = {"id": sid, "name": parent["stop_name"], "lat": float(parent["stop_lat"] or stops[q]["stop_lat"]),
                                 "lon": float(parent["stop_lon"] or stops[q]["stop_lon"]), "quays": set(),
                                 "own": set(), "own_full": set(), "zde": set()}
            tail = q.split(":")[-1]
            st = stations[sid]
            st["quays"].add(tail)
            st["quays"].update(RAIL_BY_ZDA.get(tail, ()))
            st["zde"].update(RAIL_BY_ZDA.get(tail, ()))
            st["own"].add(tail)
            st["own_full"].add(q)
            if not st_seq or st_seq[-1][0] != sid:
                st_seq.append((sid, arr))
        for (a, ta), (b, tb) in zip(st_seq, st_seq[1:]):
            if 0 < tb - ta < 3600:
                seg_times[(a, b)].append(tb - ta)
        key = tuple(s for s, _ in st_seq)
        if len(key) < 2 or len(set(key)) != len(key):
            continue  # boucles et allers-retours : ignorés
        patterns[key] += 1
        if t["shape_id"]:
            pattern_shapes[key][t["shape_id"]] += 1

    total = sum(patterns.values())
    cands = [(k, c) for k, c in patterns.items() if c >= max(5, total * 0.002)]
    def contained(small, big):
        n, m = len(small), len(big)
        return n < m and any(big[i:i + n] == small for i in range(m - n + 1))
    # une mission incluse dans une plus longue (ex. terminus partiel) n'apporte rien
    services = [(k, c) for k, c in cands if not any(contained(k, k2) for k2, _ in cands)]
    # les missions écartées comptent pour celles qui les contiennent
    weight = Counter({k: c for k, c in services})
    for k, c in cands:
        if k not in weight:
            big = max((k2 for k2, _ in services if contained(k, k2)), key=lambda k2: weight[k2])
            weight[big] += c
            pattern_shapes[big].update(pattern_shapes[k])

    # gares voisines : consécutives dans une mission, jamais séparées par un arrêt dans une autre
    adjacent, apart = set(), set()
    for k, _ in cands:
        for i in range(len(k) - 1):
            adjacent.add(frozenset(k[i:i + 2]))
            for j in range(i + 2, len(k)):
                apart.add(frozenset((k[i], k[j])))
    physical = adjacent - apart
    nbrs = defaultdict(set)
    for e in physical:
        a, b = tuple(e)
        nbrs[a].add(b)
        nbrs[b].add(a)
    pos = lambda sid: (stations[sid]["lat"], stations[sid]["lon"])

    def shortest(a, b):
        """Chemin physique le plus court (en mètres) entre deux gares."""
        import heapq
        dist, prev, heap = {a: 0.0}, {}, [(0.0, a)]
        while heap:
            d, u = heapq.heappop(heap)
            if u == b:
                path = [b]
                while path[-1] != a:
                    path.append(prev[path[-1]])
                return path[::-1]
            if d > dist[u]:
                continue
            for v in nbrs[u]:
                nd = d + dist_m(pos(u), pos(v))
                if nd < dist.get(v, float("inf")):
                    dist[v], prev[v] = nd, u
                    heapq.heappush(heap, (nd, v))
        return None

    def expand(seq):
        out = [seq[0]]
        for a, b in zip(seq, seq[1:]):
            if frozenset((a, b)) in physical:
                out.append(b)
                continue
            path = shortest(a, b)
            if path is None:  # aucune mission omnibus : on garde le saut tel quel
                physical.add(frozenset((a, b)))
                nbrs[a].add(b)
                nbrs[b].add(a)
                out.append(b)
            else:
                out += path[1:]
        return tuple(out)

    # parcours omnibus reconstitués, choisis pour couvrir toutes les voies
    expanded = {}
    for k, _ in services:
        e = expand(k)
        e = min(e, e[::-1])  # un parcours et son inverse : même tracé
        cur = expanded.setdefault(e, [0, Counter()])
        cur[0] += weight[k]
        cur[1].update(pattern_shapes[k])
    edges_of = lambda seq: {frozenset(seq[i:i + 2]) for i in range(len(seq) - 1)}
    todo, display = set(physical), []
    while todo:
        best = max(expanded.items(), key=lambda kv: (len(edges_of(kv[0]) & todo), kv[1][0]), default=None)
        if best is None or not edges_of(best[0]) & todo:
            break
        todo -= edges_of(best[0])
        display.append(best)
        del expanded[best[0]]
    # même orientation pour toutes les branches (ex. ouest -> est)
    oriented = []
    for seq, info in display:
        for prev_seq in oriented:
            common = [s for s in seq if s in prev_seq]
            if len(common) >= 2:
                if prev_seq.index(common[0]) > prev_seq.index(common[-1]):
                    seq = seq[::-1]
                break
        oriented.append(seq)
    display = [(seq, info) for seq, (_, info) in zip(oriented, display)]

    # gares desservies par les seules missions trop rares : écartées
    order = []
    for seq, _ in display:
        for x in seq:
            if x not in order:
                order.append(x)
    dropped = [stations[x]["name"] for x in stations if x not in order]
    if dropped:
        print(f"RER {r['route_short_name']}: gares écartées (missions rares) {dropped}", file=sys.stderr)
    for st in stations.values():
        st["access"] = rer_accessibility(st["own_full"], st["zde"])
    st_list = [dict({k: v for k, v in stations[x].items() if k not in ("own", "own_full", "zde")},
                    quays=sorted(stations[x]["quays"]), _own=sorted(stations[x]["own"]))
               for x in order]
    idx = {x["id"]: i for i, x in enumerate(st_list)}
    # tracés de la ligne, du plus utilisé au moins utilisé (ceux du parcours d'abord)
    line_shapes = Counter()
    for k, _ in services:
        line_shapes.update(pattern_shapes[k])

    def direction(seq):
        """0 si la mission va dans le sens des parcours affichés, 1 sinon."""
        for d, _ in display:
            common = [x for x in seq if x in d]
            if len(common) >= 2:
                return 0 if d.index(common[0]) < d.index(common[-1]) else 1
        return 0

    segs = [{"from": idx[a], "to": idx[b], "seconds": round(statistics.median(v))}
            for (a, b), v in seg_times.items() if len(v) >= 3 and a in idx and b in idx]
    out = {
        "id": rid.split(":")[-1],
        "name": r["route_short_name"],
        "mode": "rer",
        "color": "#" + r["route_color"],
        "textColor": "#" + r["route_text_color"],
        "stations": st_list,
        "patterns": [dict({"direction": 0, "headsign": stations[seq[-1]]["name"], "trips": info[0],
                           "stations": [idx[x] for x in seq]},
                          **merged_geometry([stations[x] for x in seq],
                                            [sid for sid, _ in info[1].most_common()] +
                                            [sid for sid, _ in line_shapes.most_common() if sid not in info[1]]))
                     for seq, info in display],
        "services": sorted(({"direction": direction(k), "headsign": stations[k[-1]]["name"], "trips": weight[k],
                             "stations": [idx[x] for x in k]} for k, _ in services if all(x in idx for x in k)),
                           key=lambda sv: -sv["trips"]),
        "segments": segs,
    }
    print(f"RER {r['route_short_name']}: {len(st_list)} gares, {len(display)} parcours, {len(services)} missions, "
          f"tracé {[p['shapeCoverage'] for p in out['patterns']]}", file=sys.stderr)
    return out

lines = []
for rid, r in sorted(routes.items(), key=lambda kv: sort_key(kv[1])):
    if r["mode"] == "rer":
        lines.append(build_rer(rid, r))
        continue
    stations = {}
    patterns = Counter()
    headsigns = {}
    pattern_shapes = defaultdict(Counter)
    seg_times = defaultdict(list)
    for tid, seq in trip_stops.items():
        t = trips[tid]
        if t["route_id"] != rid:
            continue
        seq.sort()
        st_seq = []
        for _, q, arr in seq:
            sid = station_of(q)
            if sid not in stations:
                parent = stops.get(sid, stops[q])
                stations[sid] = {"id": sid, "name": parent["stop_name"], "lat": float(parent["stop_lat"] or stops[q]["stop_lat"]),
                                 "lon": float(parent["stop_lon"] or stops[q]["stop_lon"]), "quays": set()}
            stations[sid]["quays"].add(q.split(":")[-1])
            stations[sid].setdefault("own", set()).add(q.split(":")[-1])
            st_seq.append((sid, arr))
        for (a, ta), (b, tb) in zip(st_seq, st_seq[1:]):
            if 0 < tb - ta < 900:
                seg_times[(a, b)].append(tb - ta)
        key = (t["direction_id"], tuple(s for s, _ in st_seq))
        patterns[key] += 1
        headsigns.setdefault(key, t["trip_headsign"])
        if t["shape_id"]:
            pattern_shapes[key][t["shape_id"]] += 1

    # on garde les patterns significatifs et non inclus dans un plus long
    total = sum(patterns.values())
    cands = [(k, c) for k, c in patterns.items() if c >= max(20, total * 0.01)]
    def contained(small, big):
        n, m = len(small), len(big)
        return n < m and any(big[i:i + n] == small for i in range(m - n + 1))
    kept = [(k, c) for k, c in cands if not any(k[0] == k2[0] and contained(k[1], k2[1]) for k2, _ in cands)]
    kept.sort(key=lambda kc: (kc[0][0], -kc[1]))

    # ordre d'affichage des stations : premier apparu dans les patterns du sens 0
    order = []
    for (d, seq), _ in kept:
        for s in seq:
            if s not in order:
                order.append(s)
    for s in stations:
        if s not in order:
            order.append(s)
    # quais supplémentaires du référentiel : même nom, à moins de 400 m. Dans les
    # correspondances, les quais des autres lignes sont aussi rattachés : sans
    # effet, le temps réel étant interrogé ligne par ligne.
    for q in EXTRA:
        g = q.get("arrgeopoint") or {}
        if "lat" not in g:
            continue
        for st in stations.values():
            if norm(st["name"]) == norm(q["arrname"]) and dist_m((st["lat"], st["lon"]), (g["lat"], g["lon"])) < 400:
                st["quays"].add(q["arrid"])
    for st in stations.values():
        st["access"] = accessibility(st["own"])
    st_list = [dict({k: v for k, v in stations[s].items() if k != "own"}, quays=sorted(stations[s]["quays"]),
                    _own=sorted(stations[s]["own"]))
               for s in order if s in stations]
    idx = {s["id"]: i for i, s in enumerate(st_list)}

    segs = [{"from": idx[a], "to": idx[b], "seconds": round(statistics.median(v))}
            for (a, b), v in seg_times.items() if len(v) >= 5 and a in idx and b in idx]
    lines.append({
        "id": rid.split(":")[-1],
        "name": r["route_short_name"],
        "mode": "metro",
        "color": "#" + r["route_color"],
        "textColor": "#" + r["route_text_color"],
        "stations": st_list,
        "patterns": [dict({"direction": int(d), "headsign": headsigns[(d, seq)], "trips": c,
                           "stations": [idx[s] for s in seq]},
                          **pattern_geometry([stations[s] for s in seq], pattern_shapes[(d, seq)]))
                     for (d, seq), c in kept],
        "segments": segs,
    })
    print(f"ligne {r['route_short_name']}: {len(st_list)} stations, {len(kept)} patterns", file=sys.stderr)

# --- Correspondances --------------------------------------------------------
transfer_time = {}
if (gtfs / "transfers.txt").exists():
    for t in rows("transfers.txt"):
        if t["min_transfer_time"]:
            a, b = t["from_stop_id"].split(":")[-1], t["to_stop_id"].split(":")[-1]
            transfer_time[(a, b)] = int(t["min_transfer_time"])

def walk_minutes(qa, qb):
    """Temps de correspondance minimal entre deux ensembles de quais (GTFS), en minutes."""
    ts = [transfer_time[(a, b)] for a in qa for b in qb if (a, b) in transfer_time]
    return round(min(ts) / 60) if ts else None

def same_place(a, b, max_m=400):
    return a["id"] == b["id"] or (norm(a["name"]) == norm(b["name"]) and dist_m((a["lat"], a["lon"]), (b["lat"], b["lon"])) < max_m)

def linked(L, a, M, b):
    """Correspondance entre deux stations : même lieu ; avec un RER, aussi les
    correspondances à pied de transfers.txt (ex. Châtelet / Châtelet - Les Halles,
    Gare du Nord / Magenta), jusqu'à 10 min et 500 m."""
    if same_place(a, b):
        return True
    if "rer" not in (L["mode"], M["mode"]) or dist_m((a["lat"], a["lon"]), (b["lat"], b["lon"])) > 500:
        return False
    m = walk_minutes(a["_own"], b["_own"])
    return m is not None and m <= 10

for L in lines:
    for st in L["stations"]:
        st["transfers"] = []
        for M in lines:
            if M is L:
                continue
            for j, other in enumerate(M["stations"]):
                if linked(L, st, M, other):
                    st["transfers"].append({"lineId": M["id"], "station": j, "minutes": walk_minutes(st["_own"], other["_own"])})
                    break

# RER, Transilien, tram, câble : arrêts proches portant un nom proche
# (les RER sont des lignes de l'application : correspondances ci-dessus)
OTHER_MODES = {"LocalTrain": "Train", "regionalRail": "Train", "Tramway": "Tram", "CableWay": "Câble"}

def fetch_all(url):
    out, offset = [], 0
    while True:
        with urllib.request.urlopen(f"{url}&limit=100&offset={offset}", timeout=60) as resp:
            page = json.load(resp)["results"]
        out += page
        if len(page) < 100:
            return out
        offset += 100

def words(name):
    stop = {"gare", "porte", "place", "pont", "rue", "avenue", "mairie", "de", "du", "des", "la", "le", "les"}
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return {w for w in "".join(c if c.isalnum() else " " for c in n).split() if len(w) > 2 and w not in stop}

try:
    base = "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets"
    where = " or ".join(f'mode="{m}"' for m in OTHER_MODES)
    other_stops = fetch_all(f"{base}/arrets-lignes/records?where={urllib.parse.quote(where)}"
                            "&select=id,shortname,mode,stop_id,stop_name,stop_lat,stop_lon")
    refs = fetch_all(f"{base}/referentiel-des-lignes/records?where={urllib.parse.quote('transportmode!=\"bus\"')}"
                     "&select=id_line,shortname_line,colourweb_hexa,textcolourweb_hexa")
    colors = {r["id_line"]: r for r in refs}
    print("arrêts RER/train/tram :", len(other_stops), file=sys.stderr)
except Exception as e:
    print("arrêts RER/train/tram indisponibles :", e, file=sys.stderr)
    other_stops = []

for L in lines:
    for st in L["stations"]:
        found = {}
        for o in other_stops:
            try:
                d = dist_m((st["lat"], st["lon"]), (float(o["stop_lat"]), float(o["stop_lon"])))
            except (TypeError, ValueError):
                continue
            if d > 400 or (d > 120 and not (words(st["name"]) & words(o["stop_name"]))):
                continue
            lid = (OTHER_MODES[o["mode"]], o["shortname"])  # plusieurs lignes « TER » : une seule entrée
            minutes = walk_minutes(st["_own"], [o["stop_id"].split(":")[-1]])
            prev = found.get(lid)
            if prev is None or (minutes is not None and (prev["minutes"] is None or minutes < prev["minutes"])):
                c = colors.get(o["id"].split(":")[-1], {})
                found[lid] = {"mode": OTHER_MODES[o["mode"]], "name": o["shortname"], "minutes": minutes,
                              "color": "#" + (c.get("colourweb_hexa") or "888888"),
                              "textColor": "#" + (c.get("textcolourweb_hexa") or "ffffff")}
        order = {"Train": 1, "Tram": 2, "Câble": 3}
        st["connections"] = sorted(found.values(), key=lambda c: (order[c["mode"]], c["name"]))
        del st["_own"]

out.write_text(json.dumps({"generatedFrom": "IDFM GTFS", "lines": lines}, ensure_ascii=False, separators=(",", ":")))
print("écrit", out, file=sys.stderr)
