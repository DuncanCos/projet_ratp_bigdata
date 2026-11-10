import { LINES, Line, geometry, isRer, lineById, lineTitle, missions } from "./metro";

/**
 * Calcul d'itinéraire sur le réseau métro + RER, entièrement côté front, à partir de
 * la topologie GTFS embarquée (`metro.json`) :
 *  - nœud = (ligne, station) ;
 *  - arc « trajet » = segment GTFS entre deux stations consécutives (orienté :
 *    les boucles des lignes 7bis et 10 sont à sens unique) ;
 *    Pour le RER, les segments relient deux arrêts consécutifs d'une mission :
 *    les directs (gares sautées) sont donc plus rapides ;
 *  - arc « correspondance » = temps de correspondance IDFM + attente moyenne.
 * Un lieu (« Châtelet ») regroupe toutes les lignes qui y passent : les
 * correspondances relient toujours des stations de même nom.
 */

/** Attente moyenne sur le quai à chaque montée (hors première), en secondes. */
const WAIT_S = 120;
/** Temps de correspondance quand IDFM n'en donne pas. */
const DEFAULT_WALK_S = 180;

export interface Place {
  /** clé stable : le nom de la station */
  name: string;
  /** lignes qui desservent ce lieu, avec l'index de la station dans chaque ligne */
  stops: { lineId: string; index: number }[];
}

/** Tous les lieux du réseau, triés par nom. */
export const PLACES: Place[] = (() => {
  const byName = new Map<string, Place>();
  for (const l of LINES)
    l.stations.forEach((s, index) => {
      const p = byName.get(s.name) ?? { name: s.name, stops: [] };
      p.stops.push({ lineId: l.id, index });
      byName.set(s.name, p);
    });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
})();

export const placeByName = (name: string) => PLACES.find((p) => p.name === name) ?? null;

/** Minuscules sans accents ni ponctuation, pour la recherche. */
export const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Recherche d'un lieu : tous les mots tapés doivent apparaître, les débuts de nom d'abord. */
export function searchPlaces(query: string, limit = 8): Place[] {
  const q = normalize(query);
  if (!q) return [];
  const words = q.split(" ");
  return PLACES.map((p) => ({ p, n: normalize(p.name) }))
    .filter(({ n }) => words.every((w) => n.includes(w)))
    .sort((a, b) => Number(!a.n.startsWith(q)) - Number(!b.n.startsWith(q)) || a.n.length - b.n.length)
    .slice(0, limit)
    .map(({ p }) => p);
}

export interface Leg {
  lineId: string;
  /** stations parcourues (index dans la ligne), départ et arrivée compris */
  stations: number[];
  seconds: number;
  /** terminus possibles des trains à prendre (« vers … ») */
  headsigns: string[];
}

export interface Journey {
  from: string;
  to: string;
  legs: Leg[];
  /** correspondances entre deux tronçons, en secondes (marche + attente) */
  transfers: number[];
  /** durée totale estimée, sans l'attente du premier train */
  seconds: number;
  /** marche au départ vers une gare d'un autre nom (ex. Châtelet -> Châtelet - Les Halles) */
  walkStart?: { seconds: number; to: string };
  /** marche à l'arrivée depuis une gare d'un autre nom */
  walkEnd?: { seconds: number; from: string };
}

export interface RouteOptions {
  /** stations à éviter par ligne (trafic interrompu) */
  avoid?: Record<string, Set<number>>;
  /** pénalité ajoutée à chaque correspondance, pour préférer les trajets directs */
  transferPenaltyS?: number;
  /** lignes à ne pas emprunter (pour chercher des variantes) */
  banLines?: Set<string>;
  /** lieux où l'on s'interdit de changer de ligne */
  banTransfers?: Set<string>;
}

/** Nœud du graphe : « idLigne:indexStation » */
export type NodeKey = string;
export const key = (lineId: string, i: number): NodeKey => `${lineId}:${i}`;
const parse = (k: NodeKey) => {
  const [lineId, i] = k.split(":");
  return { lineId, index: Number(i) };
};

interface Edge {
  to: NodeKey;
  s: number;
  ride: boolean;
}

