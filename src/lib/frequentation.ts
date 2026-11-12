/** Lien entre la carte temps réel et le volet données : mêmes lignes, mêmes stations. */
import { Station } from "./metro";

export interface LigneResume {
  id: string;
  nom: string;
  jour_max: string;
  moyenne_jour: number;
  evolution: number | null;
  prevu_aujourdhui: number | null;
  semaines: { jour: string; moyenne: number }[];
  /** validations par jour de chaque station de la ligne, par identifiant de zone */
  stations: Record<string, number>;
}
export interface StationResume {
  id_zdc: number;
  nom: string;
  moyenne_jour: number;
  rang: number;
  nb_stations: number;
  previsions: { jour: string; prevu: number }[];
  type_jour: string | null;
  profil: { heure: number; pourcentage: number }[];
}

/** « IDFM:71517 » -> 71517 : l'identifiant de zone, commun au GTFS et aux validations. */
export const zdc = (s: Station) => Number(s.id.split(":").pop());

/** Adresse du tableau de bord, déjà filtré sur une ligne ou une station. */
export const dataHref = (f: { ligne?: string | null; station?: number | null } = {}) => {
  const q = [f.ligne && `ligne=${f.ligne}`, f.station && `station=${f.station}`].filter(Boolean).join("&");
  return `#/donnees${q ? `?${q}` : ""}`;
};
export const carteHref = (ligne?: string | null) => (ligne ? `#/?ligne=${ligne}` : "#/");

/** Paramètres portés par l'adresse (« #/donnees?ligne=C01371&station=71517 »). */
export const hashParams = () => {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const station = Number(q.get("station"));
  return { ligne: q.get("ligne"), station: Number.isFinite(station) && station > 0 ? station : null };
};
