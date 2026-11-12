import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DATA_API, Modele, Prevision, compact, dateCourte, dateJour, dateLongue, entier, iso, pct } from "@/lib/dataApi";
import { AXE, C, Card, Empty, Legend, Stat, Tip, useApi } from "./kit";

const FIGURES: Record<string, string> = {
  "test_reseau.png": "Réseau entier sur la période de test",
  "predit_vs_reel.png": "Chaque point : une station, un jour",
  "importances.png": "Importance des variables",
  "erreur_jour_semaine.png": "Erreur selon le jour de la semaine",
};

export function PredictionTab({ station, nomStation }: { station: number | null; nomStation: string | null }) {
  const pred = useApi<Prevision[]>("/api/prediction", { station });
  const modele = useApi<Modele>("/api/modele");
  const auj = iso(new Date());

  const rows = pred.data ?? [];
  const futur = useMemo(() => rows.filter((r) => r.jour >= auj && r.prevu != null), [rows, auj]);
  const dernierReel = useMemo(() => rows.filter((r) => r.reel != null).slice(-1)[0]?.jour ?? null, [rows]);
  const test = useMemo(() => {
    const t = rows.filter((r) => r.reel != null && r.prevu != null);
    const err = t.reduce((s, r) => s + Math.abs(r.reel! - r.prevu!), 0);
    const tot = t.reduce((s, r) => s + r.reel!, 0);
    return t.length ? { n: t.length, wape: err / tot } : null;
  }, [rows]);

  const m = modele.data;
  return (
    <div className="grid gap-3 lg:grid-cols-6">
      <Card
        title={`Réel et prédit : ${nomStation ?? "réseau entier"}`}
        hint="Les validations sont publiées avec plusieurs mois de retard : le modèle comble l'intervalle, puis prédit 14 jours avec la météo prévue."
        className="lg:col-span-6"
        loading={pred.loading}
      >
        {pred.error ? <Empty>{pred.error}</Empty> : !pred.data ? <Empty>Chargement…</Empty> : (
          <>
            <Legend items={[{ label: "Réel (publié)", color: C.bleu }, { label: "Prédit par le modèle", color: C.orange, dashed: true }]} />
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={rows} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.grille} vertical={false} />
                <XAxis dataKey="jour" {...AXE} tickFormatter={dateCourte} minTickGap={56} />
                <YAxis {...AXE} tickFormatter={compact} width={52} domain={[0, "auto"]} />
                {futur.length > 0 && <ReferenceArea x1={futur[0].jour} x2={futur[futur.length - 1].jour} fill={C.orange} fillOpacity={0.08} label={{ value: "à venir", position: "insideTop", fill: C.doux, fontSize: 11 }} />}
                {dernierReel && <ReferenceLine x={dernierReel} stroke={C.doux} strokeDasharray="2 3" label={{ value: "dernier jour publié", position: "top", fill: C.doux, fontSize: 11 }} />}
                <Tooltip
                  cursor={{ stroke: C.doux, strokeWidth: 1 }}
                  content={<Tip
                    title={(p) => dateJour(p.jour) + (p.ferie ? ` · ${p.ferie}` : p.vacances ? " · vacances" : "")}
                    rows={(p) => [
                      ...(p.reel != null ? [{ label: "Réel", value: entier(p.reel), color: C.bleu }] : []),
                      ...(p.prevu != null ? [{ label: "Prédit", value: entier(p.prevu), color: C.orange }] : []),
                      ...(p.reel != null && p.prevu != null ? [{ label: "Écart", value: pct(p.prevu / p.reel - 1, true) }] : []),
                      ...(p.tmax != null ? [{ label: "Météo", value: `${Math.round(p.tmax)} °C, ${String(p.pluie_mm ?? 0).replace(".", ",")} mm` }] : []),
                    ]}
                  />}
                />
                <Line dataKey="reel" stroke={C.bleu} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line dataKey="prevu" stroke={C.orange} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            {test && (
              <p className="mt-2 text-xs text-ink-soft">
                Sur les {test.n} jours où réel et prédit sont connus, l'erreur moyenne est de {pct(test.wape)} des validations.
              </p>
            )}
          </>
        )}
      </Card>

      {futur.length > 0 && (
        <Card title="Les 14 prochains jours" hint="Prédiction et contexte utilisé par le modèle" className="lg:col-span-6">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-ink-soft">
                  <th className="py-1.5 font-medium">Jour</th>
                  <th className="py-1.5 text-right font-medium">Validations prédites</th>
                  <th className="py-1.5 pl-6 font-medium">Météo prévue</th>
                  <th className="py-1.5 font-medium">Calendrier</th>
                </tr>
              </thead>
              <tbody>
                {futur.map((r) => (
                  <tr key={r.jour} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5">{dateJour(r.jour)}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{entier(r.prevu!)}</td>
                    <td className="py-1.5 pl-6 text-ink-soft">
                      {r.tmax != null ? `${Math.round(r.tmax)} °C, ${(r.pluie_mm ?? 0) < 0.2 ? "sec" : `${String(r.pluie_mm).replace(".", ",")} mm de pluie`}` : "—"}
                    </td>
                    <td className="py-1.5 text-ink-soft">{r.ferie ?? r.vacances ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {modele.error ? <div className="lg:col-span-6"><Empty>{modele.error}</Empty></div> : m && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:col-span-6 lg:grid-cols-4">
            <Stat label="Erreur relative du modèle" value={pct(m.wape)} sub={`référence naïve : ${pct(m.wape_reference)}`} />
            <Stat label="Erreur moyenne par station et par jour" value={entier(m.mae)} sub={`référence naïve : ${entier(m.mae_reference)} validations`} />
            <Stat label="Gain sur la référence" value={pct(1 - m.wape / m.wape_reference)} sub="erreur en moins" />
            <Stat label="R² sur la période de test" value={m.r2.toFixed(3).replace(".", ",")} sub={`${entier(m.n_test)} couples station-jour`} />
          </div>

          <Card title="Ce qui compte le plus pour le modèle" hint="Hausse de l'erreur quand on brouille la variable (importance par permutation)" className="lg:col-span-3">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={m.importances.slice(0, 10)} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.grille} horizontal={false} />
                <XAxis type="number" {...AXE} tickFormatter={(v) => String(v).replace(".", ",")} />
                <YAxis type="category" dataKey="variable" {...AXE} width={190} />
                <Tooltip cursor={{ fill: C.grille, opacity: 0.5 }} content={<Tip title={(p) => p.variable} rows={(p) => [{ label: "Importance", value: p.importance.toFixed(4).replace(".", ",") }]} />} />
                <Bar dataKey="importance" fill={C.bleu} radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Comment il est construit" className="lg:col-span-3">
            <dl className="space-y-2 text-sm">
              {[
                ["Algorithme", "Gradient boosting sur histogrammes (scikit-learn)"],
                ["Cible", "Écart entre les validations du jour et le niveau habituel de la station ce jour de semaine"],
                ["Variables", "Calendrier, jours fériés et ponts, vacances scolaires, météo, type et position de la station"],
                ["Apprentissage", `du ${dateLongue(m.train_debut)} au ${dateLongue(m.train_fin)}, ${entier(m.n_train)} lignes`],
                ["Test", `du ${dateLongue(m.test_debut)} au ${dateLongue(m.test_fin)}, jamais vu pendant l'apprentissage`],
                ["Référence naïve", "Moyenne de la station pour ce jour de semaine, sur un an"],
                ["Version", `${m.modele}, entraîné le ${dateLongue(m.entraine_le.slice(0, 10))}`],
              ].map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-2">
                  <dt className="text-ink-soft">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          {m.figures.map((src) => (
            <Card key={src} title={FIGURES[src.split("/").pop()!] ?? src} hint="Figure produite par le DAG d'entraînement (matplotlib)" className="lg:col-span-3">
              <img src={`${DATA_API}${src}?v=${m.modele}`} alt={FIGURES[src.split("/").pop()!] ?? ""} className="mx-auto max-h-[420px] w-auto max-w-full" />
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