let graphCache: Map<NodeKey, Edge[]> | null = null;

function graph(): Map<NodeKey, Edge[]> {
  if (graphCache) return graphCache;
  const g = new Map<NodeKey, Edge[]>();
  const add = (a: NodeKey, e: Edge) => {
    const list = g.get(a) ?? [];
    list.push(e);
    g.set(a, list);
  };
  for (const l of LINES) {
    for (const seg of l.segments) add(key(l.id, seg.from), { to: key(l.id, seg.to), s: seg.seconds, ride: true });
    l.stations.forEach((s, i) => {
      for (const t of s.transfers)
        add(key(l.id, i), {
          to: key(t.lineId, t.station),
          s: (t.minutes != null ? t.minutes * 60 : DEFAULT_WALK_S) + WAIT_S,
          ride: false,
        });
    });
  }
  graphCache = g;
  return g;
}

/** Petit tas binaire pour Dijkstra. */
class Heap {
  private a: [number, NodeKey][] = [];
  get size() {
    return this.a.length;
  }
  push(item: [number, NodeKey]) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, NodeKey] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Terminus des trains qui vont de `a` à `b` sur la ligne (branches et missions RER comprises). */
function headsignsFor(line: Line, a: number, b: number): string[] {
  const names = missions(line)
    .filter((p) => {
      const i = p.stations.indexOf(a);
      const j = p.stations.indexOf(b);
      return i >= 0 && j > i;
    })
    .map((p) => line.stations[p.stations[p.stations.length - 1]].name);
  return [...new Set(names)];
}

/** Une mission dessert-elle `a` puis `b` ? (un même train va de l'un à l'autre) */
const sameTrain = (line: Line, a: number, b: number) =>
  missions(line).some((p) => {
    const i = p.stations.indexOf(a);
    return i >= 0 && p.stations.indexOf(b) > i;
  });

/**
 * RER : un tronçon qu'aucune mission ne parcourt d'un bout à l'autre (passage
 * d'une branche à l'autre, direct puis omnibus) est coupé là où il faut changer
 * de train, sur le même quai ou presque.
 */
function splitByMission(leg: Leg): Leg[] {
  const line = lineById(leg.lineId);
  if (!isRer(line)) return [leg];
  const seg = (a: number, b: number) => rideSeconds(line, a, b);
  const make = (i: number, j: number): Leg => {
    const stations = leg.stations.slice(i, j + 1);
    return { ...leg, stations, seconds: stations.slice(1).reduce((t, s, k) => t + seg(stations[k], s), 0) };
  };
  const out: Leg[] = [];
  let start = 0;
  for (let k = 1; k < leg.stations.length; k++) {
    // aucun train ne va de `start` à k : on change en k - 1
    if (k - 1 > start && !sameTrain(line, leg.stations[start], leg.stations[k])) {
      out.push(make(start, k - 1));
      start = k - 1;
    }
  }
  out.push(make(start, leg.stations.length - 1));
  return out;
}

