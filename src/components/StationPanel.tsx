import { useEffect, useState } from "react";
import { Departure, Disruption, api, cleanTitle, formatWhen, minutesUntil } from "../lib/api";
import { Access, Line, lineById, lineTitle } from "../lib/metro";
import { Roundel } from "./Roundel";
import { StationFrequentation } from "./Frequentation";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Flag, MapPin } from "lucide-react";

interface Props {
  line: Line;
  index: number;
  now: number;
  disruptions: Disruption[];
  onSelectStation: (lineId: string, index: number) => void;
  onClose: () => void;
  /** choisir cette station comme départ ou arrivée d'un itinéraire */
  onTripEnd?: (end: "from" | "to", stationName: string) => void;
  /** libellé du bouton retour */
  backLabel?: string;
}

export function StationPanel({ line, index, now, disruptions, onSelectStation, onClose, onTripEnd, backLabel }: Props) {
  const station = line.stations[index];
  const [deps, setDeps] = useState<Departure[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDeps(null);
    setError(null);
    const load = () =>
      api
        .departures(line.id, index)
        .then((d) => alive && (setDeps(d), setError(null)))
        .catch((e) => alive && setError(String(e)));
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [line.id, index]);

  // regroupement par destination
  const groups = new Map<string, Departure[]>();
  deps?.filter((d) => (d.expectedMs ?? 0) > now - 30_000).forEach((d) => {
    const g = groups.get(d.destination) ?? [];
    g.push(d);
    groups.set(d.destination, g);
  });

  return (
    <section className="flex shrink-0 flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-rail px-3 py-2.5">
        <Button variant="ghost" size="icon-lg" className="rounded-full" onClick={onClose} aria-label={backLabel ?? `Retour au ${lineTitle(line)}`}>
          <ChevronLeft className="size-5" />
        </Button>
        <Roundel line={line} size={32} />
        <div className="min-w-0">
          <h3 className="truncate text-xl font-bold leading-tight condensed">{station.name}</h3>
          <p className="text-sm text-ink-soft">
            Prochains passages{deps?.length ? (deps[0].status === "prévu" ? " · horaires prévus" : " · temps réel") : ""}
          </p>
        </div>
      </header>
      <div className="px-4 pb-6 pt-3">
        {onTripEnd && (
          <div className="mb-3 flex gap-2">
            <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => onTripEnd("from", station.name)}>
              <MapPin className="size-4" /> Partir d'ici
            </Button>
            <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => onTripEnd("to", station.name)}>
              <Flag className="size-4" /> Y aller
            </Button>
          </div>
        )}
        {disruptions
          .filter((d) => d.active && d.stations.includes(index))
          .map((d) => (
            <p key={d.id} className="mb-2 rounded border-l-4 border-signal bg-red-50 px-2 py-1.5 text-sm">
              <span className="font-semibold">{cleanTitle(d.title)}</span>
              <span className="block text-xs text-ink-soft">{formatWhen(d)}</span>
            </p>
          ))}
        {error && <p className="text-sm text-signal">{error}</p>}
        {!error && deps === null && <p className="text-sm text-ink-soft">Chargement…</p>}
        {deps && groups.size === 0 && <p className="text-sm text-ink-soft">Aucun passage annoncé pour le moment.</p>}
        {[...groups].map(([dest, ds]) => (
          <div key={dest} className="mt-2">
            <p className="text-sm font-semibold">Vers {dest || "destination inconnue"}</p>
            <ol className="mt-1 flex gap-2">
              {ds.slice(0, 4).map((d, i) => (
                <li
                  key={i}
                  className={`rounded px-2 py-1 text-sm font-bold ${i === 0 ? "bg-ink text-white" : "bg-tile"}`}
                >
                  {d.atStop ? "à quai" : minutesUntil(d.expectedMs, now)}
                </li>
              ))}
            </ol>
          </div>
        ))}

        {(station.transfers.length > 0 || station.connections.length > 0) && (
          <div className="mt-4 border-t border-rail pt-3">
            <h4 className="text-sm font-semibold">Correspondances</h4>
            <ul className="mt-1.5 flex flex-col gap-1">
              {station.transfers.map((t) => {
                const other = lineById(t.lineId);
                return (
                  <li key={t.lineId}>
                    <button
                      onClick={() => onSelectStation(t.lineId, t.station)}
                      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-tile"
                      title={`Afficher le ${lineTitle(other)} à ${other.stations[t.station].name}`}
                    >
                      <Roundel line={other} size={22} />
                      <span>
                        {lineTitle(other)}
                        {/* correspondance à pied vers une autre gare (Châtelet / Châtelet - Les Halles) */}
                        {other.stations[t.station].name !== station.name && (
                          <span className="text-ink-soft"> · {other.stations[t.station].name}</span>
                        )}
                      </span>
                      <Walk minutes={t.minutes} />
                    </button>
                  </li>
                );
              })}
              {station.connections.map((c) => (
                <li key={`${c.mode}-${c.name}`} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                  <span
                    className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded px-1 text-xs font-bold"
                    style={{ background: c.color, color: c.textColor }}
                  >
                    {c.name}
                  </span>
                  <span>{c.mode === "Train" ? (c.name === "TER" ? "TER" : `Transilien ${c.name}`) : `${c.mode} ${c.name}`}</span>
                  <Walk minutes={c.minutes} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <StationFrequentation key={station.id} line={line} station={station} />

        <div className="mt-4 border-t border-rail pt-3">
          <h4 className="text-sm font-semibold">Accessibilité</h4>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-ink-soft">Fauteuil roulant</dt>
            <dd><AccessValue value={station.access.wheelchair} partial="sur une partie des quais" /></dd>
            <dt className="text-ink-soft">Annonces sonores</dt>
            <dd><AccessValue value={station.access.audible} partial="sur une partie des quais" /></dd>
            <dt className="text-ink-soft">Annonces visuelles</dt>
            <dd><AccessValue value={station.access.visual} partial="sur une partie des quais" /></dd>
          </dl>
        </div>
      </div>
    </section>
  );
}

function Walk({ minutes }: { minutes: number | null }) {
  if (minutes == null) return null;
  return (
    <span className="ml-auto text-xs text-ink-soft" title="Temps de correspondance indiqué par IDFM">
      {minutes} min à pied
    </span>
  );
}

function AccessValue({ value, partial }: { value: Access; partial: string }) {
  if (value === "yes") return <span className="font-semibold text-emerald-700">Oui</span>;
  if (value === "partial") return <span className="font-semibold text-amber-700">Partiellement, {partial}</span>;
  if (value === "no") return <span className="font-semibold text-signal">Non</span>;
  return <span className="text-ink-soft">Non renseigné</span>;
}
