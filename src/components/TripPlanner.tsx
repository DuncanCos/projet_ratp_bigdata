import { ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  ArrowUpDown,
  Clock,
  Hand,
  Sparkles,
  Undo2,
  Footprints,
  History,
  Pencil,
  RotateCcw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { Departure, Disruption, api, clock, cleanTitle, formatWhen } from "@/lib/api";
import { lineById, lineTitle } from "@/lib/metro";
import { Journey, Leg, Option, Place, formatDuration, normalize, pathReaches, searchPlaces } from "@/lib/route";
import { SavedTrip, defaultTripName, useTrips } from "@/lib/trips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Roundel } from "./Roundel";

export interface TripQuery {
  from: string | null;
  to: string | null;
  avoidDisrupted: boolean;
  /** trajet tracé à la main sur la carte, plutôt que calculé */
  custom: boolean;
  /** trajet tracé : nœuds « ligne:station » */
  path: string[];
}

export interface DrawControls {
  undo: () => void;
  clear: () => void;
  complete: () => void;
  canUndo: boolean;
  /** la dernière station touchée ne prolonge pas le trajet */
  error: string | null;
}

interface Props {
  query: TripQuery;
  onQuery: (q: TripQuery) => void;
  journey: Journey | null;
  /** trajets possibles, du plus rapide au plus lent */
  options: Option[];
  choice: number;
  onChoice: (i: number) => void;
  now: number;
  traffic: Record<string, Disruption[]>;
  onClose: () => void;
  draw: DrawControls;
}

/** Panneau itinéraire : départ, arrivée, trajet détaillé, trajets enregistrés. */
export function TripPlanner({ query, onQuery, journey, options, choice, onChoice, now, traffic, onClose, draw }: Props) {
  const trips = useTrips();
  const { from, to } = query;
  const ready = !!from && !!to && from !== to;
  const custom = query.custom;
  const reached = custom && query.path.length > 0 && journey !== null && pathReaches(query.path, to ?? "");

  // une recherche aboutie rejoint l'historique
  useEffect(() => {
    if (journey && !custom) trips.remember(journey.from, journey.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journey?.from, journey?.to]);

  const load = (t: { from: string; to: string; avoidDisrupted?: boolean; path?: string[] }) =>
    onQuery({
      from: t.from,
      to: t.to,
      avoidDisrupted: t.avoidDisrupted ?? query.avoidDisrupted,
      custom: !!t.path?.length,
      path: t.path ?? [],
    });
  const savedHere = journey ? trips.find(journey.from, journey.to, custom ? query.path : undefined) : null;

  return (
    <section className="flex shrink-0 flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-rail px-4 py-2.5">
        <h3 className="flex-1 text-xl font-bold leading-tight condensed">Itinéraire</h3>
        <Button variant="ghost" size="icon-lg" className="rounded-full" onClick={onClose} aria-label="Fermer l'itinéraire">
          <X className="size-5" />
        </Button>
      </header>

      <div className="px-4 pb-6 pt-3">
        <div className="flex items-stretch gap-2">
          <div className="flex flex-col items-center py-3" aria-hidden>
            <span className="size-3 rounded-full border-[3px] border-ink bg-white" />
            <span className="my-1 w-0.5 flex-1 bg-rail" />
            <span className="size-3 rounded-full bg-signal ring-2 ring-signal/30" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <StationField
              label="Départ"
              value={from}
              onChange={(v) => onQuery({ ...query, from: v, path: [] })}
              exclude={to}
            />
            <StationField label="Arrivée" value={to} onChange={(v) => onQuery({ ...query, to: v })} exclude={from} />
          </div>
          <Button
            variant="ghost"
            size="icon-lg"
            className="self-center rounded-full"
            aria-label="Inverser départ et arrivée"
            title="Inverser départ et arrivée"
            disabled={!from && !to}
            onClick={() => onQuery({ ...query, from: to, to: from, path: [] })}
          >
            <ArrowUpDown className="size-5" />
          </Button>
        </div>

        {/* trajet calculé ou tracé à la main */}
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-tile p-1" role="tablist" aria-label="Mode">
          {[
            { c: false, text: "Trajets proposés", icon: <Sparkles className="size-4" /> },
            { c: true, text: "Tracer moi-même", icon: <Hand className="size-4" /> },
          ].map((m) => (
            <button
              key={m.text}
              role="tab"
              aria-selected={custom === m.c}
              onClick={() => onQuery({ ...query, custom: m.c })}
              className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium ${
                custom === m.c ? "bg-white shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              {m.icon}
              {m.text}
            </button>
          ))}
        </div>

        {custom && (
          <div className="mt-3 rounded-lg border border-rail px-3 py-2.5 text-sm">
            {!from ? (
              <p>Choisissez une station de départ, puis tracez le trajet sur la carte.</p>
            ) : reached ? (
              <p className="font-semibold text-emerald-700">Arrivé à {to} !</p>
            ) : (
              <p>
                <b>{query.path.length ? "Continuez" : `Partez de ${from}`}</b> : touchez une station sur la carte, ou glissez le
                doigt de station en station. Pour changer de ligne, touchez une station d'une ligne qui passe là où vous êtes.
                {to && <span className="text-ink-soft"> Arrivée : {to}.</span>}
              </p>
            )}
            {draw.error && <p className="mt-1.5 text-signal">{draw.error}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" className="gap-1.5" onClick={draw.undo} disabled={!draw.canUndo}>
                <Undo2 className="size-4" /> Annuler
              </Button>
              <Button size="sm" variant="secondary" className="gap-1.5" onClick={draw.clear} disabled={!query.path.length}>
                <Trash2 className="size-4" /> Effacer
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={draw.complete} disabled={!from || !to || reached}>
                <Sparkles className="size-4" /> Compléter jusqu'à l'arrivée
              </Button>
            </div>
          </div>
        )}

        {!custom && (
        <label className="mt-3 flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="font-medium">Éviter le trafic interrompu</span>
            <span className="block text-xs text-ink-soft">Contourne les stations touchées par une perturbation en cours.</span>
          </span>
          <Switch
            checked={query.avoidDisrupted}
            onCheckedChange={(v) => onQuery({ ...query, avoidDisrupted: v })}
          />
        </label>
        )}

        {ready && !journey && !custom && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-signal">
            Aucun trajet en métro ou RER trouvé{query.avoidDisrupted ? " en évitant les perturbations" : ""}.
          </p>
        )}

        {options.length > 1 && (
          <div className="mt-4" role="radiogroup" aria-label="Trajets possibles">
            <h4 className="mb-1.5 text-sm font-semibold">{options.length} trajets possibles</h4>
            <ul className="flex flex-col gap-1.5">
              {options.map((o, i) => (
                <li key={i}>
                  <OptionCard option={o} best={options[0].journey} active={i === choice} onClick={() => onChoice(i)} traffic={traffic} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {journey && (
          <JourneyView
            key={choice}
            journey={journey}
            now={now}
            traffic={traffic}
            saved={savedHere}
            incomplete={custom && !reached}
            onSave={(name) =>
              trips.save({
                name,
                from: journey.from,
                to: journey.to,
                avoidDisrupted: query.avoidDisrupted,
                path: custom ? query.path : undefined,
              })
            }
            onUnsave={(id) => trips.remove(id)}
          />
        )}

        <SavedList
          trips={trips.saved}
          current={journey}
          onLoad={load}
          onRename={trips.rename}
          onRemove={trips.remove}
        />

        {trips.recent.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                <History className="size-4" /> Récents
              </h4>
              <button className="text-xs text-ink-soft underline" onClick={trips.clearRecent}>
                Effacer
              </button>
            </div>
            <ul className="mt-1.5 flex flex-col">
              {trips.recent.map((r) => (
                <li key={`${r.from}|${r.to}`}>
                  <button
                    className="w-full truncate rounded px-1.5 py-1.5 text-left text-sm hover:bg-tile"
                    onClick={() => load(r)}
                  >
                    {r.from} <span className="text-ink-soft">→</span> {r.to}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** Champ de recherche de station avec suggestions (clavier : flèches, Entrée, Échap). */
function StationField({
  label: text,
  value,
  onChange,
  exclude,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  exclude: string | null;
}) {
  const [typed, setTyped] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setTyped(value ?? ""), [value]);

  const results = open ? searchPlaces(typed).filter((p) => p.name !== exclude) : [];
  const pick = (p: Place) => {
    onChange(p.name);
    setTyped(p.name);
    setOpen(false);
  };

  return (
    <div className="relative">
      <label className="sr-only" htmlFor={`${listId}-input`}>
        {text}
      </label>
      <Input
        ref={ref}
        id={`${listId}-input`}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={text === "Départ" ? "Station de départ" : "Station d'arrivée"}
        className="h-10 bg-white pr-8"
        value={typed}
        onFocus={(e) => {
          e.target.select();
          setOpen(true);
        }}
        onBlur={() => {
          // laisse le temps au clic sur une suggestion
          setTimeout(() => {
            setOpen(false);
            setTyped(value ?? "");
          }, 150);
        }}
        onChange={(e) => {
          setTyped(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(results.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            pick(results[active]);
            ref.current?.blur();
          } else if (e.key === "Escape") {
            setOpen(false);
            setTyped(value ?? "");
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-ink-soft hover:bg-tile"
          aria-label={`Effacer ${text.toLowerCase()}`}
          onClick={() => {
            onChange(null);
            setTyped("");
            ref.current?.focus();
          }}
        >
          <X className="size-4" />
        </button>
      )}
      {results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-white py-1 shadow-lg"
        >
          {results.map((p, i) => (
            <li
              key={p.name}
              role="option"
              aria-selected={i === active}
              className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm ${i === active ? "bg-tile" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
            >
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="flex shrink-0 gap-0.5">
                {p.stops.map((s) => (
                  <Roundel key={s.lineId} line={lineById(s.lineId)} size={18} />
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TAGS: Record<Option["tag"], string> = {
  fastest: "Le plus rapide",
  fewerTransfers: "Moins de correspondances",
  alternative: "",
};

/** Une variante : durée, lignes, stations de correspondance. */
function OptionCard({
  option,
  best,
  active,
  onClick,
  traffic,
}: {
  option: Option;
  best: Journey;
  active: boolean;
  onClick: () => void;
  traffic: Record<string, Disruption[]>;
}) {
  const j = option.journey;
  const n = j.legs.length - 1;
  const via = j.legs.slice(1).map((l) => lineById(l.lineId).stations[l.stations[0]].name);
  const extra = Math.round((j.seconds - best.seconds) / 60);
  const disrupted = j.legs.some((l) => legDisruptions(l, traffic).length > 0);
  return (
    <button
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`w-full rounded-lg border-2 px-3 py-2 text-left transition-colors ${
        active ? "border-ink bg-white" : "border-transparent bg-tile hover:bg-tile-deep"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg font-extrabold tabular-nums">{formatDuration(j.seconds)}</span>
        {extra > 0 && <span className="text-xs text-ink-soft">+{extra} min</span>}
        <span className="ml-auto flex items-center gap-1">
          {j.legs.map((l, i) => (
            <Roundel key={i} line={lineById(l.lineId)} size={22} />
          ))}
        </span>
      </div>
      <p className="mt-0.5 truncate text-xs text-ink-soft">
        {TAGS[option.tag] && <b className="mr-1 font-semibold text-ink">{TAGS[option.tag]} ·</b>}
        {n === 0 ? "Direct" : `${n} corresp. à ${via.join(", ")}`}
        {disrupted && <span className="ml-1 font-semibold text-signal">· perturbé</span>}
      </p>
    </button>
  );
}

/** Perturbations en cours qui touchent les stations d'un tronçon. */
const legDisruptions = (leg: Leg, traffic: Record<string, Disruption[]>) =>
  (traffic[leg.lineId] ?? []).filter(
    (d) => d.active && d.severity !== "INFORMATION" && (d.wholeLine || d.stations.some((s) => leg.stations.includes(s))),
  );

function JourneyView({
  journey,
  now,
  traffic,
  saved,
  onSave,
  onUnsave,
  incomplete = false,
}: {
  journey: Journey;
  now: number;
  traffic: Record<string, Disruption[]>;
  saved: SavedTrip | null;
  /** trajet tracé qui n'atteint pas encore l'arrivée */
  incomplete?: boolean;
  onSave: (name: string) => void;
  onUnsave: (id: string) => void;
}) {
  const first = journey.legs[0];
  const next = useNextDeparture(first);
  const [naming, setNaming] = useState<string | null>(null);
  const wait = next?.expectedMs != null ? Math.max(0, next.expectedMs - now) : 0;
  const arrival = now + wait + journey.seconds * 1000;
  const nTransfers = journey.legs.length - 1;

  return (
    <div className="mt-4">
      <div className="flex items-start gap-3 rounded-lg bg-tile px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-extrabold leading-none tabular-nums">{formatDuration(journey.seconds)}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {nTransfers === 0 ? "Direct" : `${nTransfers} correspondance${nTransfers > 1 ? "s" : ""}`} ·{" "}
            {incomplete ? "trajet en cours de tracé" : (
              <>
                arrivée vers <b className="font-semibold text-ink">{clock(arrival)}</b>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {journey.legs.map((l, i) => (
            <Roundel key={i} line={lineById(l.lineId)} size={26} />
          ))}
        </div>
      </div>

      {/* enregistrement */}
      <div className="mt-2">
        {incomplete ? null : saved ? (
          <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => onUnsave(saved.id)}>
            <Star className="size-4 fill-amber-400 text-amber-500" /> Enregistré : {saved.name}
          </Button>
        ) : naming === null ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setNaming(defaultTripName(journey.from, journey.to))}
          >
            <Star className="size-4" /> Enregistrer ce trajet
          </Button>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onSave(naming.trim() || defaultTripName(journey.from, journey.to));
              setNaming(null);
            }}
          >
            <Input
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onFocus={(e) => e.target.select()}
              aria-label="Nom du trajet"
              placeholder="Domicile → Travail"
              className="h-8"
            />
            <Button type="submit" size="sm">
              Enregistrer
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(null)}>
              Annuler
            </Button>
          </form>
        )}
      </div>

      {/* étapes */}
      <ol className="mt-4">
        {journey.walkStart && (
          <li className="mb-2 flex items-center gap-2 pl-[7px] text-sm text-ink-soft">
            <Footprints className="size-4" />
            À pied de {journey.from} à {journey.walkStart.to}, environ {formatDuration(journey.walkStart.seconds)}
          </li>
        )}
        {journey.legs.map((leg, i) => {
          const end = lineById(leg.lineId).stations[leg.stations[leg.stations.length - 1]].name;
          const after = journey.legs[i + 1];
          const nextStart = after && lineById(after.lineId).stations[after.stations[0]].name;
          return (
            <li key={i}>
              <LegView leg={leg} next={i === 0 ? next : null} now={now} disruptions={legDisruptions(leg, traffic)} />
              {i < journey.transfers.length && (
                <p className="my-1 flex items-center gap-2 pl-[7px] text-sm text-ink-soft">
                  <Footprints className="size-4" />
                  {after.lineId === leg.lineId
                    ? `Changement de train à ${end}`
                    : nextStart !== end
                      ? `Correspondance à pied de ${end} à ${nextStart}`
                      : `Correspondance à ${end}`}
                  , environ {formatDuration(journey.transfers[i])}
                </p>
              )}
            </li>
          );
        })}
        {journey.walkEnd && !incomplete && (
          <li className="mt-2 flex items-center gap-2 pl-[7px] text-sm text-ink-soft">
            <Footprints className="size-4" />
            À pied de {journey.walkEnd.from} à {journey.to}, environ {formatDuration(journey.walkEnd.seconds)}
          </li>
        )}
      </ol>
      <p className="mt-3 text-xs text-ink-soft">
        Durées estimées d'après les horaires théoriques (GTFS IDFM), attente moyenne de 2 min par correspondance.
      </p>
    </div>
  );
}

function LegView({
  leg,
  next,
  now,
  disruptions,
}: {
  leg: Leg;
  next: Departure | null | undefined;
  now: number;
  disruptions: Disruption[];
}) {
  const line = lineById(leg.lineId);
  const [open, setOpen] = useState(false);
  const names = leg.stations.map((s) => line.stations[s].name);
  const stops = leg.stations.length - 1;
  return (
    <div className="flex gap-3">
      <div className="flex w-4 flex-col items-center" aria-hidden>
        <span className="mt-1.5 size-3.5 shrink-0 rounded-full border-[3px] bg-white" style={{ borderColor: line.color }} />
        <span className="w-1.5 flex-1 rounded-full" style={{ background: line.color }} />
        <span className="mb-1.5 size-3.5 shrink-0 rounded-full border-[3px] bg-white" style={{ borderColor: line.color }} />
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="font-semibold">{names[0]}</p>
        <div className="my-1.5 flex items-center gap-2">
          <Roundel line={line} size={24} />
          <span className="min-w-0 text-sm">
            {lineTitle(line)} vers <b className="font-semibold">{leg.headsigns.join(" ou ") || names[names.length - 1]}</b>
          </span>
        </div>
        {next !== undefined && (
          <p className="mb-1 flex items-center gap-1.5 text-sm">
            <Clock className="size-4 text-ink-soft" />
            {next === null ? (
              <span className="text-ink-soft">Aucun passage annoncé</span>
            ) : next.atStop || (next.expectedMs ?? 0) <= now ? (
              <b>Train à quai</b>
            ) : (
              <span>
                Prochain train dans <b>{Math.floor(((next.expectedMs ?? now) - now) / 60000)} min</b>
                {next.status === "prévu" && <span className="text-ink-soft"> (horaire prévu)</span>}
              </span>
            )}
          </p>
        )}
        {disruptions.map((d) => (
          <p key={d.id} className="mb-1.5 rounded border-l-4 border-signal bg-red-50 px-2 py-1 text-xs">
            <span className="font-semibold">{cleanTitle(d.title)}</span>
            <span className="block text-ink-soft">{formatWhen(d)}</span>
          </p>
        ))}
        <button className="text-sm text-ink-soft underline" onClick={() => setOpen(!open)} aria-expanded={open}>
          {stops} arrêt{stops > 1 ? "s" : ""} · {formatDuration(leg.seconds)}
        </button>
        {open && (
          <ul className="mt-1 text-sm text-ink-soft">
            {names.slice(1, -1).map((n, k) => (
              <li key={k} className="py-0.5">
                {n}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 font-semibold">{names[names.length - 1]}</p>
      </div>
    </div>
  );
}

/**
 * Prochain train au départ du premier tronçon, dans le bon sens.
 * `undefined` pendant le chargement, `null` si rien d'annoncé.
 * Une requête PRIM toutes les 60 s seulement (quota journalier).
 */
function useNextDeparture(leg: Leg | undefined) {
  const [deps, setDeps] = useState<Departure[] | null | undefined>(undefined);
  const lineId = leg?.lineId;
  const station = leg?.stations[0];
  const heads = leg?.headsigns.map(normalize) ?? [];
  useEffect(() => {
    if (!lineId || station === undefined) return;
    let alive = true;
    setDeps(undefined);
    const load = () =>
      api
        .departures(lineId, station)
        .then((d) => alive && setDeps(d))
        .catch(() => alive && setDeps(null));
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [lineId, station]);
  if (deps === undefined) return undefined;
  if (deps === null) return null;
  const now = Date.now();
  // le terminus annoncé doit être l'un de ceux du tronçon (branches comprises)
  const match = deps
    .filter((d) => (d.expectedMs ?? 0) > now - 30_000)
    .filter((d) => heads.some((h) => normalize(d.destination).includes(h) || h.includes(normalize(d.destination))));
  return match[0] ?? null;
}

function SavedList({
  trips,
  current,
  onLoad,
  onRename,
  onRemove,
}: {
  trips: SavedTrip[];
  current: Journey | null;
  onLoad: (t: SavedTrip) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  if (trips.length === 0)
    return (
      <p className="mt-5 rounded-md border border-dashed border-rail px-3 py-2.5 text-sm text-ink-soft">
        Enregistrez vos trajets habituels (domicile, travail…) pour les retrouver en un clic.
      </p>
    );
  return (
    <div className="mt-5">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        <Star className="size-4" /> Mes trajets
      </h4>
      <ul className="mt-1.5 flex flex-col gap-1">
        {trips.map((t) => {
          const isCurrent = current?.from === t.from && current?.to === t.to;
          if (editing?.id === t.id)
            return (
              <li key={t.id}>
                <form
                  className="flex gap-2 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onRename(t.id, editing.name.trim() || defaultTripName(t.from, t.to));
                    setEditing(null);
                  }}
                >
                  <Input
                    autoFocus
                    value={editing.name}
                    onChange={(e) => setEditing({ id: t.id, name: e.target.value })}
                    aria-label="Nouveau nom"
                    className="h-8"
                  />
                  <Button type="submit" size="sm">
                    OK
                  </Button>
                </form>
              </li>
            );
          return (
            <li
              key={t.id}
              className={`group flex items-center gap-1 rounded-lg px-1.5 py-1 ${isCurrent ? "bg-accent" : "hover:bg-tile"}`}
            >
              <button className="min-w-0 flex-1 text-left" onClick={() => onLoad(t)}>
                <span className="block truncate text-sm font-semibold">{t.name}</span>
                <span className="flex items-center gap-1 truncate text-xs text-ink-soft">
                  {t.path?.length ? <Hand className="size-3 shrink-0" aria-label="tracé à la main" /> : null}
                  {t.from} → {t.to}
                </span>
              </button>
              <IconBtn label="Trajet retour" onClick={() => onLoad({ ...t, from: t.to, to: t.from, path: t.path ? [...t.path].reverse() : undefined })}>
                <RotateCcw className="size-4" />
              </IconBtn>
              <IconBtn label="Renommer" onClick={() => setEditing({ id: t.id, name: t.name })}>
                <Pencil className="size-4" />
              </IconBtn>
              <IconBtn label="Supprimer" onClick={() => onRemove(t.id)}>
                <Trash2 className="size-4" />
              </IconBtn>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IconBtn({
  label: text,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-white hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}
