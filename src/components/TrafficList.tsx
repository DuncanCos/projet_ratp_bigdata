import { Disruption, cleanTitle, formatWhen } from "../lib/api";

const tone = (d: Disruption) =>
  d.severity === "BLOQUANTE"
    ? "border-signal bg-red-50"
    : d.severity === "PERTURBEE"
      ? "border-amber-500 bg-amber-50"
      : "border-rail bg-white";

function Item({ d }: { d: Disruption }) {
  return (
    <details className={`group rounded border-l-4 px-3 py-2 ${tone(d)}`}>
      <summary className="cursor-pointer list-none">
        <span className="block text-sm font-semibold leading-snug">{cleanTitle(d.title)}</span>
        <span className="block text-xs text-ink-soft">{formatWhen(d)}</span>
      </summary>
      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{d.message}</p>
    </details>
  );
}

/** Perturbations d'une ligne : en cours dépliées en tête, à venir regroupées. */
export function TrafficList({ disruptions }: { disruptions: Disruption[] }) {
  const active = disruptions.filter((d) => d.active);
  const upcoming = disruptions.filter((d) => !d.active);
  if (!disruptions.length) {
    return <p className="px-4 py-2 text-sm text-ink-soft">Trafic normal, aucune perturbation annoncée.</p>;
  }
  return (
    <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto px-3 py-2">
      {active.map((d) => (
        <Item key={d.id} d={d} />
      ))}
      {upcoming.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer px-1 py-1 text-ink-soft">
            {upcoming.length === 1 ? "1 perturbation prévue" : `${upcoming.length} perturbations prévues`} dans les 7 jours
          </summary>
          <div className="mt-1 flex flex-col gap-1.5">
            {upcoming.map((d) => (
              <Item key={d.id} d={d} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
