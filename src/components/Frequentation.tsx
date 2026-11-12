import { BarChart3 } from "lucide-react";
import { compact, entier, pct } from "@/lib/dataApi";
import { LigneResume, StationResume, dataHref, zdc } from "@/lib/frequentation";
import { Line, Station } from "@/lib/metro";
import { useApi } from "./data/kit";

const lien = "inline-flex items-center gap-1.5 text-sm font-semibold underline underline-offset-2 hover:no-underline";
const TYPES: Record<string, string> = {
  JOHV: "un jour ouvré", JOVS: "un jour ouvré de vacances", SAHV: "un samedi", SAVS: "un samedi de vacances", DIJFP: "un dimanche ou jour férié",
};

/** Fréquentation d'une ligne, sous l'en-tête du plan de ligne. Rien si l'API de données est arrêtée. */
export function LineFrequentation({ line, resume }: { line: Line; resume: LigneResume | null }) {
  if (!resume) return null;
  const pts = resume.semaines.map((s) => s.moyenne);
  const max = Math.max(...pts, 1);
  const W = 120, H = 34;
  const path = pts.map((v, i) => `${i ? "L" : "M"}${((i / Math.max(pts.length - 1, 1)) * W).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`).join("");
  return (
    <div className="border-b border-rail px-4 py-3">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-ink-soft">Validations par jour dans les stations de la ligne</p>
          <p className="condensed text-2xl font-bold leading-tight">
            {compact(resume.moyenne_jour)}
            {resume.evolution != null && (
              <span className="ml-2 text-sm font-semibold text-ink-soft">
                {resume.evolution >= 0 ? "▲" : "▼"} {pct(Math.abs(resume.evolution))} en un an
              </span>
            )}
          </p>
        </div>
        <svg width={W} height={H} className="shrink-0" role="img" aria-label="Évolution sur les 12 derniers mois publiés">
          <path d={path} fill="none" stroke="var(--color-ink)" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        {resume.prevu_aujourdhui != null && (
          <span>
            Aujourd'hui : <span className="font-semibold">{compact(resume.prevu_aujourdhui)}</span> prévues
          </span>
        )}
        <a href={dataHref({ ligne: line.id })} className={lien}>
          <BarChart3 className="size-4" /> Données de la ligne
        </a>
      </p>
    </div>
  );
}

/** Fréquentation d'une station, dans son panneau : niveau habituel, prédiction, heures chargées. */
export function StationFrequentation({ line, station }: { line: Line; station: Station }) {
  const { data } = useApi<StationResume>(`/api/stations/${zdc(station)}/resume`, { nom: station.name });
  if (!data) return null;
  const heure = new Date().getHours();
  const max = Math.max(...data.profil.map((p) => p.pourcentage), 1);
  const [auj, demain] = data.previsions;
  const ecart = auj ? auj.prevu / data.moyenne_jour - 1 : null;
  return (
    <div className="mt-4 border-t border-rail pt-3">
      <h4 className="text-sm font-semibold">Fréquentation</h4>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-soft">En moyenne</dt>
        <dd>
          <span className="font-semibold">{entier(data.moyenne_jour)}</span> validations par jour, {data.rang}
          <sup>e</sup> sur {data.nb_stations}
        </dd>
        {auj && (
          <>
            <dt className="text-ink-soft">Aujourd'hui</dt>
            <dd>
              <span className="font-semibold">{entier(auj.prevu)}</span> prévues
              {ecart != null && Math.abs(ecart) >= 0.05 && <span className="text-ink-soft"> ({pct(ecart, true)} par rapport à la moyenne)</span>}
            </dd>
          </>
        )}
        {demain && (
          <>
            <dt className="text-ink-soft">Demain</dt>
            <dd><span className="font-semibold">{entier(demain.prevu)}</span> prévues</dd>
          </>
        )}
      </dl>
      {data.profil.length > 0 && (
        <figure className="mt-3">
          <div className="flex h-14 items-end gap-px" role="img" aria-label="Répartition des validations dans la journée">
            {Array.from({ length: 24 }, (_, h) => {
              const p = data.profil.find((x) => x.heure === h)?.pourcentage ?? 0;
              return (
                <span
                  key={h}
                  title={`De ${h} h à ${h + 1} h : ${p.toFixed(1).replace(".", ",")} % des validations`}
                  className="flex-1 rounded-t-sm"
                  style={{ height: `${Math.max(2, (p / max) * 100)}%`, background: h === heure ? "var(--color-ink)" : "var(--color-rail)" }}
                />
              );
            })}
          </div>
          <div className="mt-0.5 flex justify-between text-[11px] text-ink-soft">
            <span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>23 h</span>
          </div>
          <figcaption className="mt-1 text-xs text-ink-soft">
            Entrées heure par heure {TYPES[data.type_jour ?? ""] ?? ""}. En foncé : maintenant.
          </figcaption>
        </figure>
      )}
      <a href={dataHref({ ligne: line.id, station: data.id_zdc })} className={`${lien} mt-3`}>
        <BarChart3 className="size-4" /> Données de la station
      </a>
    </div>
  );
}
