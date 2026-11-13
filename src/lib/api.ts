import { invoke } from "@tauri-apps/api/core";
import { journeeEnCours, passagesPrevus } from "./journee";

export interface NextStop { station: number; atMs: number }
export interface Train {
  id: string;
  lineId: string;
  from: number;
  to: number;
  departAtMs: number;
  arriveAtMs: number;
  atStation: boolean;
  destination: string;
  nextStops: NextStop[];
  /** placé d'après les horaires prévus (GTFS), et non d'après le temps réel de PRIM */
  prevu?: boolean;
}
export interface Quota {
  limit: number | null;
  remaining: number | null;
  resetAtMs: number | null;
  blockedUntilMs: number | null;
}
export interface TrainsResponse {
  /** pas de clé API : aucun temps réel, tout suit les horaires prévus */
  demo: boolean;
  fetchedAtMs: number;
  trains: Train[];
  /** lignes en temps réel ; les autres suivent les horaires prévus */
  liveLines: string[];
  errors: Record<string, string>;
  quota: Quota;
  quotaBlockedUntilMs: number | null;
}
export interface Departure {
  lineId: string;
  destination: string;
  direction: string;
  expectedMs: number | null;
  aimedMs: number | null;
  platform: string | null;
  atStop: boolean;
  /** « prévu » : horaire théorique, faute de temps réel */
  status: string | null;
}
export interface Disruption {
  id: string;
  title: string;
  shortMessage: string;
  message: string;
  severity: "BLOQUANTE" | "PERTURBEE" | "INFORMATION" | string;
  cause: string;
  active: boolean;
  beginMs: number;
  endMs: number;
  stations: number[];
  wholeLine: boolean;
}
export interface TrafficInfo {
  demo: boolean;
  fetchedAtMs: number;
  lines: Record<string, Disruption[]>;
}

export interface Settings { hasKey: boolean; keyFromEnv: boolean }

export const api = {
  settings: () => invoke<Settings>("get_settings"),
  setKey: (key: string) => invoke<void>("set_api_key", { key }),
  trains: (lineIds: string[], liveIds: string[]) => invoke<TrainsResponse>("get_trains", { lineIds, liveIds }),
  traffic: () => invoke<TrafficInfo>("get_traffic"),
  /** Prochains passages : le temps réel de PRIM s'il répond, sinon les horaires prévus. */
  departures: async (lineId: string, stationIndex: number) => {
    const reel = await invoke<Departure[]>("get_departures", { lineId, stationIndex }).catch(() => [] as Departure[]);
    return reel.length ? reel : passagesPrevus(await journeeEnCours(), Date.now(), lineId, stationIndex);
  },
};

/** Avancement 0..1 d'un train sur son segment à l'instant `now`. */
export const progress = (t: Train, now: number) => {
  if (t.from === t.to) return 0;
  const span = t.arriveAtMs - t.departAtMs;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - t.departAtMs) / span));
};

export const minutesUntil = (ms: number | null, now: number) => {
  if (ms == null) return "—";
  const m = Math.floor((ms - now) / 60000);
  if (m <= 0) return "à quai";
  return `${m} min`;
};

/** "Métro 13 : Travaux de modernisation - Trafic interrompu" -> "Travaux de modernisation - Trafic interrompu" (idem « RER A : ») */
export const cleanTitle = (t: string) => t.replace(/^(M[ée]tro|RER|Ligne)\s*\S+?\s*:\s*/i, "");

/** Pire perturbation en cours d'une ligne, pour la pastille. */
export const worstActive = (ds: Disruption[] | undefined) =>
  ds?.find((d) => d.active && d.severity !== "INFORMATION") ?? null;

/** Stations touchées par une perturbation en cours. */
export const disruptedStations = (ds: Disruption[] | undefined) =>
  new Set((ds ?? []).filter((d) => d.active && d.severity !== "INFORMATION").flatMap((d) => d.stations));

const fmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const formatWhen = (d: Disruption) =>
  d.active ? `jusqu'au ${fmt.format(d.endMs)}` : `à partir du ${fmt.format(d.beginMs)}`;

export const clock = (ms: number) =>
  new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(ms);
