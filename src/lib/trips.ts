import { useState } from "react";
import { placeByName } from "./route";

/** Un trajet mémorisé : départ et arrivée (noms de lieux), avec un nom libre. */
export interface SavedTrip {
  id: string;
  name: string;
  from: string;
  to: string;
  /** éviter les stations où le trafic est interrompu */
  avoidDisrupted: boolean;
  /** trajet tracé à la main (nœuds « ligne:station ») ; absent = trajet calculé */
  path?: string[];
  createdAt: number;
}

export interface RecentTrip {
  from: string;
  to: string;
  at: number;
}

const SAVED_KEY = "metro-live:trajets";
const RECENT_KEY = "metro-live:trajets-recents";
const MAX_RECENT = 6;

function read<T>(k: string, valid: (x: T) => boolean): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? "null");
    return Array.isArray(v) ? v.filter(valid) : [];
  } catch {
    return [];
  }
}
function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* stockage indisponible : non mémorisé */
  }
}

// un lieu renommé ou supprimé lors d'une régénération de metro.json est écarté
const known = (t: { from: string; to: string }) => !!placeByName(t.from) && !!placeByName(t.to);

/** Trajets enregistrés et recherches récentes, mémorisés d'une session à l'autre. */
export function useTrips() {
  const [saved, setSaved] = useState<SavedTrip[]>(() => read<SavedTrip>(SAVED_KEY, known));
  const [recent, setRecent] = useState<RecentTrip[]>(() => read<RecentTrip>(RECENT_KEY, known));

  const commit = (next: SavedTrip[]) => {
    setSaved(next);
    write(SAVED_KEY, next);
  };

  /** trajet enregistré pour ces deux lieux ; avec `path`, le même tracé à la main */
  const find = (from: string, to: string, path?: string[]) =>
    saved.find(
      (t) => t.from === from && t.to === to && (path ? t.path?.join() === path.join() : !t.path?.length),
    ) ?? null;

  const save = (t: Omit<SavedTrip, "id" | "createdAt">) => {
    const existing = find(t.from, t.to, t.path);
    if (existing) commit(saved.map((s) => (s.id === existing.id ? { ...s, ...t } : s)));
    else commit([...saved, { ...t, id: crypto.randomUUID(), createdAt: Date.now() }]);
  };
  const rename = (id: string, name: string) => commit(saved.map((s) => (s.id === id ? { ...s, name } : s)));
  const remove = (id: string) => commit(saved.filter((s) => s.id !== id));
  const remember = (from: string, to: string) => {
    const next = [{ from, to, at: Date.now() }, ...recent.filter((r) => r.from !== from || r.to !== to)].slice(
      0,
      MAX_RECENT,
    );
    setRecent(next);
    write(RECENT_KEY, next);
  };
  const clearRecent = () => {
    setRecent([]);
    write(RECENT_KEY, []);
  };

  return { saved, recent, find, save, rename, remove, remember, clearRecent };
}

/** Nom proposé par défaut : « Domicile → Travail » n'est pas devinable, on prend les stations. */
export const defaultTripName = (from: string, to: string) => `${from} → ${to}`;
