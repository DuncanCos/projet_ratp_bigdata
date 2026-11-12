import { useEffect, useMemo, useState } from "react";
import { api, Settings, clock, disruptedStations, worstActive } from "@/lib/api";
import { useIsMobile, useNow, useTraffic, useTrains } from "@/lib/hooks";
import { LINES, isRer, lineById, lineTitle } from "@/lib/metro";
import { LinePicker } from "@/components/LinePicker";
import { LineDrawer } from "@/components/LineDrawer";
import { MapView } from "@/components/MapView";
import { StripMap } from "@/components/StripMap";
import { StationPanel } from "@/components/StationPanel";
import { KeyDialog } from "@/components/KeyDialog";
import { Roundel } from "@/components/Roundel";
import { SettingsMenu } from "@/components/SettingsMenu";
import { Sheet } from "@/components/Sheet";
import { TripPlanner, TripQuery } from "@/components/TripPlanner";
import { Button } from "@/components/ui/button";
import { completePath, extendPath, findRoutes, journeyFromPath, pathEnd } from "@/lib/route";
import { ChartNoAxesColumn, Route } from "lucide-react";
import { dataHref, hashParams, zdc } from "@/lib/frequentation";

const VISIBLE_KEY = "metro-live:lignes-affichees";
/** lignes connues lors du dernier enregistrement : les nouvelles (ex. RER) sont affichées d'office */
const KNOWN_KEY = "metro-live:lignes-connues";

/** Lignes affichées, mémorisées d'une session à l'autre. */
function useVisibleLines() {
  const [visible, setVisible] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(VISIBLE_KEY) ?? "null");
      if (Array.isArray(saved)) {
        const knownRaw = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? "null");
        // avant l'ajout des RER, seules les lignes de métro existaient
        const known = new Set<string>(Array.isArray(knownRaw) ? knownRaw : LINES.filter((l) => !isRer(l)).map((l) => l.id));
        const added = LINES.filter((l) => !known.has(l.id)).map((l) => l.id);
        return new Set([...saved.filter((id: string) => LINES.some((l) => l.id === id)), ...added]);
      }
    } catch {
      /* stockage indisponible : toutes les lignes */
    }
    return new Set(LINES.map((l) => l.id));
  });
  const update = (next: Set<string>) => {
    setVisible(next);
    try {
      localStorage.setItem(VISIBLE_KEY, JSON.stringify([...next]));
      localStorage.setItem(KNOWN_KEY, JSON.stringify(LINES.map((l) => l.id)));
    } catch {
      /* ignoré */
    }
  };
  return [visible, update] as const;
}

const TRIP_KEY = "metro-live:itineraire";

/** Nœud « ligne:station » encore valide (la topologie a pu changer). */
const isNode = (k: string) => {
  const [l, i] = k.split(":");
  const line = LINES.find((x) => x.id === l);
  return !!line && Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < line.stations.length;
};

/** Dernière recherche d'itinéraire, retrouvée au lancement suivant. */
function useTripQuery() {
  const [q, setQ] = useState<TripQuery>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(TRIP_KEY) ?? "null");
      if (v && typeof v === "object")
        return {
          from: v.from ?? null,
          to: v.to ?? null,
          avoidDisrupted: !!v.avoidDisrupted,
          custom: !!v.custom,
          path: Array.isArray(v.path) ? v.path.filter((k: unknown) => typeof k === "string" && isNode(k)) : [],
        };
    } catch {
      /* ignoré */
    }
    return { from: null, to: null, avoidDisrupted: true, custom: false, path: [] };
  });
  const update = (next: TripQuery) => {
    setQ(next);
    try {
      localStorage.setItem(TRIP_KEY, JSON.stringify(next));
    } catch {
      /* ignoré */
    }
  };
  return [q, update] as const;
}

