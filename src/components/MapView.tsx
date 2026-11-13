import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Locate, Minus, Plus } from "lucide-react";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Train, progress } from "../lib/api";
import { LINES, Line, along, geometry, isRer, lineById, lineTitle, segmentPoints } from "../lib/metro";
import { Journey } from "../lib/route";

interface Props {
  /** lignes affichées */
  lines: Line[];
  focused: string | null;
  trains: Train[];
  now: number;
  selectedStation: { lineId: string; index: number } | null;
  hitStations: Set<number>;
  onStation: (lineId: string, index: number) => void;
  /** part de la hauteur masquée en bas (tiroir mobile), pour recadrer la carte */
  bottomInset?: number;
  /** itinéraire à dessiner : il remplace la ligne choisie */
  route?: Journey | null;
  /** tracé du trajet à la main : stations touchables, toucher-glisser */
  drawing?: Drawing | null;
}

export interface Drawing {
  onPick: (lineId: string, index: number) => void;
  /** dernière station du tracé */
  end: { lineId: string; index: number } | null;
  from: string | null;
  to: string | null;
}

const INK = "#1d2733";

/** Position d'un lieu (nom de station) : la première station qui porte ce nom. */
const PLACES_POS = (() => {
  const m = new Map<string, [number, number]>();
  for (const l of LINES) l.stations.forEach((s, i) => !m.has(s.name) && m.set(s.name, geometry(l).stationPos[i]));
  return m;
})();
const MUTED = "#aeb7b3";

// Île-de-France élargie : on ne peut pas se perdre loin du réseau
export const BOUNDS = L.latLngBounds([48.55, 1.85], [49.15, 2.85]);

function useFit(line: Line | null, lines: Line[], bottomInset: number, only?: [number, number][]) {
  const map = useMap();
  return useCallback(
    (duration = 0.6) => {
      // vue réseau : on cadre Paris (le métro) plutôt que les terminus lointains des RER
      const shown = lines.length ? lines : LINES;
      const metro = shown.filter((l) => !isRer(l));
      const pts = only?.length ? only : (line ? [line] : metro.length ? metro : shown).flatMap((l) => geometry(l).stationPos);
      const h = map.getSize().y;
      map.flyToBounds(L.latLngBounds(pts), {
        paddingTopLeft: [24, 140],
        paddingBottomRight: [72, 24 + h * bottomInset],
        duration,
        maxZoom: 15,
      });
    },
    [map, line, lines, bottomInset, only],
  );
}

interface FitProps {
  line: Line | null;
  lines: Line[];
  bottomInset: number;
  /** points à cadrer (itinéraire), à la place des lignes */
  only?: [number, number][];
  fitKey?: string;
}

export function FitTo({ line, lines, bottomInset, only, fitKey }: FitProps) {
  const fit = useFit(line, lines, bottomInset, only);
  // recadrage seulement quand la ligne choisie change, pas à chaque case cochée
  const key = fitKey ?? (line ? line.id : "reseau");
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bottomInset]);
  return null;
}

/** Boutons +, − et recentrer, posés en bas à droite au-dessus du tiroir mobile. */
export function ZoomControls({ line, lines, bottomInset, only }: FitProps) {
  const map = useMap();
  const fit = useFit(line, lines, bottomInset, only);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // les clics et la molette sur les boutons ne doivent pas atteindre la carte
    if (ref.current) {
      L.DomEvent.disableClickPropagation(ref.current);
      L.DomEvent.disableScrollPropagation(ref.current);
    }
  }, []);
  const btn =
    "flex size-10 items-center justify-center text-ink transition-colors hover:bg-tile active:bg-tile-deep";
  return (
    <div
      ref={ref}
      className="absolute right-2.5 z-[1000] flex flex-col gap-2 md:right-3"
      style={{ bottom: `calc(${bottomInset * 100}% + 16px)` }}
    >
      <div className="flex flex-col overflow-hidden rounded-full border border-border bg-white shadow-md">
        <button type="button" className={btn} aria-label="Zoomer" onClick={() => map.zoomIn(1)}>
          <Plus className="size-5" />
        </button>
        <span className="mx-2 h-px bg-border" />
        <button type="button" className={btn} aria-label="Dézoomer" onClick={() => map.zoomOut(1)}>
          <Minus className="size-5" />
        </button>
      </div>
      <button
        type="button"
        className={`${btn} rounded-full border border-border bg-white shadow-md`}
        aria-label={only?.length ? "Recentrer sur l'itinéraire" : line ? `Recentrer sur ${lineTitle(line)}` : "Recentrer sur le réseau"}
        onClick={() => fit(0.5)}
      >
        <Locate className="size-5" />
      </button>
    </div>
  );
}