/** Itinéraire le plus rapide entre deux lieux, ou null si aucun (stations évitées). */
export function findRoute(fromName: string, toName: string, opts: RouteOptions = {}): Journey | null {
  const from = placeByName(fromName);
  const to = placeByName(toName);
  if (!from || !to || from.name === to.name) return null;
  const g = graph();
  const penalty = opts.transferPenaltyS ?? 60;
  const blocked = (k: NodeKey) => {
    const [lineId, i] = k.split(":");
    return opts.avoid?.[lineId]?.has(Number(i)) ?? false;
  };
  const targets = new Set(to.stops.map((s) => key(s.lineId, s.index)));
  const nameOf = (k: NodeKey) => {
    const [l, i] = k.split(":");
    return lineById(l).stations[Number(i)].name;
  };

  const dist = new Map<NodeKey, number>();
  const prev = new Map<NodeKey, NodeKey>();
  const heap = new Heap();
  for (const s of from.stops) {
    const k = key(s.lineId, s.index);
    dist.set(k, 0);
    heap.push([0, k]);
  }

  let reached: NodeKey | null = null;
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (targets.has(u)) {
      reached = u;
      break;
    }
    for (const e of g.get(u) ?? []) {
      // station fermée : ni traversée ni correspondance, sauf si c'est la destination
      if (blocked(e.to) && !targets.has(e.to)) continue;
      if (e.ride && opts.banLines?.has(e.to.split(":")[0])) continue;
      if (!e.ride && opts.banTransfers?.size) {
        const [l, i] = u.split(":");
        if (opts.banTransfers.has(lineById(l).stations[Number(i)].name)) continue;
      }
      // inutile de changer de ligne dans le lieu de départ ou d'arrivée, sauf pour
      // rejoindre à pied une gare d'un autre nom (Châtelet -> Châtelet - Les Halles)
      const atStart = !e.ride && from.stops.some((s) => key(s.lineId, s.index) === u);
      if (!e.ride && (atStart || targets.has(u)) && nameOf(e.to) === nameOf(u)) continue;
      // marche au départ ou à l'arrivée : ni attente ni pénalité de correspondance
      const walkOnly = atStart || targets.has(e.to);
      const nd = d + (e.ride ? e.s : walkOnly ? Math.max(60, e.s - WAIT_S) : e.s + penalty);
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, u);
        heap.push([nd, e.to]);
      }
    }
  }
  if (!reached) return null;

  // reconstitution du chemin, puis découpage en tronçons par ligne
  const path: NodeKey[] = [reached];
  while (prev.has(path[0])) path.unshift(prev.get(path[0])!);
  return journeyFromPath(from.name, to.name, path);
}

/** Temps de trajet entre deux arrêts voisins d'une ligne (segment GTFS, dans un sens ou l'autre). */
const rideSeconds = (line: Line, a: number, b: number) =>
  line.segments.find((s) => s.from === a && s.to === b)?.seconds ??
  line.segments.find((s) => s.from === b && s.to === a)?.seconds ??
  120;

/**
 * Trajet à partir d'une suite de nœuds : deux nœuds consécutifs de la même
 * ligne = trajet en train, de lignes différentes = correspondance.
 */
export function journeyFromPath(fromName: string, toName: string, path: NodeKey[]): Journey | null {

  const legs: (Leg & { walkBefore: number })[] = [];
  let cur: (Leg & { walkBefore: number }) | null = null;
  for (let k = 0; k < path.length; k++) {
    const [lineId, si] = path[k].split(":");
    const i = Number(si);
    if (cur && cur.lineId === lineId) {
      const last = cur.stations[cur.stations.length - 1];
      cur.seconds += rideSeconds(lineById(lineId), last, i);
      cur.stations.push(i);
    } else {
      let walk = 0;
      if (cur) {
        const last = cur.stations[cur.stations.length - 1];
        const t = lineById(cur.lineId).stations[last].transfers.find((t) => t.lineId === lineId && t.station === i);
        walk = (t?.minutes != null ? t.minutes * 60 : DEFAULT_WALK_S) + WAIT_S;
      }
      cur = { lineId, stations: [i], seconds: 0, headsigns: [], walkBefore: walk };
      legs.push(cur);
    }
  }
  // un tronçon d'une seule station = correspondance enchaînée : sa marche est reportée
  const rides: Leg[] = [];
  const transfers: number[] = [];
  let carry = 0;
  let walkStart: Journey["walkStart"];
  const legName = (l: Leg, end: boolean) => lineById(l.lineId).stations[l.stations[end ? l.stations.length - 1 : 0]].name;
  for (const l of legs) {
    carry += l.walkBefore;
    if (l.stations.length < 2) continue;
    const { walkBefore: _, ...whole } = l;
    for (const leg of splitByMission(whole)) {
      if (rides.length) transfers.push(carry || WAIT_S); // même ligne : attente du train suivant
      else if (carry) walkStart = { seconds: Math.max(60, carry - WAIT_S), to: legName(leg, false) };
      carry = 0;
      leg.headsigns = headsignsFor(lineById(leg.lineId), leg.stations[0], leg.stations[leg.stations.length - 1]);
      rides.push(leg);
    }
  }
  if (!rides.length) return null;
  const walkEnd = carry ? { seconds: Math.max(60, carry - WAIT_S), from: legName(rides[rides.length - 1], true) } : undefined;
  const seconds =
    rides.reduce((a, l) => a + l.seconds, 0) +
    transfers.reduce((a, t) => a + t, 0) +
    (walkStart?.seconds ?? 0) +
    (walkEnd?.seconds ?? 0);
  return { from: fromName, to: toName, legs: rides, transfers, seconds, walkStart, walkEnd };
}

