import { useEffect, useState } from "react";
import { Disruption, Train, disruptedStations, progress } from "../lib/api";
import { TrafficList } from "./TrafficList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Line, branchName, branches, isRer, lineTitle } from "../lib/metro";
import { Roundel } from "./Roundel";
import { LineFrequentation } from "./Frequentation";
import { useApi } from "./data/kit";
import { entier } from "@/lib/dataApi";
import { LigneResume, zdc } from "@/lib/frequentation";

const ROW = 38;

interface Props {
  line: Line;
  trains: Train[];
  disruptions: Disruption[] | null;
  live: boolean;
  now: number;
  selected: number | null;
  onStation: (index: number) => void;
}

/** Plan de ligne vertical : voie de gauche = sens descendant, voie de droite = sens montant. */
export function StripMap({ line, trains, disruptions, live, now, selected, onStation }: Props) {
  const bs = branches(line);
  const [b, setB] = useState(0);
  useEffect(() => setB(0), [line.id]);
  const pattern = bs[Math.min(b, bs.length - 1)];
  const order = pattern.stations;
  const pos = new Map(order.map((s, i) => [s, i]));
  const terminusDown = line.stations[order[order.length - 1]].name;

  const placed = trains.flatMap((t) => {
    const i = pos.get(t.from);
    const j = pos.get(t.to);
    if (i === undefined || j === undefined) return [];
    let down: boolean;
    if (i !== j) down = j > i;
    else {
      const after = t.nextStops.map((n) => pos.get(n.station)).find((k) => k !== undefined && k !== i);
      down = after !== undefined ? after > i : t.destination === terminusDown;
    }
    const y = (i + (j - i) * progress(t, now)) * ROW + ROW / 2;
    return [{ t, y, down }];
  });
  const nDown = placed.filter((p) => p.down).length;
  const hit = disruptedStations(disruptions ?? undefined);
  // volet données : validations par jour de chaque station (absent si l'API de données est arrêtée)
  const { data: resume } = useApi<LigneResume>(`/api/lignes/${line.id}/resume`);
  const affluence = (s: number) => resume?.stations[zdc(line.stations[s])] ?? null;
  const affluenceMax = Math.max(1, ...order.map((s) => affluence(s) ?? 0));

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-rail px-4 py-3">
        <Roundel line={line} size={40} />
        <div className="min-w-0">
          <h2 className="text-lg font-bold leading-tight">{lineTitle(line)}</h2>
          <p className="text-sm text-ink-soft">
            {live ? (
              <>
                {trains.length} trains en direct, dont {trains.filter((t) => t.atStation).length} à quai
              </>
            ) : (
              <>{trains.length} trains d'après les horaires prévus (pas de temps réel)</>
            )}
            {bs.length > 1 ? ` (${placed.length} sur cette branche)` : ""}
          </p>
        </div>
      </header>
      <LineFrequentation line={line} resume={resume} />
      {disruptions && (
        <div className="border-b border-rail">
          <TrafficList disruptions={disruptions} />
        </div>
      )}
      {bs.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2" role="tablist">
          {bs.map((p, i) => (
            <Button
              key={i}
              role="tab"
              aria-selected={i === b}
              size="sm"
              variant={i === b ? "default" : "secondary"}
              onClick={() => setB(i)}
              className="condensed"
            >
              {isRer(line) ? branchName(line, p, bs) : `Branche ${branchName(line, p, bs)}`}
            </Button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[1fr_auto] border-b border-rail px-4 py-1.5 text-xs text-ink-soft">
        <span>
          ↓ {nDown} vers {terminusDown} &nbsp; ↑ {placed.length - nDown} vers {line.stations[order[0]].name}
        </span>
        {resume && <span>validations par jour</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        <div className="relative" style={{ height: order.length * ROW }}>
          {/* voies */}
          {[14, 34].map((x) => (
            <div key={x} className="absolute top-0 w-1 rounded" style={{ left: x, height: order.length * ROW, background: line.color, opacity: 0.85 }} />
          ))}
          {order.map((s, i) => {
            const st = line.stations[s];
            const sel = selected === s;
            const end = i === 0 || i === order.length - 1;
            return (
              <button
                key={s}
                onClick={() => onStation(s)}
                className={`absolute left-0 right-0 flex items-center gap-3 rounded text-left ${sel ? "bg-white shadow-[0_0_0_1px_var(--color-rail)]" : "hover:bg-white/60"}`}
                style={{ top: i * ROW, height: ROW }}
              >
                <span className="relative block w-12 self-stretch">
                  <span
                    className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full border-2 bg-white"
                    style={{ left: 10, width: 32, borderColor: "var(--color-ink)" }}
                  />
                </span>
                <span
                  className={`truncate condensed ${end ? "font-bold" : "font-medium"} ${
                    hit.has(s) ? "text-signal line-through decoration-2" : ""
                  }`}
                >
                  {st.name}
                </span>
                {hit.has(s) ? (
                  <Badge variant="destructive" className="ml-auto mr-2 shrink-0">
                    perturbé
                  </Badge>
                ) : (
                  affluence(s) != null && (
                    <span
                      className="ml-auto mr-1 flex w-16 shrink-0 justify-end"
                      title={`${entier(affluence(s)!)} validations par jour en moyenne`}
                    >
                      <span className="h-1.5 rounded-full bg-ink-soft/60" style={{ width: `${Math.max(4, (affluence(s)! / affluenceMax) * 100)}%` }} />
                    </span>
                  )
                )}
              </button>
            );
          })}
          {placed.map(({ t, y, down }) => (
            <div
              key={t.id}
              title={`Vers ${t.destination}${t.atStation ? ", à quai" : ""}`}
              className="pointer-events-none absolute flex h-5 w-4 items-center justify-center rounded-sm border-2 text-[9px] font-black transition-[top] duration-500 ease-linear"
              style={{
                top: y - 10,
                left: down ? 8 : 28,
                background: line.color,
                color: line.textColor,
                borderColor: "var(--color-ink)",
              }}
            >
              {down ? "▼" : "▲"}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