/** Position du train sur la voie, et cap (degrés) pour orienter la flèche. */
export function trainPose(t: Train, now: number): { pos: [number, number]; bearing: number | null } {
  const line = lineById(t.lineId);
  const a = geometry(line).stationPos[t.from];
  if (t.from === t.to) return { pos: a, bearing: null };
  const pts = segmentPoints(line, t.from, t.to);
  const p = progress(t, now);
  const pos = along(pts, p);
  const ahead = along(pts, Math.min(1, p + 0.05));
  const behind = p > 0.95 ? along(pts, p - 0.05) : pos;
  const [from, to] = p > 0.95 ? [behind, pos] : [pos, ahead];
  const dy = to[0] - from[0];
  const dx = (to[1] - from[1]) * Math.cos((pos[0] * Math.PI) / 180);
  return { pos, bearing: (Math.atan2(dx, dy) * 180) / Math.PI };
}

/**
 * Sens du train (0 ou 1, comme `Pattern.direction`), déduit du tronçon parcouru.
 * Un parcours parcouru à l'envers donne l'autre sens : les RER n'ont que des
 * parcours du sens 0, et un direct peut sauter des gares (`from` et `to` non voisins).
 */
export function trainDirection(line: Line, t: Train): 0 | 1 {
  const dir = (d: number, forward: boolean): 0 | 1 => ((d === 1) === forward ? 1 : 0);
  const sensBetween = (a: number, b: number) => {
    for (const p of line.patterns) {
      const i = p.stations.indexOf(a);
      const j = p.stations.indexOf(b);
      if (i >= 0 && j >= 0 && i !== j) return dir(p.direction, j > i);
    }
    return null;
  };
  if (t.from !== t.to) {
    // métro : le parcours qui enchaîne exactement ces deux stations
    for (const p of line.patterns) {
      const k = p.stations.indexOf(t.from);
      if (k >= 0 && p.stations[k + 1] === t.to) return dir(p.direction, true);
    }
    const d = sensBetween(t.from, t.to);
    if (d !== null) return d;
  }
  // à quai : on regarde le prochain arrêt annoncé
  const next = t.nextStops.map((n) => n.station).find((s) => s !== t.from);
  if (next !== undefined) {
    for (const p of line.patterns) {
      const a = p.stations.indexOf(t.from);
      const b = p.stations.indexOf(next);
      if (a >= 0 && b > a) return dir(p.direction, true);
    }
    const d = sensBetween(t.from, next);
    if (d !== null) return d;
  }
  const p = line.patterns.find((p) => line.stations[p.stations[p.stations.length - 1]].name === t.destination);
  if (p) return dir(p.direction, true);
  const q = line.patterns.find((p) => line.stations[p.stations[0]].name === t.destination);
  return q ? dir(q.direction, false) : 0;
}

/** Terminus de chaque sens ("Château de Vincennes", "La Défense / ..."). */
function termini(line: Line, d: 0 | 1) {
  const names = line.patterns.flatMap((p) => {
    const sens = p.direction === 1 ? 1 : 0;
    const ends = [p.stations[0], p.stations[p.stations.length - 1]];
    // parcours du sens d : son terminus ; parcours de l'autre sens (RER : un seul sens) : son origine
    if (sens === d) return [line.stations[ends[1]].name];
    return line.patterns.some((o) => (o.direction === 1 ? 1 : 0) === d) ? [] : [line.stations[ends[0]].name];
  });
  return [...new Set(names)].join(" / ");
}

