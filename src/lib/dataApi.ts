/** Client de l'API « données » (FastAPI sur Cassandra, alimentée par Airflow). */
export const DATA_API: string = import.meta.env.VITE_DATA_API ?? "http://localhost:8000";
export const AIRFLOW_URL: string = import.meta.env.VITE_AIRFLOW_URL ?? "http://localhost:8080";

export interface LigneRef { id: string; nom: string; mode: string; couleur: string; couleur_texte: string }
export interface Meta {
  jour_min: string | null;
  jour_max: string | null;
  categories: string[];
  lignes: LigneRef[];
  nb_stations: number;
  modele: string | null;
}
export interface StationRef { id_zdc: number; nom: string; lat: number | null; lon: number | null; lignes: string[]; moyenne_jour: number }
export interface Jour {
  jour: string;
  total: number;
  tmax: number | null;
  tmin: number | null;
  pluie_mm: number | null;
  ferie: string | null;
  vacances: string | null;
}
export interface Classe { id_zdc: number; nom: string; lignes: string[]; total: number; moyenne: number }
export interface Profil { cat_jour: string; heure: number; pourcentage: number; periode: string }
export interface Prevision {
  jour: string;
  reel: number | null;
  prevu: number | null;
  tmax?: number | null;
  pluie_mm?: number | null;
  ferie?: string | null;
  vacances?: string | null;
}
export interface Modele {
  modele: string;
  entraine_le: string;
  train_debut: string; train_fin: string; test_debut: string; test_fin: string;
  n_train: number; n_test: number;
  mae: number; wape: number; r2: number; mae_reference: number; wape_reference: number;
  importances: { variable: string; importance: number }[];
  figures: string[];
}
export interface Chargement {
  source: string; periode: string; charge_le: string;
  lignes_brutes: number | null; lignes_rejetees: number | null; lignes_chargees: number;
  jour_min: string; jour_max: string;
}

export type Params = Record<string, string | number | null | undefined>;

export const url = (path: string, params: Params = {}) => {
  const q = Object.entries(params)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${DATA_API}${path}${q ? `?${q}` : ""}`;
};

export async function get<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url(path, params), { signal });
  if (!r.ok) {
    const detail = await r.json().then((j) => j.detail as string).catch(() => null);
    throw new Error(detail ?? `Erreur ${r.status}`);
  }
  return r.json();
}

// ---- formats ----
const nf = new Intl.NumberFormat("fr-FR");
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
export const entier = (n: number) => nf.format(Math.round(n));
/** 1 234 567 -> « 1,2 M », 45 300 -> « 45 k » */
export const compact = (n: number) =>
  Math.abs(n) >= 1e6 ? `${nf1.format(n / 1e6)} M` : Math.abs(n) >= 1e4 ? `${nf.format(Math.round(n / 1e3))} k` : nf.format(Math.round(n));
export const pct = (x: number, signe = false) => `${signe && x > 0 ? "+" : ""}${nf1.format(x * 100)} %`;

const parse = (iso: string) => new Date(`${iso}T12:00:00`);
const fJour = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fCourt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const fMois = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit" });
const fLong = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
export const dateJour = (iso: string) => fJour.format(parse(iso));
export const dateCourte = (iso: string) => fCourt.format(parse(iso));
export const dateMois = (iso: string) => fMois.format(parse(iso));
export const dateLongue = (iso: string) => fLong.format(parse(iso));
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const decale = (isoDate: string, jours: number) => {
  const d = parse(isoDate);
  d.setDate(d.getDate() + jours);
  return iso(d);
};
/** 0 = lundi ... 6 = dimanche */
export const jourSemaine = (isoDate: string) => (parse(isoDate).getDay() + 6) % 7;