export default function App() {
  // « #/?ligne=C01371 » : retour du tableau de bord sur la ligne qu'on y regardait
  const [focused, setFocused] = useState<string | null>(() => {
    const l = hashParams().ligne;
    return l && LINES.some((x) => x.id === l) ? l : null;
  });
  const [station, setStation] = useState<{ lineId: string; index: number } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [liveAll, setLiveAll] = useState(false);
  const [refresh, setRefresh] = useState(120);
  const [reload, setReload] = useState(0);
  const [visible, setVisible] = useVisibleLines();
  const [tripOpen, setTripOpen] = useState(false);
  const [tripQuery, setTripQuery] = useTripQuery();
  const [choice, setChoice] = useState(0);
  const now = useNow();
  const mobile = useIsMobile();

  useEffect(() => {
    api.settings().then(setSettings).catch(() => setSettings(null));
  }, [reload]);

  const visibleLines = useMemo(() => LINES.filter((l) => visible.has(l.id)), [visible]);
  // une ligne masquée ne peut pas rester sélectionnée
  useEffect(() => {
    if (focused && !visible.has(focused)) {
      setFocused(null);
      setStation(null);
    }
  }, [visible, focused]);

  const { info: traffic, error: trafficError } = useTraffic(reload);
  const trafficLines = traffic?.lines ?? {};

  // Trajet tracé à la main : historique pour annuler, message si la station touchée ne convient pas
  const [drawHistory, setDrawHistory] = useState<string[][]>([]);
  const [drawError, setDrawError] = useState<string | null>(null);
  const setPath = (path: string[], error?: string) => {
    setDrawError(error ?? null);
    if (error || path.join() === tripQuery.path.join()) return;
    setDrawHistory((h) => [...h.slice(-49), tripQuery.path]);
    setTripQuery({ ...tripQuery, path });
  };
  const draw = {
    pick: (lineId: string, index: number) => {
      if (!tripQuery.from) return setDrawError("Choisissez d'abord une station de départ.");
      const r = extendPath(tripQuery.path, tripQuery.from, lineId, index);
      setPath(r.path, r.error);
    },
    undo: () => {
      setDrawError(null);
      const prev = drawHistory[drawHistory.length - 1];
      if (!prev) return;
      setDrawHistory((h) => h.slice(0, -1));
      setTripQuery({ ...tripQuery, path: prev });
    },
    clear: () => setPath([]),
    complete: () => {
      if (!tripQuery.from || !tripQuery.to) return;
      const r = completePath(tripQuery.path, tripQuery.from, tripQuery.to);
      setPath(r.path, r.error);
    },
  };
  const customJourney = useMemo(
    () => (tripQuery.custom && tripQuery.from ? journeyFromPath(tripQuery.from, tripQuery.to ?? "", tripQuery.path) : null),
    [tripQuery],
  );

  // Itinéraire : stations où le trafic est interrompu évitées si demandé
  const options = useMemo(() => {
    if (tripQuery.custom || !tripQuery.from || !tripQuery.to) return [];
    const avoid: Record<string, Set<number>> = {};
    if (tripQuery.avoidDisrupted && traffic && !traffic.demo)
      for (const [lineId, ds] of Object.entries(traffic.lines))
        for (const d of ds)
          if (d.active && d.severity === "BLOQUANTE") {
            const set = (avoid[lineId] ??= new Set());
            const all = d.wholeLine ? lineById(lineId).stations.map((_, i) => i) : d.stations;
            all.forEach((i) => set.add(i));
          }
    return findRoutes(tripQuery.from, tripQuery.to, { avoid });
  }, [tripQuery, traffic]);
  // nouvelle recherche : on revient au trajet le plus rapide
  useEffect(() => setChoice(0), [tripQuery.from, tripQuery.to, tripQuery.avoidDisrupted]);
  const journey = tripQuery.custom ? customJourney : (options[Math.min(choice, options.length - 1)]?.journey ?? null);
  const route = tripOpen ? journey : null;
  // ligne dont on suit le temps réel : la première de l'itinéraire, sinon la ligne choisie
  const liveLine = route ? route.legs[0].lineId : focused;

  // Quota PRIM : 1 000 requêtes par jour. Par défaut, seule la ligne choisie
  // est en temps réel ; les autres lignes affichées sont simulées.
  const shownIds = useMemo(() => {
    const ids = visibleLines.map((l) => l.id);
    route?.legs.forEach((l) => !ids.includes(l.lineId) && ids.push(l.lineId));
    return ids;
  }, [visibleLines, route]);
  const liveIds = useMemo(() => (liveAll ? shownIds : liveLine ? [liveLine] : []), [liveAll, liveLine, shownIds]);
  const { data, error, loading } = useTrains(shownIds, liveIds, refresh, reload);
  const trains = data?.trains ?? [];
  const perturbed = visibleLines.filter((l) => worstActive(trafficLines[l.id]));

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    trains.forEach((t) => (c[t.lineId] = (c[t.lineId] ?? 0) + 1));
    return c;
  }, [trains]);

  const focusLine = focused ? lineById(focused) : null;
  const age = data ? Math.round((now - data.fetchedAtMs) / 1000) : null;
  const lineErrors = data ? Object.entries(data.errors) : [];
  const blockedUntil = data?.quotaBlockedUntilMs ?? null;
  const problem = blockedUntil ? null : (error ?? trafficError ?? (lineErrors.length ? lineErrors[0][1] : null));
  const live = (id: string) => data?.liveLines.includes(id) ?? false;
  const shownTrains = liveLine ? trains.filter((t) => t.lineId === liveLine) : trains;

  // Message d'état : toujours dire si les positions sont réelles ou simulées
  let statusText: string;
  if (!data) statusText = "Chargement…";
  else if (visibleLines.length === 0) statusText = "Aucune ligne affichée";
  else if (data.demo) statusText = "Trains simulés, sans clé API";
  else if (blockedUntil) statusText = `Trains simulés : quota API épuisé jusqu'à ${clock(blockedUntil)}`;
  else if (liveLine && live(liveLine))
    statusText = `${shownTrains.length} trains en direct${route ? ` sur le ${lineTitle(lineById(liveLine))}` : ""}${age !== null && age > 5 ? `, il y a ${age} s` : ""}`;
  else if (liveLine) statusText = `${shownTrains.length} trains simulés${route ? ` sur le ${lineTitle(lineById(liveLine))}` : ""}`;
  else if (data.liveLines.length === shownIds.length) statusText = `${trains.length} trains en direct`;
  else statusText = "Trains simulés. Choisissez une ligne pour le temps réel";
  const isLive = !!data && !data.demo && !blockedUntil && (liveLine ? live(liveLine) : data.liveLines.length > 0);

  const focus = (id: string | null) => {
    setFocused(id);
    setStation(null);
    if (id) setTripOpen(false);
  };
  const selectStation = (lineId: string, index: number) => {
    // pendant un itinéraire, la carte reste sur le trajet
    if (tripOpen) return setStation({ lineId, index });
    if (!visible.has(lineId)) setVisible(new Set([...visible, lineId]));
    setFocused(lineId);
    setStation({ lineId, index });
  };

  const status = (
    <div className="pointer-events-auto min-w-0 max-w-sm rounded-xl bg-white/95 px-3.5 py-2 shadow-md ring-1 ring-border">
      <h1 className="text-lg font-extrabold leading-none tracking-tight">Métro Live</h1>
      <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
        <span
          className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${
            problem ? "bg-signal" : isLive ? "bg-emerald-600" : "bg-amber-500"
          } ${loading ? "animate-pulse" : ""}`}
        />
        {data?.demo ? (
          <button onClick={() => setShowKey(true)} className="text-left underline">
            {statusText}
          </button>
        ) : (
          <span>{statusText}</span>
        )}
      </p>
      {problem && <p className="mt-1 line-clamp-2 text-xs text-signal">{problem}</p>}
      {!focused && !route && perturbed.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-0.5 font-semibold text-signal">Perturbé</span>
          {perturbed.map((l) => (
            <button key={l.id} onClick={() => focus(l.id)} title={worstActive(trafficLines[l.id])?.title} className="rounded-full">
              <Roundel line={l} size={20} />
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const controls = (
    <div className="pointer-events-auto flex shrink-0 items-center gap-2">
      <Button
        variant={tripOpen ? "default" : "outline"}
        className={`h-10 gap-2 rounded-full px-3 shadow-md ${tripOpen ? "" : "bg-white"}`}
        aria-pressed={tripOpen}
        onClick={() => {
          setTripOpen(!tripOpen);
          setStation(null);
          setFocused(null);
        }}
      >
        <Route className="size-4" />
        <span className={mobile ? "sr-only" : ""}>Itinéraire</span>
      </Button>
      <Button asChild variant="outline" className="h-10 gap-2 rounded-full bg-white px-3 shadow-md">
        <a
          href={dataHref({ ligne: station?.lineId ?? focused, station: station ? zdc(lineById(station.lineId).stations[station.index]) : null })}
          aria-label="Données de fréquentation"
        >
          <ChartNoAxesColumn className="size-4" />
          <span className={mobile ? "sr-only" : ""}>Données</span>
        </a>
      </Button>
      <LineDrawer
        visible={visible}
        onChange={setVisible}
        counts={counts}
        traffic={trafficLines}
        direction={mobile ? "bottom" : "left"}
      />
      <SettingsMenu
        refresh={refresh}
        onRefresh={setRefresh}
        liveAll={liveAll}
        onLiveAll={setLiveAll}
        quota={data?.quota ?? null}
        onApiKey={() => setShowKey(true)}
      />
    </div>
  );

  const setTripEnd = (end: "from" | "to", name: string) => {
    const q = { ...tripQuery, [end]: name, path: end === "from" ? [] : tripQuery.path };
    // la même station aux deux bouts : on vide l'autre
    if (q.from === q.to) q[end === "from" ? "to" : "from"] = null;
    setTripQuery(q);
    setTripOpen(true);
    setStation(null);
    setFocused(null);
  };

  // Contenu du panneau : station choisie, sinon itinéraire, sinon plan de ligne
  const stationLine = station ? lineById(station.lineId) : null;
  const panel =
    station && stationLine && (tripOpen || focusLine?.id === station.lineId) ? (
      <StationPanel
        line={stationLine}
        index={station.index}
        now={now}
        disruptions={trafficLines[stationLine.id] ?? []}
        onSelectStation={selectStation}
        onClose={() => setStation(null)}
        onTripEnd={setTripEnd}
        backLabel={tripOpen ? "Retour à l'itinéraire" : undefined}
      />
    ) : tripOpen ? (
      <TripPlanner
        query={tripQuery}
        onQuery={setTripQuery}
        journey={journey}
        options={options}
        choice={Math.min(choice, Math.max(0, options.length - 1))}
        onChoice={setChoice}
        now={now}
        traffic={traffic && !traffic.demo ? trafficLines : {}}
        onClose={() => setTripOpen(false)}
        draw={{ ...draw, error: drawError, canUndo: drawHistory.length > 0 }}
      />
    ) : focusLine ? (
      <StripMap
        line={focusLine}
        trains={shownTrains}
        disruptions={traffic && !traffic.demo ? (trafficLines[focusLine.id] ?? []) : null}
        live={live(focusLine.id)}
        now={now}
        selected={null}
        onStation={(i) => setStation({ lineId: focusLine.id, index: i })}
      />
    ) : null;

  return (
    <div className="flex h-full overflow-hidden">
      {!mobile && (
        <LinePicker lines={visibleLines} focused={focused} counts={counts} traffic={trafficLines} onFocus={focus} />
      )}

      <main className="relative min-w-0 flex-1">
        <MapView
          lines={visibleLines}
          focused={focused}
          trains={trains}
          now={now}
          selectedStation={station}
          hitStations={disruptedStations(focused && !route ? trafficLines[focused] : undefined)}
          onStation={selectStation}
          bottomInset={mobile && panel ? 0.5 : 0}
          route={route}
          drawing={
            tripOpen && tripQuery.custom && !station
              ? { onPick: draw.pick, end: pathEnd(tripQuery.path), from: tripQuery.from, to: tripQuery.to }
              : null
          }
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-2.5 md:p-3">
          <div className="flex items-start justify-between gap-2">
            {status}
            {controls}
          </div>
          {mobile && visibleLines.length > 0 && (
            <div className="pointer-events-auto -mx-2.5 bg-white/90 shadow-sm backdrop-blur">
              <LinePicker
                lines={visibleLines}
                focused={focused}
                counts={counts}
                traffic={trafficLines}
                onFocus={focus}
                horizontal
              />
            </div>
          )}
        </div>
        {mobile && panel && <Sheet resetKey={`${tripOpen ? "trip" : focused}-${station?.index ?? ""}`}>{panel}</Sheet>}
      </main>

      {!mobile && panel && (
        <aside className="flex min-h-0 w-[380px] shrink-0 flex-col overflow-y-auto border-l border-border bg-white">{panel}</aside>
      )}

      <KeyDialog
        open={showKey}
        settings={settings}
        onOpenChange={setShowKey}
        onSaved={() => {
          setShowKey(false);
          setReload((r) => r + 1);
        }}
      />
    </div>
  );
}
