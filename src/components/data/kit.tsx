import { ReactNode, useEffect, useState } from "react";
import { LigneRef, Params, get, url } from "@/lib/dataApi";

/** Couleurs des graphiques : palette catégorielle validée (daltonisme), encre et grille du projet. */
export const C = {
  bleu: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", jaune: "#eda100", magenta: "#e87ba4", vert: "#008300",
  gris: "#9aa3a0", encre: "#1d2733", doux: "#5b6672", grille: "#dfe4e1",
};
export const AXE = { tick: { fill: C.doux, fontSize: 12 }, axisLine: false, tickLine: false } as const;

export function useApi<T>(path: string | null, params: Params = {}) {
  const key = path ? url(path, params) : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  useEffect(() => {
    if (!key || !path) return;
    const ctl = new AbortController();
    get<T>(path, params, ctl.signal)
      .then((data) => setState({ key, data, error: null }))
      .catch((e) => {
        if (e.name !== "AbortError") setState({ key, data: null, error: e instanceof TypeError ? "API injoignable" : e.message });
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = state.key === key;
  // on garde les données précédentes pendant le chargement : pas de saut de mise en page
  return { data: key ? state.data : null, error: fresh ? state.error : null, loading: !!key && !fresh };
}

export function Card({ title, hint, children, className = "", loading = false }: {
  title: string; hint?: ReactNode; children: ReactNode; className?: string; loading?: boolean;
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-border bg-white p-4 ${className}`}>
      <h3 className="text-[15px] font-semibold leading-tight">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-ink-soft">{hint}</p>}
      <div className={`mt-3 transition-opacity ${loading ? "opacity-50" : ""}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-xl border border-border bg-white px-4 py-3">
      <div className="text-xs text-ink-soft">{label}</div>
      <div className="condensed mt-0.5 text-[26px] font-bold leading-tight">{value}</div>
      {sub && (
        <div className="mt-0.5 text-xs text-ink-soft">
          {tone && <span aria-hidden>{tone === "up" ? "▲ " : "▼ "}</span>}
          {sub}
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-40 items-center justify-center px-4 text-center text-sm text-ink-soft">{children}</div>;
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <svg width="16" height="8" aria-hidden>
            <line x1="0" y1="4" x2="16" y2="4" stroke={i.color} strokeWidth="3" strokeDasharray={i.dashed ? "4 3" : undefined} />
          </svg>
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Infobulle commune : titre puis une ligne par série (pastille de couleur, libellé, valeur). */
export function Tip({ active, payload, title, rows }: {
  active?: boolean;
  payload?: { payload: Record<string, unknown> }[];
  title: (p: any) => string;
  rows: (p: any) => { label: string; value: string; color?: string }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-white px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-semibold">{title(p)}</div>
      {rows(p).map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          {r.color && <span className="size-2 rounded-full" style={{ background: r.color }} />}
          <span className="text-ink-soft">{r.label}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Pastille de ligne à partir du référentiel (métro rond, autres modes carré arrondi). */
export function Pastille({ ligne, size = 20 }: { ligne: LigneRef; size?: number }) {
  const court = ligne.nom.replace(/^(METRO|RER|TRAIN|TRAM)\s+/, "");
  const rond = ligne.mode === "METRO";
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center font-bold leading-none"
      style={{
        minWidth: size, height: size, padding: rond ? 0 : "0 4px", borderRadius: rond ? size : size * 0.24,
        background: ligne.couleur, color: ligne.couleur_texte, fontSize: court.length > 2 ? size * 0.42 : size * 0.55,
      }}
      title={ligne.nom}
    >
      {court}
    </span>
  );
}

const MODES: Record<string, string> = { METRO: "Métro", RER: "RER", TRAIN: "Train", TRAM: "Tram", VAL: "Navette", CABLE: "Câble" };
export const nomLigne = (l: LigneRef) => {
  const court = l.nom.replace(/^(METRO|RER|TRAIN|TRAM)\s+/, "");
  return court === l.nom ? l.nom : `${MODES[l.mode] ?? l.mode} ${court}`;
};