/** Pourquoi une variante est proposée. */
export type JourneyTag = "fastest" | "fewerTransfers" | "alternative";
export interface Option {
  journey: Journey;
  tag: JourneyTag;
}

/** Signature d'un trajet : lignes empruntées et stations de correspondance. */
const signature = (j: Journey) =>
  j.legs.map((l) => `${l.lineId}:${l.stations[0]}>${l.stations[l.stations.length - 1]}`).join("|");

/**
 * Plusieurs trajets possibles, du plus rapide au plus lent :
 *  - le plus rapide ;
 *  - celui qui minimise les correspondances (forte pénalité par changement) ;
 *  - des variantes qui changent ailleurs, ou sans les lignes du trajet le plus rapide.
 * On écarte les doublons et les détours trop longs (plus de 50 % et 10 min de plus).
 */
export function findRoutes(fromName: string, toName: string, opts: RouteOptions = {}, max = 4): Option[] {
  const best = findRoute(fromName, toName, opts);
  if (!best) return [];
  const candidates: Option[] = [{ journey: best, tag: "fastest" }];
  const direct = findRoute(fromName, toName, { ...opts, transferPenaltyS: 900 });
  if (direct) candidates.push({ journey: direct, tag: "fewerTransfers" });
  const lines = [...new Set(best.legs.map((l) => l.lineId))];
  const bans: string[][] = lines.map((l) => [l]);
  for (let i = 0; i < lines.length; i++) for (let k = i + 1; k < lines.length; k++) bans.push([lines[i], lines[k]]);
  // changer ailleurs : chaque station de correspondance interdite tour à tour
  for (const leg of best.legs.slice(1)) {
    const at = lineById(leg.lineId).stations[leg.stations[0]].name;
    const j = findRoute(fromName, toName, { ...opts, banTransfers: new Set([...(opts.banTransfers ?? []), at]) });
    if (j) candidates.push({ journey: j, tag: "alternative" });
  }
  for (const ban of bans) {
    const j = findRoute(fromName, toName, { ...opts, banLines: new Set([...(opts.banLines ?? []), ...ban]) });
    if (j) candidates.push({ journey: j, tag: "alternative" });
  }

  const limit = Math.max(best.seconds * 1.5, best.seconds + 600);
  const seen = new Set<string>();
  const out: Option[] = [];
  for (const c of candidates) {
    const sig = signature(c.journey);
    if (seen.has(sig) || c.journey.seconds > limit) continue;
    // « moins de correspondances » n'a de sens que s'il en a vraiment moins
    if (c.tag === "fewerTransfers" && c.journey.legs.length >= best.legs.length) continue;
    seen.add(sig);
    out.push(c);
  }
  out.sort((a, b) => a.journey.seconds - b.journey.seconds);
  // « le plus rapide » : celui qui l'est vraiment une fois les durées calculées
  const first = out[0];
  if (first && first.tag !== "fastest") {
    out.forEach((o) => o.tag === "fastest" && (o.tag = "alternative"));
    first.tag = "fastest";
  }
  return out.slice(0, max);
}

export const formatDuration = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};

// --- Trajet tracé à la main -------------------------------------------------

/** Stations parcourues sur une ligne de `a` à `b`, en suivant les voies (gares voisines). */
export function linePath(line: Line, a: number, b: number): number[] | null {
  const nb = geometry(line).neighbours;
  const prev = new Map<number, number>([[a, a]]);
  const queue = [a];
  while (queue.length && !prev.has(b)) {
    const u = queue.shift()!;
    for (const v of nb.get(u) ?? [])
      if (!prev.has(v)) {
        prev.set(v, u);
        queue.push(v);
      }
  }
  if (!prev.has(b)) return null;
  const out = [b];
  while (out[0] !== a) out.unshift(prev.get(out[0])!);
  return out;
}