/**
 * Pastille de train en forme de goutte : la pointe montre où il va.
 * Sens 0 : pastille pleine à la couleur de la ligne ; sens 1 : pastille blanche cerclée.
 */
function trainSvg(line: Line, dir: 0 | 1, bearing: number | null, size: number, mark: boolean) {
  const fill = dir === 0 ? line.color : "#fff";
  const ring = dir === 0 ? "#fff" : line.color;
  const ink = dir === 0 ? line.textColor : line.color;
  const shape =
    bearing === null
      ? (attrs: string) => `<circle cx="20" cy="20" r="12" ${attrs}/>`
      : (attrs: string) => `<path d="M20 3L28.5 11.5A12 12 0 1 1 11.5 11.5Z" stroke-linejoin="round" ${attrs}/>`;
  const inner = !mark
    ? ""
    : bearing === null
      ? `<rect x="16" y="16" width="8" height="8" rx="2" fill="${ink}"/>`
      : `<path d="M14.5 23.5L20 17.5L25.5 23.5" fill="none" stroke="${ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  const rot = bearing === null ? "" : `transform:rotate(${bearing}deg);`;
  return (
    `<svg viewBox="0 0 40 40" width="${size}" height="${size}" style="${rot}overflow:visible;display:block">` +
    shape(`fill="none" stroke="${INK}" stroke-width="7"`) +
    shape(`fill="${fill}" stroke="${ring}" stroke-width="3.5"`) +
    inner +
    `</svg>`
  );
}

// Les icônes sont mises en cache : un train ne change d'icône que si son cap
// change de plus de 15°.
const iconCache = new Map<string, L.DivIcon>();
function trainIcon(line: Line, dir: 0 | 1, bearing: number | null, size: number) {
  const b = bearing === null ? null : Math.round(bearing / 15) * 15;
  const key = `${line.id}-${dir}-${b}-${size}`;
  let icon = iconCache.get(key);
  if (!icon) {
    icon = L.divIcon({
      className: "train-icon",
      html: trainSvg(line, dir, b, size, size >= 28),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    iconCache.set(key, icon);
  }
  return icon;
}

function useZoom() {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  return zoom;
}

/** Légende des deux sens de la ligne choisie, avec le nombre de trains dans chaque sens. */
export function DirectionLegend({ line, counts, bottomInset }: { line: Line; counts: [number, number]; bottomInset: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) {
      L.DomEvent.disableClickPropagation(ref.current);
      L.DomEvent.disableScrollPropagation(ref.current);
    }
  }, []);
  return (
    <div
      ref={ref}
      className="absolute left-2.5 z-[1000] flex max-w-[calc(100%-5rem)] flex-col gap-1.5 rounded-xl border border-border bg-white/95 px-3 py-2 text-sm shadow-md md:left-3"
      style={{ bottom: `calc(${bottomInset * 100}% + 16px)` }}
    >
      {([0, 1] as const).map((d) => (
        <div key={d} className="flex items-center gap-2.5">
          <span className="shrink-0" dangerouslySetInnerHTML={{ __html: trainSvg(line, d, 90, 22, true) }} />
          <span className="min-w-0 truncate">
            vers <b className="font-semibold">{termini(line, d)}</b>
          </span>
          <span className="ml-auto pl-1 text-ink-soft tabular-nums">{counts[d]}</span>
        </div>
      ))}
    </div>
  );
}

/** Itinéraire : tronçons à la couleur de chaque ligne, marche en pointillés, étapes nommées. */
function RouteLayer({
  route,
  lineWeight,
  stationR,
  showNames,
  onStation,
}: {
  route: Journey;
  lineWeight: number;
  stationR: number;
  showNames: boolean;
  onStation: (lineId: string, index: number) => void;
}) {
  const legs = route.legs.map((leg) => {
    const line = lineById(leg.lineId);
    const g = geometry(line);
    const pts = leg.stations.flatMap((s, k) => {
      if (k === 0) return [g.stationPos[s]];
      const seg = segmentPoints(line, leg.stations[k - 1], s);
      return seg.slice(1);
    });
    return { leg, line, g, pts };
  });
  return (
    <>
      {legs.map(({ line, pts }, i) => [
        <Polyline
          key={`r-${i}-casing`}
          positions={pts}
          pathOptions={{ color: "#fff", weight: lineWeight + 6, opacity: 1, lineCap: "round", lineJoin: "round" }}
        />,
        <Polyline
          key={`r-${i}`}
          positions={pts}
          pathOptions={{ color: line.color, weight: lineWeight, opacity: 1, lineCap: "round", lineJoin: "round" }}
        />,
      ])}
      {/* marche entre deux quais d'une correspondance */}
      {legs.slice(1).map(({ pts }, i) => (
        <Polyline
          key={`walk-${i}`}
          positions={[legs[i].pts[legs[i].pts.length - 1], pts[0]]}
          pathOptions={{ color: INK, weight: 3, dashArray: "2 6", lineCap: "round" }}
        />
      ))}
      {legs.flatMap(({ leg, line, g }, i) =>
        leg.stations.map((s, k) => {
          const isStart = i === 0 && k === 0;
          const isEnd = i === legs.length - 1 && k === leg.stations.length - 1;
          const isStop = k === 0 || k === leg.stations.length - 1;
          // le point de départ d'une correspondance est déjà dessiné par le tronçon précédent
          if (isStop && k === 0 && i > 0) return null;
          const named = isStart || isEnd || isStop || showNames;
          return (
            <CircleMarker
              key={`rs-${i}-${k}`}
              center={g.stationPos[s]}
              radius={isStart || isEnd ? stationR + 3 : isStop ? stationR + 1 : stationR - 1}
              pathOptions={{
                color: isEnd ? "#e4002b" : INK,
                weight: isStop ? 3.5 : 2,
                fillColor: isEnd ? "#e4002b" : "#fff",
                fillOpacity: 1,
              }}
              eventHandlers={{ click: () => onStation(line.id, s) }}
            >
              <Tooltip
                key={named ? "label" : "hover"}
                permanent={named}
                className={named ? `station-label${isStop ? " is-strong" : ""}` : "station-tip"}
                direction={named ? "right" : "top"}
                offset={named ? [stationR + 4, 0] : [0, -8]}
              >
                {line.stations[s].name}
              </Tooltip>
            </CircleMarker>
          );
        }),
      )}
    </>
  );
}

/**
 * Lignes montrées pendant le tracé : la ligne en cours (au départ, celles du
 * lieu de départ) et les lignes qui la croisent, où l'on peut changer.
 */
function drawScope(drawing: Drawing) {
  const current = new Set<string>();
  if (drawing.end) current.add(drawing.end.lineId);
  else for (const l of LINES) if (l.stations.some((s) => s.name === drawing.from)) current.add(l.id);
  const around = new Set<string>();
  for (const id of current)
    for (const s of lineById(id).stations) for (const t of s.transfers) if (!current.has(t.lineId)) around.add(t.lineId);
  return { current, around };
}

/**
 * Tracé à la main : on touche une station, ou on glisse le doigt (ou la souris
 * bouton enfoncé) de station en station. Un appui qui commence près d'une
 * station dessine au lieu de déplacer la carte ; ailleurs, la carte se déplace
 * normalement.
 */
function DrawLayer({
  drawing,
  scope,
  zoom,
  bottomInset,
}: {
  drawing: Drawing;
  scope: ReturnType<typeof drawScope>;
  zoom: number;
  bottomInset: number;
}) {
  const map = useMap();
  // stations touchables : ligne en cours et lignes qui la croisent
  const shown = useMemo(() => LINES.filter((l) => scope.current.has(l.id) || scope.around.has(l.id)), [scope]);

  // au début du tracé : zoom sur la station de départ
  const startPos = useMemo(() => {
    const p = drawing.from ? PLACES_POS.get(drawing.from) : undefined;
    return p ?? null;
  }, [drawing.from]);
  const fresh = !drawing.end;
  useEffect(() => {
    if (!fresh || !startPos) return;
    // centre décalé vers le haut quand le tiroir (téléphone) masque le bas de la carte
    const z = Math.max(map.getZoom(), 14);
    const c = map.unproject(map.project(startPos, z).add([0, (map.getSize().y * bottomInset) / 2]), z);
    map.flyTo(c, z, { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPos, fresh]);
  const cands = useMemo(
    () =>
      shown.flatMap((l) =>
        l.stations.map((s, index) => ({ lineId: l.id, index, name: s.name, pos: geometry(l).stationPos[index] })),
      ),
    [shown],
  );
  const live = useRef(drawing);
  live.current = drawing;

  useEffect(() => {
    const el = map.getContainer();
    let active = false;
    let last = "";
    const nearest = (e: PointerEvent) => {
      const pt = map.mouseEventToContainerPoint(e as unknown as MouseEvent);
      const end = live.current.end;
      let best: (typeof cands)[number] | null = null;
      let bestD = 24;
      for (const c of cands) {
        let d = map.latLngToContainerPoint(c.pos).distanceTo(pt);
        // stations superposées (Châtelet…) : on reste sur la ligne en cours
        if (end && c.lineId === end.lineId) d -= 6;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const c = nearest(e);
      if (!c) return; // loin des stations : on laisse la carte se déplacer
      active = true;
      last = `${c.lineId}:${c.index}`;
      map.dragging.disable();
      e.stopPropagation();
      live.current.onPick(c.lineId, c.index);
    };
    const move = (e: PointerEvent) => {
      if (!active) return;
      const c = nearest(e);
      if (!c) return;
      const k = `${c.lineId}:${c.index}`;
      if (k === last) return;
      last = k;
      live.current.onPick(c.lineId, c.index);
    };
    const up = () => {
      if (!active) return;
      active = false;
      map.dragging.enable();
    };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      map.dragging.enable();
    };
  }, [map, cands]);

  const r = zoom < 12 ? 3 : zoom < 13.5 ? 4.5 : 6;
  const end = drawing.end;
  const endPos = end ? geometry(lineById(end.lineId)).stationPos[end.index] : null;
  const start = !end && drawing.from ? cands.filter((c) => c.name === drawing.from) : [];
  const dest = drawing.to ? cands.filter((c) => c.name === drawing.to) : [];
  return (
    <>
      {cands.map((c) => {
        const cur = scope.current.has(c.lineId);
        return (
          <CircleMarker
            key={`draw-${c.lineId}-${c.index}`}
            center={c.pos}
            radius={cur ? r : r - 1}
            interactive={false}
            pathOptions={{ color: lineById(c.lineId).color, weight: cur ? 2.5 : 1.5, fillColor: "#fff", fillOpacity: 1, opacity: cur ? 1 : 0.7 }}
          />
        );
      })}
      {[...start, ...dest].map((c) => (
        <CircleMarker
          key={`draw-end-${c.lineId}-${c.index}`}
          center={c.pos}
          radius={r + 4}
          interactive={false}
          pathOptions={{
            color: c.name === drawing.to ? "#e4002b" : INK,
            weight: 3.5,
            fillColor: c.name === drawing.to ? "#ffd9df" : "#fff",
            fillOpacity: 1,
          }}
        />
      ))}
      {endPos && (
        <>
          <CircleMarker center={endPos} radius={r + 9} interactive={false} pathOptions={{ color: INK, weight: 2, fillOpacity: 0.12, fillColor: INK, dashArray: "4 4" }} />
          <CircleMarker center={endPos} radius={r + 3} interactive={false} pathOptions={{ color: INK, weight: 4, fillColor: "#fff", fillOpacity: 1 }} />
        </>
      )}
    </>
  );
}

function Layers({ lines, focused: focusedProp, trains, now, selectedStation, hitStations, onStation: onStationProp, bottomInset = 0, route, drawing }: Props) {
  // en mode tracé, toucher une station la prend dans le trajet (pas de panneau station)
  const onStation = drawing ? () => {} : onStationProp;
  const zoom = useZoom();
  // un itinéraire affiché prend le pas sur la ligne choisie
  const focused = route ? null : focusedProp;
  const focusLine = focused ? lineById(focused) : null;
  const routeLines = useMemo(() => new Set(route?.legs.map((l) => l.lineId) ?? []), [route]);
  const routePts = useMemo(
    () => route?.legs.flatMap((l) => l.stations.map((i) => geometry(lineById(l.lineId)).stationPos[i])) ?? [],
    [route],
  );
  const routeKey = route ? `route:${route.from}|${route.to}|${route.legs.map((l) => l.lineId).join(",")}` : undefined;
  // tracé à la main : seulement la ligne en cours et celles qui la croisent
  const scope = useMemo(
    () => (drawing ? drawScope(drawing) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawing?.from, drawing?.end?.lineId],
  );
  // ligne choisie dessinée en dernier, pour passer au-dessus
  const ordered = useMemo(() => {
    if (scope)
      return LINES.filter((l) => scope.around.has(l.id)).concat(LINES.filter((l) => scope.current.has(l.id)));
    return [...lines].sort((a, b) => Number(a.id === focused) - Number(b.id === focused));
  }, [lines, focused, scope]);
  const visibleIds = new Set(lines.map((l) => l.id));
  // pendant le tracé, pas de trains : la carte reste lisible
  const shown = scope
    ? []
    : trains.filter((t) =>
        route ? routeLines.has(t.lineId) : focused === null ? visibleIds.has(t.lineId) : t.lineId === focused,
      );

  // taille des stations qui suit le zoom ; noms affichés dès qu'il y a la place
  const stationR = zoom < 12 ? 4.5 : zoom < 13.5 ? 6 : zoom < 15 ? 7 : 8.5;
  const showNames = zoom >= 13.75;
  const lineWeight = zoom < 12 ? 6 : zoom < 14 ? 8 : 10;

  const poses = shown.map((t) => {
    const l = lineById(t.lineId);
    return { t, l, dir: trainDirection(l, t), ...trainPose(t, now) };
  });
  const counts: [number, number] = [0, 0];
  if (focusLine) poses.forEach((p) => counts[p.dir]++);

  return (
    <>
      {/* pendant le tracé, la carte ne se recadre pas à chaque station ajoutée */}
      {!drawing && <FitTo line={focusLine} lines={lines} bottomInset={bottomInset} only={routePts} fitKey={routeKey} />}
      <ZoomControls line={focusLine} lines={lines} bottomInset={bottomInset} only={routePts} />
      {focusLine && <DirectionLegend line={focusLine} counts={counts} bottomInset={bottomInset} />}

      {ordered.map((l) => {
        const isFocus = scope ? scope.current.has(l.id) : l.id === focused;
        const other = scope ? !isFocus : (focused !== null || !!route) && !isFocus;
        return l.patterns.map((p, i) => [
          // liseré blanc sous la ligne choisie pour la détacher du fond
          isFocus && (
            <Polyline
              key={`${l.id}-${i}-casing`}
              positions={p.shape}
              pathOptions={{ color: "#fff", weight: lineWeight + 5, opacity: 1, lineCap: "round", lineJoin: "round" }}
            />
          ),
          <Polyline
            key={`${l.id}-${i}`}
            positions={p.shape}
            pathOptions={{
              // tracé : les lignes qui croisent gardent leur couleur, en plus fin
              color: other && !scope ? MUTED : l.color,
              weight: isFocus ? lineWeight : other ? (scope ? 3 : 2) : zoom >= 13 ? 4.5 : 3.5,
              opacity: other ? (scope ? 0.5 : 0.6) : 1,
              lineCap: "round",
              lineJoin: "round",
            }}
          />,
        ]);
      })}

      {route && <RouteLayer route={route} lineWeight={lineWeight} stationR={stationR} showNames={showNames} onStation={onStation} />}

      {drawing && scope && <DrawLayer drawing={drawing} scope={scope} zoom={zoom} bottomInset={bottomInset} />}

      {/* vue réseau : les stations apparaissent en zoomant, cliquables */}
      {!focusLine &&
        !route &&
        !drawing &&
        zoom >= 12.75 &&
        lines.flatMap((l) =>
          l.stations.map((s, i) => (
            <CircleMarker
              key={`${l.id}-net-${i}`}
              center={geometry(l).stationPos[i]}
              radius={zoom < 14 ? 3 : 4.5}
              pathOptions={{ color: INK, weight: 1.5, fillColor: "#fff", fillOpacity: 1 }}
              eventHandlers={{ click: () => onStation(l.id, i) }}
            >
              <Tooltip className="station-tip" direction="top" offset={[0, -6]}>
                {s.name} · {lineTitle(l)}
              </Tooltip>
            </CircleMarker>
          )),
        )}

      {focusLine &&
        focusLine.stations.map((s, i) => {
          const sel = selectedStation?.lineId === focusLine.id && selectedStation.index === i;
          const hit = hitStations.has(i);
          const terminus = focusLine.patterns.some((p) => p.stations[0] === i || p.stations[p.stations.length - 1] === i);
          const named = showNames || terminus || sel;
          return (
            <CircleMarker
              key={`${focusLine.id}-st-${i}`}
              center={geometry(focusLine).stationPos[i]}
              radius={sel ? stationR + 3 : terminus ? stationR + 1 : stationR}
              pathOptions={{
                color: hit ? "#e4002b" : INK,
                weight: sel || terminus ? 3.5 : 2.5,
                fillColor: hit ? "#ffd9df" : "#fff",
                fillOpacity: 1,
              }}
              eventHandlers={{ click: () => onStation(focusLine.id, i) }}
            >
              <Tooltip
                key={named ? "label" : "hover"}
                permanent={named}
                className={named ? `station-label${terminus || sel ? " is-strong" : ""}` : "station-tip"}
                direction={named ? "right" : "top"}
                offset={named ? [stationR + 4, 0] : [0, -8]}
              >
                {s.name}
              </Tooltip>
            </CircleMarker>
          );
        })}

      {poses.map(({ t, l, dir, pos, bearing }) => {
        // vue réseau dézoomée : simples points ; dès qu'on zoome, pastilles orientées
        if (!focusLine && zoom < 13)
          return (
            <CircleMarker
              key={`${t.lineId}-${t.id}`}
              center={pos}
              radius={3.5}
              // horaire prévu : point estompé, pour le distinguer du temps réel
              pathOptions={{ color: dir === 0 ? "#fff" : l.color, weight: 1.5, fillColor: dir === 0 ? l.color : "#fff", fillOpacity: t.prevu ? 0.65 : 1, opacity: t.prevu ? 0.65 : 1 }}
            >
              <Tooltip className="station-tip" direction="top" offset={[0, -6]}>
                {lineTitle(l)} vers {t.destination} ({t.prevu ? "horaire prévu" : "temps réel"})
              </Tooltip>
            </CircleMarker>
          );
        const size = focusLine ? (zoom >= 14 ? 34 : 30) : 22;
        return (
          <Marker key={`${t.lineId}-${t.id}`} position={pos} icon={trainIcon(l, dir, bearing, size)} zIndexOffset={1000} opacity={t.prevu ? 0.7 : 1}>
            <Tooltip className="station-tip" direction="top" offset={[0, -size / 2]}>
              {!focusLine && `${lineTitle(l)} `}vers {t.destination}
              {t.atStation && `, à quai à ${l.stations[t.from].name}`} ({t.prevu ? "horaire prévu" : "temps réel"})
            </Tooltip>
          </Marker>
        );
      })}
    </>
  );
}

export function MapView(props: Props) {
  return (
    <MapContainer
      center={[48.8566, 2.3522]}
      zoom={12}
      zoomControl={false}
      // zoom fin : molette et pincement par quarts de niveau, plus doux qu'un saut x2
      zoomSnap={0.25}
      zoomDelta={0.5}
      wheelPxPerZoomLevel={90}
      wheelDebounceTime={20}
      minZoom={10}
      maxZoom={18}
      maxBounds={BOUNDS}
      maxBoundsViscosity={0.8}
      className="h-full w-full"
      preferCanvas
    >
      <TileLayer
        maxZoom={18}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        className="basemap"
      />
      <Layers {...props} />
    </MapContainer>
  );
}
