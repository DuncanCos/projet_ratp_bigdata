import raw from "../data/metro.json";

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  quays: string[];
  access: {
    wheelchair: Access;
    audible: Access;
    visual: Access;
  };
  /** autres lignes (métro, RER) dans la même station ou reliées à pied */
  transfers: { lineId: string; station: number; minutes: number | null }[];
  /** Transilien, tram, câble à proximité */
  connections: { mode: string; name: string; minutes: number | null; color: string; textColor: string }[];
}

export type Access = "yes" | "partial" | "no" | null;
export interface Pattern {
  direction: number;
  headsign: string;
  trips: number;
  stations: number[];
  /** tracé réel (GTFS shapes), lignes droites là où il manque */
  shape: [number, number][];
  /** pour chaque station du pattern, son index dans `shape` */
  stationPoints: number[];
  shapeCoverage: number;
}
/** Mission RER : gares réellement desservies (sans tracé). */
export interface Service {
  direction: number;
  headsign: string;
  trips: number;
  stations: number[];
}
export type Mode = "metro" | "rer";
export interface Line {
  id: string;
  name: string;
  mode: Mode;
  color: string;
  textColor: string;
  stations: Station[];
  /** parcours (toutes les gares dans l'ordre des voies) : tracé, branches */
  patterns: Pattern[];
  /** RER : missions (omnibus, semi-directs, directs) */
  services?: Service[];
  /** temps entre deux arrêts consécutifs d'une mission (directs compris) */
  segments: { from: number; to: number; seconds: number }[];
}

export const LINES: Line[] = (raw as unknown as { lines: Line[] }).lines;
export const lineById = (id: string) => LINES.find((l) => l.id === id)!;
export const isRer = (l: Line) => l.mode === "rer";

/** Missions de la ligne : les services RER, sinon les parcours (métro). */
export const missions = (l: Line): { stations: number[]; headsign: string; direction: number }[] =>
  l.services?.length ? l.services : l.patterns;

/** Patterns d'un seul sens (le sens 0), un par branche. */
export const branches = (line: Line) => {
  const d0 = line.patterns.filter((p) => p.direction === 0);
  return d0.length ? d0 : line.patterns.slice(0, 1);
};

/** Libellé court : "3B" -> "3bis" (le RER B reste « B ») */
export const label = (l: Line) => (isRer(l) ? l.name : l.name.replace("B", "bis"));

/** « Métro 3bis », « RER A » */
export const lineTitle = (l: Line) => `${isRer(l) ? "RER" : "Métro"} ${label(l)}`;

/** Nom d'une branche : le terminus qui la distingue des autres branches. */
export const branchName = (line: Line, p: Pattern, all: Pattern[]) => {
  // RER : parcours d'un terminus à l'autre, nommés par leurs deux bouts
  if (isRer(line)) return `${line.stations[p.stations[0]].name} – ${line.stations[p.stations[p.stations.length - 1]].name}`;
  const first = p.stations[0];
  const last = p.stations[p.stations.length - 1];
  const others = all.filter((o) => o !== p);
  const sharedLast = others.some((o) => o.stations[o.stations.length - 1] === last);
  return line.stations[sharedLast ? first : last].name;
};

type LatLng = [number, number];

const distM = (a: LatLng, b: LatLng) =>
  Math.hypot((a[1] - b[1]) * 73000, (a[0] - b[0]) * 111000);

interface LineGeometry {
  /** position de chaque station sur la voie */
  stationPos: LatLng[];
  /** "from-to" -> points du tracé entre deux stations consécutives */
  segments: Map<string, LatLng[]>;
  /** stations voisines sur les voies */
  neighbours: Map<number, Set<number>>;
}

const geometryCache = new Map<string, LineGeometry>();

/** Géométrie d'une ligne, calculée une fois : positions sur la voie et tronçons. */
export function geometry(line: Line): LineGeometry {
  const cached = geometryCache.get(line.id);
  if (cached) return cached;
  const stationPos: LatLng[] = line.stations.map((s) => [s.lat, s.lon]);
  const placed = new Set<number>();
  const segments = new Map<string, LatLng[]>();
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const p of line.patterns) {
    p.stations.forEach((s, k) => {
      if (!placed.has(s)) {
        stationPos[s] = p.shape[p.stationPoints[k]];
        placed.add(s);
      }
      if (k === 0) return;
      const pts = p.shape.slice(p.stationPoints[k - 1], p.stationPoints[k] + 1);
      const a = p.stations[k - 1];
      link(a, s);
      link(s, a);
      if (!segments.has(`${a}-${s}`)) segments.set(`${a}-${s}`, pts);
      if (!segments.has(`${s}-${a}`)) segments.set(`${s}-${a}`, [...pts].reverse());
    });
  }
  const g = { stationPos, segments, neighbours };
  geometryCache.set(line.id, g);
  return g;
}

/**
 * Tracé entre deux arrêts d'une même ligne. Ils sont en général voisins ; pour
 * un RER direct (gares sautées), on suit les voies par le plus court chemin.
 */
export function segmentPoints(line: Line, a: number, b: number): LatLng[] {
  const g = geometry(line);
  const k = `${a}-${b}`;
  const known = g.segments.get(k);
  if (known) return known;
  // parcours en largeur sur les gares voisines
  const prev = new Map<number, number>([[a, a]]);
  const queue = [a];
  while (queue.length && !prev.has(b)) {
    const u = queue.shift()!;
    for (const v of g.neighbours.get(u) ?? [])
      if (!prev.has(v)) {
        prev.set(v, u);
        queue.push(v);
      }
  }
  let pts: LatLng[];
  if (!prev.has(b)) pts = [g.stationPos[a], g.stationPos[b]];
  else {
    const path = [b];
    while (path[0] !== a) path.unshift(prev.get(path[0])!);
    pts = path.flatMap((s, i) => (i === 0 ? [g.stationPos[s]] : (g.segments.get(`${path[i - 1]}-${s}`) ?? [g.stationPos[s]]).slice(1)));
  }
  g.segments.set(k, pts);
  return pts;
}

/** Point situé à la fraction `t` (0..1) de la longueur d'une polyligne. */
export function along(pts: LatLng[], t: number): LatLng {
  if (pts.length === 1 || t <= 0) return pts[0];
  const lens = pts.slice(1).map((p, i) => distM(pts[i], p));
  let target = lens.reduce((a, b) => a + b, 0) * Math.min(1, t);
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i] || i === lens.length - 1) {
      const f = lens[i] ? Math.min(1, target / lens[i]) : 0;
      const [a, b] = [pts[i], pts[i + 1]];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    target -= lens[i];
  }
  return pts[pts.length - 1];
}