const stationOf = (k: NodeKey) => {
  const { lineId, index } = parse(k);
  return lineById(lineId).stations[index];
};

/** Arrêt de la ligne `lineId` où l'on peut changer depuis le nœud `k` (même station ou correspondance). */
function changeTo(k: NodeKey, lineId: string): number | null {
  const st = stationOf(k);
  const t = st.transfers.find((t) => t.lineId === lineId);
  if (t) return t.station;
  const same = lineById(lineId).stations.findIndex((s) => s.name === st.name);
  return same >= 0 ? same : null;
}

export interface DrawResult {
  path: NodeKey[];
  error?: string;
}

/**
 * Prolonge un trajet tracé à la main jusqu'à la station touchée :
 *  - sur la ligne en cours : on suit la ligne jusqu'à elle ;
 *  - sur une autre ligne qui croise la station où l'on est : correspondance
 *    à cette intersection, puis trajet sur la nouvelle ligne ;
 *  - une station déjà parcourue : retour en arrière (le trajet est coupé là).
 * Au départ, toutes les lignes du lieu de départ sont possibles.
 */
export function extendPath(path: NodeKey[], fromName: string, lineId: string, index: number): DrawResult {
  const target = key(lineId, index);
  const at = path.indexOf(target);
  if (at >= 0) return { path: path.slice(0, at + 1) };
  const line = lineById(lineId);
  const from = placeByName(fromName);
  const ends: NodeKey[] = path.length ? [path[path.length - 1]] : (from?.stops.map((s) => key(s.lineId, s.index)) ?? []);
  if (!ends.length) return { path, error: "Choisissez d'abord une station de départ." };
  const base = path.length ? path : [];
  const ride = (start: NodeKey, i: number) => {
    const seq = linePath(line, i, index);
    return seq && [...base, ...(path.length ? [] : [start]), ...seq.map((s) => key(lineId, s))].filter(
      (k, n, arr) => n === 0 || arr[n - 1] !== k,
    );
  };
  // 1. même ligne
  for (const e of ends) {
    const { lineId: l, index: i } = parse(e);
    if (l === lineId) {
      const r = ride(e, i);
      if (r) return { path: r };
    }
  }
  // 2. correspondance à l'endroit où l'on est, puis trajet sur la nouvelle ligne
  for (const e of ends) {
    const j = changeTo(e, lineId);
    if (j === null) continue;
    const seq = linePath(line, j, index);
    if (seq) return { path: [...base, ...(path.length ? [] : [e]), ...seq.map((s) => key(lineId, s))] };
  }
  const here = stationOf(ends[0]).name;
  return {
    path,
    error: `Le ${lineTitle(line)} ne passe pas à ${here}. Allez d'abord jusqu'à une station où il s'arrête.`,
  };
}

/** Termine un trajet tracé : le plus rapide de la dernière station jusqu'à l'arrivée. */
export function completePath(path: NodeKey[], fromName: string, toName: string): DrawResult {
  const startName = path.length ? stationOf(path[path.length - 1]).name : fromName;
  if (startName === toName) return { path };
  const j = findRoute(startName, toName);
  if (!j) return { path, error: `Aucun trajet trouvé de ${startName} à ${toName}.` };
  let next = [...path];
  if (!next.length) {
    const from = placeByName(fromName)!;
    const first = j.legs[0];
    const s = from.stops.find((s) => s.lineId === first.lineId) ?? from.stops[0];
    next.push(key(s.lineId, s.index));
  }
  for (const leg of j.legs) for (const i of leg.stations) next.push(key(leg.lineId, i));
  next = next.filter((k, n) => n === 0 || next[n - 1] !== k);
  return { path: next };
}

/** Le trajet tracé arrive-t-il au lieu d'arrivée ? */
export const pathReaches = (path: NodeKey[], toName: string) =>
  path.length > 0 && stationOf(path[path.length - 1]).name === toName;

/** Dernière station du trajet tracé (pour la mettre en évidence sur la carte). */
export const pathEnd = (path: NodeKey[]) => (path.length ? parse(path[path.length - 1]) : null);
