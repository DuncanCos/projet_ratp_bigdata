import { ArrowRight, ExternalLink } from "lucide-react";
import { AIRFLOW_URL, Chargement, DATA_API, Meta, dateCourte, dateLongue, entier, pct } from "@/lib/dataApi";
import { Card, Empty, Stat, useApi } from "./kit";

const ETAPES: [string, string][] = [
  ["Sources ouvertes", "Validations IDFM (archives 2015 à 2025, trimestres par API), gares et lignes, météo Open-Meteo, jours fériés, vacances scolaires"],
  ["Airflow", "5 DAGs : extraction, nettoyage, chargement, agrégats, modèle. Ils s'enchaînent par « assets »"],
  ["Parquet", "Zone nettoyée : un fichier par période, mêmes colonnes quel que soit le format d'origine"],
  ["Cassandra", "Une table par besoin de lecture : par station, par ligne, réseau, classements, prédictions"],
  ["API et web app", "FastAPI en lecture seule, puis ce tableau de bord"],
];

export function PipelineTab({ meta }: { meta: Meta }) {
  const ch = useApi<Chargement[]>("/api/pipeline");
  const rows = ch.data ?? [];
  const brutes = rows.reduce((s, r) => s + (r.lignes_brutes ?? 0), 0);
  const rejets = rows.reduce((s, r) => s + (r.lignes_rejetees ?? 0), 0);
  // un trimestre peut venir de l'archive et de l'API : en base il n'existe qu'une fois
  const chargees = [...new Map(rows.map((r) => [r.periode, r.lignes_chargees])).values()].reduce((s, n) => s + n, 0);

  return (
    <div className="grid gap-3">
      <Card title="Du fichier publié au graphique">
        <ol className="grid gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch">
          {ETAPES.map(([titre, texte], i) => (
            <li key={titre} className="contents">
              <div className="rounded-lg bg-tile px-3 py-2.5">
                <div className="text-sm font-semibold">{titre}</div>
                <p className="mt-1 text-xs leading-snug text-ink-soft">{texte}</p>
              </div>
              {i < ETAPES.length - 1 && <ArrowRight className="hidden size-4 self-center text-ink-soft lg:block" aria-hidden />}
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <a className="inline-flex items-center gap-1 font-medium underline underline-offset-2" href={AIRFLOW_URL} target="_blank" rel="noreferrer">
            Ouvrir Airflow <ExternalLink className="size-3.5" />
          </a>
          <a className="inline-flex items-center gap-1 font-medium underline underline-offset-2" href={`${DATA_API}/docs`} target="_blank" rel="noreferrer">
            Documentation de l'API <ExternalLink className="size-3.5" />
          </a>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Lignes lues dans les fichiers" value={entier(brutes)} sub={`${rows.length} fichiers`} />
        <Stat label="Lignes rejetées" value={entier(rejets)} sub={brutes ? `${pct(rejets / brutes)} : arrêt inconnu ou valeur illisible` : undefined} />
        <Stat label="Lignes station-jour en base" value={entier(chargees)} sub="après regroupement des titres" />
        <Stat label="Période couverte" value={meta.jour_min ? `${meta.jour_min.slice(0, 4)} à ${meta.jour_max!.slice(0, 4)}` : "—"} sub={meta.jour_max ? `jusqu'au ${dateLongue(meta.jour_max)}` : undefined} />
      </div>

      <Card title="Journal des chargements" hint="Une ligne par fichier source. Les chargements sont des upserts : rejouer un DAG ne duplique rien." loading={ch.loading}>
        {ch.error ? <Empty>{ch.error}</Empty> : (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-border text-left text-xs text-ink-soft">
                  <th className="py-1.5 font-medium">Période</th>
                  <th className="py-1.5 font-medium">Source</th>
                  <th className="py-1.5 font-medium">Jours couverts</th>
                  <th className="py-1.5 text-right font-medium">Lignes lues</th>
                  <th className="py-1.5 text-right font-medium">Rejetées</th>
                  <th className="py-1.5 text-right font-medium">Station-jour</th>
                  <th className="py-1.5 pl-6 font-medium">Chargé le</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.source + r.periode} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 font-medium">{r.periode}</td>
                    <td className="py-1.5 text-ink-soft">{r.source === "historique" ? "archive annuelle" : "API trimestre"}</td>
                    <td className="py-1.5 text-ink-soft">{dateLongue(r.jour_min)} au {dateLongue(r.jour_max)}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.lignes_brutes != null ? entier(r.lignes_brutes) : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.lignes_rejetees != null ? entier(r.lignes_rejetees) : "—"}</td>
                    <td className="py-1.5 text-right tabular-nums">{entier(r.lignes_chargees)}</td>
                    <td className="py-1.5 pl-6 text-ink-soft">{dateCourte(r.charge_le.slice(0, 10))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
