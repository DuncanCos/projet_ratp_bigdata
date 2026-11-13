/**
 * Journée en accéléré : toutes les courses d'une journée type, d'après les horaires théoriques
 * du GTFS (`src/data/journee.json`, généré par `scripts/build_day_schedule.py`).
 * Ce ne sont pas les positions réelles : PRIM ne garde pas d'historique.
 */
import { LINES, Line, segmentPoints } from "./metro";

export type TypeJour = "semaine" | "samedi" | "dimanche";
export const NOM_TYPE: Record<TypeJour, string> = { semaine: "jour de semaine", samedi: "samedi", dimanche: "dimanche" };

interface GabaritBrut {
  sens: 0 | 1;
  arrets: number[];
  /** secondes depuis le départ, à l'arrivée à chaque arrêt */
  t: number[];
  /** secondes d'arrêt en gare */
  p?: number[];
}
interface Brut {
  gabarits: Record<string, GabaritBrut[]>;
  jours: Record<TypeJour, { date: string; courses: Record<string, number[]> }>;
}

/** Tracé entre deux arrêts, en Mercator normalisé (0..1), avec la longueur cumulée à chaque point. */
interface Voie {
  x: Float64Array;
  y: Float64Array;
  cum: Float64Array;
}

/** Courses qui ont les mêmes arrêts et les mêmes temps de parcours. */
export interface Gabarit {
  /** index de la ligne dans LINES */
  ligne: number;
  sens: 0 | 1;
  arrets: number[];
  /** arrivée et départ à chaque arrêt, en secondes depuis le départ de la course */
  arr: number[];
  dep: number[];
  /** voies[k] : tracé de l'arrêt k à l'arrêt k + 1 */
  voies: Voie[];
  duree: number;
}

export interface Journee {
  type: TypeJour;
  /** date du GTFS dont viennent les horaires */
  date: string;
  /** première et dernière seconde de service (depuis minuit, au-delà de 24 h après minuit) */
  debut: number;
  fin: number;
  /** courses triées par heure de départ */
  departs: Int32Array;
  gabarits: Gabarit[];
  dureeMax: number;
  /** trains en circulation, minute par minute depuis `debut` */
  charge: Uint16Array;
}

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

const voies = new Map<string, Voie>();
function voie(line: Line, a: number, b: number): Voie {
  const k = `${line.id}:${a}-${b}`;
  let v = voies.get(k);
  if (!v) {
    const pts = segmentPoints(line, a, b);
    const x = Float64Array.from(pts, (p) => mercX(p[1]));
    const y = Float64Array.from(pts, (p) => mercY(p[0]));
    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    v = { x, y, cum };
    voies.set(k, v);
  }
  return v;
}

/** Arrêt en gare quand le GTFS n'en donne pas : 20 s, moins sur les interstations très courtes. */
const pause = (trajet: number) => Math.min(20, trajet * 0.3);

let brut: Promise<Brut> | null = null;
const gabaritsPrets = new Map<string, Gabarit[]>();

function gabaritsDe(data: Brut, line: Line, ligne: number): Gabarit[] {
  let gs = gabaritsPrets.get(line.id);
  if (!gs) {
    gs = (data.gabarits[line.id] ?? []).map((g) => {
      const n = g.arrets.length;
      const dep = g.t.map((t, k) => (k === n - 1 ? t : Math.min(g.t[k + 1], t + (g.p?.[k] || pause(g.t[k + 1] - t)))));
      dep[0] = 0;
      return {
        ligne,
        sens: g.sens,
        arrets: g.arrets,
        arr: g.t,
        dep,
        voies: g.arrets.slice(1).map((b, k) => voie(line, g.arrets[k], b)),
        duree: g.t[n - 1],
      };
    });
    gabaritsPrets.set(line.id, gs);
  }
  return gs;
}

/** Charge (une fois) les horaires et prépare la journée demandée. */
export async function chargerJournee(type: TypeJour): Promise<Journee> {
  brut ??= import("../data/journee.json").then((m) => m.default as unknown as Brut);
  const data = await brut;
  const jour = data.jours[type];
  const toutes: { depart: number; g: Gabarit }[] = [];
  LINES.forEach((line, ligne) => {
    const gs = gabaritsDe(data, line, ligne);
    const c = jour.courses[line.id] ?? [];
    for (let i = 0; i < c.length; i += 2) toutes.push({ depart: c[i], g: gs[c[i + 1]] });
  });
  toutes.sort((a, b) => a.depart - b.depart);
  const debut = toutes.length ? toutes[0].depart : 0;
  const fin = toutes.reduce((m, c) => Math.max(m, c.depart + c.g.duree), debut);
  // trains en circulation par minute : +1 au départ, -1 à l'arrivée, puis somme cumulée
  const minutes = Math.ceil((fin - debut) / 60) + 1;
  const delta = new Int32Array(minutes + 1);
  for (const c of toutes) {
    delta[Math.floor((c.depart - debut) / 60)]++;
    delta[Math.floor((c.depart + c.g.duree - debut) / 60) + 1]--;
  }
  const charge = new Uint16Array(minutes);
  for (let i = 0, n = 0; i < minutes; i++) charge[i] = n += delta[i];
  return {
    type,
    date: jour.date,
    debut,
    fin,
    departs: Int32Array.from(toutes, (c) => c.depart),
    gabarits: toutes.map((c) => c.g),
    dureeMax: toutes.reduce((m, c) => Math.max(m, c.g.duree), 0),
    charge,
  };
}

/** Première course partie après `t`. */
export function premiereApres(j: Journee, t: number) {
  let lo = 0;
  let hi = j.departs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (j.departs[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Pose {
  /** position en Mercator normalisé */
  x: number;
  y: number;
  /** direction du tronçon parcouru (non normée) */
  dx: number;
  dy: number;
  /** index, dans le gabarit, du dernier arrêt atteint */
  k: number;
  aQuai: boolean;
}

/** Place une course `rel` secondes après son départ (0 <= rel <= durée). */
export function placer(g: Gabarit, rel: number, o: Pose) {
  const dernier = g.arr.length - 2;
  let k = 0;
  while (k < dernier && rel >= g.arr[k + 1]) k++;
  const v = g.voies[k];
  const trajet = g.arr[k + 1] - g.dep[k];
  const f = rel <= g.dep[k] ? 0 : trajet > 0 ? Math.min(1, (rel - g.dep[k]) / trajet) : 1;
  const n = v.cum.length;
  const cible = f * v.cum[n - 1];
  let i = 0;
  while (i < n - 2 && v.cum[i + 1] < cible) i++;
  const long = n > 1 ? v.cum[i + 1] - v.cum[i] : 0;
  const u = long > 0 ? (cible - v.cum[i]) / long : 0;
  const j = Math.min(i + 1, n - 1);
  o.dx = v.x[j] - v.x[i];
  o.dy = v.y[j] - v.y[i];
  o.x = v.x[i] + o.dx * u;
  o.y = v.y[i] + o.dy * u;
  o.k = f >= 1 ? k + 1 : k;
  o.aQuai = f === 0 || f >= 1;
}

/** Jour type d'une date « AAAA-MM-JJ » (les jours fériés ne sont pas distingués). */
export function typeDuJour(iso: string): TypeJour {
  const d = new Date(`${iso}T12:00:00`).getDay();
  return d === 0 ? "dimanche" : d === 6 ? "samedi" : "semaine";
}

/** 29 520 -> « 08:12 » ; au-delà de 24 h, l'heure du lendemain. */
export const heure = (s: number) => {
  const m = Math.floor(s / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
