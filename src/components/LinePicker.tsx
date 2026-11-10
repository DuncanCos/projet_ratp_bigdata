import { Fragment } from "react";
import { Disruption, worstActive } from "../lib/api";
import { Line, isRer, lineTitle } from "../lib/metro";
import { Roundel } from "./Roundel";

interface Props {
  /** lignes affichées (choisies dans le tiroir) */
  lines: Line[];
  focused: string | null;
  counts: Record<string, number>;
  traffic: Record<string, Disruption[]>;
  onFocus: (id: string | null) => void;
  /** barre horizontale défilante (téléphone) au lieu de la colonne */
  horizontal?: boolean;
}

/** Choix de la ligne : colonne à gauche sur ordinateur, bandeau défilant sur téléphone. */
export function LinePicker({ lines, focused, counts, traffic, onFocus, horizontal }: Props) {
  return (
    <nav
      aria-label="Lignes"
      className={
        horizontal
          ? "flex items-center gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]"
          : "flex w-[76px] shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-rail bg-white py-3"
      }
    >
      <button
        onClick={() => onFocus(null)}
        aria-pressed={focused === null}
        className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold condensed ${
          focused === null ? "bg-ink text-white" : "bg-white text-ink-soft hover:bg-tile"
        } ${horizontal ? "" : "mb-2"}`}
      >
        Réseau
      </button>
      {lines.map((l, i) => {
        const active = focused === l.id;
        // petit séparateur entre métro et RER
        const first = isRer(l) && (i === 0 || !isRer(lines[i - 1]));
        const worst = worstActive(traffic[l.id]);
        return (
          <Fragment key={l.id}>
          {first && i > 0 && (
            <span aria-hidden className={horizontal ? "mx-1 h-6 w-px shrink-0 bg-rail" : "my-1.5 h-px w-10 shrink-0 bg-rail"} />
          )}
          <button
            onClick={() => onFocus(active ? null : l.id)}
            aria-pressed={active}
            title={worst ? `${lineTitle(l)} : ${worst.title}` : `${lineTitle(l)}, ${counts[l.id] ?? 0} trains`}
            className={`relative flex shrink-0 flex-col items-center rounded-lg p-1 ${
              active ? "bg-ink/10" : "hover:bg-tile"
            } ${horizontal ? "" : "w-14 py-1.5"}`}
          >
            <Roundel line={l} size={horizontal ? 34 : 32} dim={focused !== null && !active} />
            {!horizontal && <span className="mt-0.5 text-[11px] text-ink-soft">{counts[l.id] ?? 0}</span>}
            {worst && (
              <span
                className={`absolute right-0.5 top-0.5 h-3 w-3 rounded-full ring-2 ring-white ${
                  worst.severity === "BLOQUANTE" ? "bg-signal" : "bg-amber-500"
                }`}
              >
                <span className="sr-only">{worst.severity === "BLOQUANTE" ? "trafic interrompu" : "trafic perturbé"}</span>
              </span>
            )}
          </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
