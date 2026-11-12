import { useMemo } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Classe, Jour, Meta, Profil, compact, dateJour, dateLongue, dateMois, decale, entier, jourSemaine, pct } from "@/lib/dataApi";
import { AXE, C, Card, Empty, Legend, Pastille, Stat, Tip, useApi } from "./kit";

export interface Filtres {
  debut: string;
  fin: string;
  ligne: string | null;
  station: number | null;
  categorie: string | null;
  pas: "jour" | "semaine" | "mois";
}

const JOURS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const moyenne = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Couleur fixe par catégorie de titre : elle ne change pas quand un filtre retire des séries. */
const TITRES: [string, string][] = [
  ["Forfait Navigo", C.bleu], ["Imagine R", C.orange], ["Solidarité Transport", C.aqua], ["Forfaits courts", C.jaune],
  ["Améthyste", C.magenta], ["Autres titres", C.vert], ["Non défini", C.gris],
];
const TYPES_JOUR: [string, string, string][] = [
  ["JOHV", "Jour ouvré", C.bleu], ["SAHV", "Samedi", C.orange], ["DIJFP", "Dimanche et férié", C.aqua],
];

function bucket(jour: string, pas: Filtres["pas"]) {
  if (pas === "jour") return jour;
  if (pas === "mois") return `${jour.slice(0, 7)}-01`;
  return decale(jour, -jourSemaine(jour));
}

export function AnalyseTab({ f, meta, onStation }: { f: Filtres; meta: Meta; onStation: (id: number) => void }) {
  const scope = { ligne: f.station ? null : f.ligne, station: f.station, categorie: f.categorie };
  const cur = useApi<Jour[]>("/api/serie", { debut: f.debut, fin: f.fin, ...scope });
  // 364 jours avant : mêmes jours de la semaine, donc comparaison jour pour jour
  const avantPossible = meta.jour_min != null && decale(f.debut, -364) >= meta.jour_min;
  const prev = useApi<Jour[]>(avantPossible ? "/api/serie" : null, { debut: decale(f.debut, -364), fin: decale(f.fin, -364), ...scope });
  const top = useApi<Classe[]>("/api/classement", { debut: f.debut, fin: f.fin, ligne: f.ligne, limit: 12 });
  const titres = useApi<Record<string, number | string>[]>(f.ligne && !f.station ? null : "/api/categories", { debut: f.debut, fin: f.fin, station: f.station });
  const profil = useApi<Profil[]>(f.station ? `/api/stations/${f.station}/profil` : null);

  const jours = cur.data ?? [];
  const lignes = useMemo(() => new Map(meta.lignes.map((l) => [l.id, l])), [meta]);

  const serie = useMemo(() => {
    const avant = new Map((prev.data ?? []).map((j) => [decale(j.jour, 364), j.total]));
    const acc = new Map<string, { t: number; n: number; a: number; na: number }>();
    for (const j of jours) {
      const k = bucket(j.jour, f.pas);
      const b = acc.get(k) ?? { t: 0, n: 0, a: 0, na: 0 };
      b.t += j.total;
      b.n += 1;
      const a = avant.get(j.jour);
      if (a != null) {
        b.a += a;
        b.na += 1;
      }
      acc.set(k, b);
    }
    return [...acc.entries()].map(([jour, b]) => ({ jour, valeur: Math.round(b.t / b.n), avant: b.na ? Math.round(b.a / b.na) : null, n: b.n }));
  }, [jours, prev.data, f.pas]);

  const stats = useMemo(() => {
    if (!jours.length) return null;
    const moy = moyenne(jours.map((j) => j.total));
    const record = jours.reduce((a, b) => (b.total > a.total ? b : a));
    const communs = new Map((prev.data ?? []).map((j) => [decale(j.jour, 364), j.total]));
    let s = 0, sa = 0;
    for (const j of jours) {
      const a = communs.get(j.jour);
      if (a != null) {
        s += j.total;
        sa += a;
      }
    }
    return { moy, total: jours.reduce((a, j) => a + j.total, 0), record, evol: sa > 0 ? s / sa - 1 : null };
  }, [jours, prev.data]);

  const parJour = useMemo(() => JOURS.map((nom, i) => {
    const xs = jours.filter((j) => jourSemaine(j.jour) === i && !j.ferie).map((j) => j.total);
    return { nom, valeur: Math.round(moyenne(xs)), n: xs.length };
  }), [jours]);

  const parType = useMemo(() => {
    const groupes: [string, (j: Jour, d: number) => boolean][] = [
      ["Jour ouvré", (j, d) => d < 5 && !j.ferie && !j.vacances],
      ["Ouvré, vacances", (j, d) => d < 5 && !j.ferie && !!j.vacances],
      ["Samedi", (j, d) => d === 5 && !j.ferie],
      ["Dimanche", (j, d) => d === 6 && !j.ferie],
      ["Jour férié", (j) => !!j.ferie],
    ];
    return groupes.map(([nom, test]) => {
      const xs = jours.filter((j) => test(j, jourSemaine(j.jour))).map((j) => j.total);
      return { nom, valeur: Math.round(moyenne(xs)), n: xs.length };
    }).filter((g) => g.n > 0);
  }, [jours]);

  // météo : seulement les jours ouvrés hors vacances, pour ne pas confondre avec l'effet calendrier
  const meteo = useMemo(() => {
    const base = jours.filter((j) => jourSemaine(j.jour) < 5 && !j.ferie && !j.vacances && j.pluie_mm != null && j.tmax != null);
    const ref = moyenne(base.map((j) => j.total));
    const groupes: [string, (j: Jour) => boolean][] = [
      ["Sans pluie", (j) => j.pluie_mm! < 0.2],
      ["Pluie faible", (j) => j.pluie_mm! >= 0.2 && j.pluie_mm! < 5],
      ["Pluie de 5 mm et plus", (j) => j.pluie_mm! >= 5],
      ["Moins de 5 °C", (j) => j.tmax! < 5],
      ["5 à 15 °C", (j) => j.tmax! >= 5 && j.tmax! < 15],
      ["15 à 25 °C", (j) => j.tmax! >= 15 && j.tmax! < 25],
      ["25 °C et plus", (j) => j.tmax! >= 25],
    ];
    return groupes.map(([nom, test]) => {
      const xs = base.filter(test).map((j) => j.total);
      return { nom, ecart: xs.length && ref ? moyenne(xs) / ref - 1 : 0, n: xs.length };
    });
  }, [jours]);

  const parts = useMemo(() => (titres.data ?? []).map((m) => {
    const tot = TITRES.reduce((s, [k]) => s + (Number(m[k]) || 0), 0) || 1;
    return { mois: String(m.mois), ...Object.fromEntries(TITRES.map(([k]) => [k, ((Number(m[k]) || 0) / tot) * 100])) } as Record<string, number | string>;
  }), [titres.data]);
  const titresPresents = TITRES.filter(([k]) => parts.some((m) => Number(m[k]) > 0.05));

  const heures = useMemo(() => Array.from({ length: 24 }, (_, h) => {
    const row: Record<string, number> = { heure: h };
    for (const p of profil.data ?? []) if (p.heure === h) row[p.cat_jour] = p.pourcentage;
    return row;
  }), [profil.data]);

  if (cur.error) return <Empty>{cur.error}</Empty>;
  if (!cur.data) return <Empty>Chargement…</Empty>;
  if (!jours.length) return <Empty>Aucune validation sur cette période pour ce filtre.</Empty>;

  const unite = f.pas === "jour" ? "par jour" : f.pas === "semaine" ? "par jour, moyenne de la semaine" : "par jour, moyenne du mois";
  const tickDate = (v: string) => (f.pas === "mois" || serie.length > 200 ? dateMois(v) : dateJour(v).split(" ").slice(1, 3).join(" "));

  return (
    <div className="grid gap-3 lg:grid-cols-6">
      <div className="grid grid-cols-2 gap-3 lg:col-span-6 lg:grid-cols-4">
        <Stat label="Validations par jour, en moyenne" value={compact(stats!.moy)} sub={`${entier(jours.length)} jours`} />
        <Stat label="Validations sur la période" value={compact(stats!.total)} />
        <Stat
          label="Par rapport à un an plus tôt"
          value={stats!.evol == null ? "—" : pct(stats!.evol, true)}
          sub={stats!.evol == null ? "pas de données un an avant" : "mêmes jours de la semaine"}
          tone={stats!.evol == null ? undefined : stats!.evol >= 0 ? "up" : "down"}
        />
        <Stat label="Jour le plus chargé" value={compact(stats!.record.total)} sub={dateLongue(stats!.record.jour)} />
      </div>

      <Card title="Validations dans le temps" hint={`Validations ${unite}`} className="lg:col-span-6" loading={cur.loading}>
        <Legend items={[{ label: "Période choisie", color: C.bleu }, ...(avantPossible ? [{ label: "Un an plus tôt", color: C.gris, dashed: true }] : [])]} />
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={serie} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={C.grille} vertical={false} />
            <XAxis dataKey="jour" {...AXE} tickFormatter={tickDate} minTickGap={48} />
            <YAxis {...AXE} tickFormatter={compact} width={52} domain={[0, "auto"]} />
            <Tooltip
              cursor={{ stroke: C.doux, strokeWidth: 1 }}
              content={<Tip
                title={(p) => (f.pas === "jour" ? dateJour(p.jour) : f.pas === "semaine" ? `Semaine du ${dateLongue(p.jour)}` : dateMois(p.jour))}
                rows={(p) => [
                  { label: "Période choisie", value: entier(p.valeur), color: C.bleu },
                  ...(p.avant != null ? [{ label: "Un an plus tôt", value: entier(p.avant), color: C.gris }] : []),
                ]}
              />}
            />
            <Line dataKey="avant" stroke={C.gris} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
            <Line dataKey="valeur" stroke={C.bleu} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card title="Stations les plus fréquentées" hint="Validations par jour en moyenne. Cliquer une station pour la détailler." className="lg:col-span-3" loading={top.loading}>
        {top.error ? <Empty>{top.error}</Empty> : (
          <ol className="space-y-1">
            {(top.data ?? []).map((s) => {
              const max = top.data![0].moyenne || 1;
              return (
                <li key={s.id_zdc}>
                  <button
                    onClick={() => onStation(s.id_zdc)}
                    className={`group grid w-full grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-tile ${f.station === s.id_zdc ? "bg-tile" : ""}`}
                  >
                    <span className="truncate font-medium">{s.nom}</span>
                    <span className="flex items-center gap-1">
                      <span className="h-3 rounded-r" style={{ width: `${Math.max(2, (s.moyenne / max) * 100)}%`, background: C.bleu }} />
                    </span>
                    <span className="tabular-nums text-ink-soft">{compact(s.moyenne)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <div className="grid gap-3 lg:col-span-3">
        <Card title="Selon le jour de la semaine" hint="Validations par jour en moyenne, hors jours fériés">
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={parJour} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={C.grille} vertical={false} />
              <XAxis dataKey="nom" {...AXE} />
              <YAxis {...AXE} tickFormatter={compact} width={52} />
              <Tooltip cursor={{ fill: C.grille, opacity: 0.5 }} content={<Tip title={(p) => p.nom} rows={(p) => [{ label: "Moyenne", value: entier(p.valeur) }, { label: "Jours", value: String(p.n) }]} />} />
              <Bar dataKey="valeur" fill={C.bleu} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Selon le type de jour" hint="Vacances scolaires de la zone C, jours fériés">
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={parType} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={C.grille} vertical={false} />
              <XAxis dataKey="nom" {...AXE} interval={0} />
              <YAxis {...AXE} tickFormatter={compact} width={52} />
              <Tooltip cursor={{ fill: C.grille, opacity: 0.5 }} content={<Tip title={(p) => p.nom} rows={(p) => [{ label: "Moyenne", value: entier(p.valeur) }, { label: "Jours", value: String(p.n) }]} />} />
              <Bar dataKey="valeur" fill={C.bleu} radius={[4, 4, 0, 0]} maxBarSize={44} isAnimationActive={false}>
                <LabelList dataKey="valeur" position="top" formatter={(v: unknown) => compact(Number(v))} fill={C.doux} fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Effet de la météo" hint="Écart à la moyenne des jours ouvrés hors vacances (météo de Paris)" className="lg:col-span-3">
        {meteo.filter((g) => g.n > 0).length < 2 ? <Empty>Pas assez de jours ouvrés sur la période.</Empty> : (
          <div className="space-y-1 py-1 text-sm">
            {meteo.map((g, i) => {
              const max = Math.max(...meteo.map((x) => Math.abs(x.ecart)), 0.01);
              const w = (Math.abs(g.ecart) / max) * 50;
              return (
                <div key={g.nom} className={`grid grid-cols-[9.5rem_1fr_3.5rem] items-center gap-2 ${i === 3 ? "mt-3 border-t border-border pt-3" : ""}`}
                  title={`${g.nom} : ${g.n} jours`}>
                  <span className="truncate">{g.nom}</span>
                  <span className="relative h-4">
                    <span className="absolute inset-y-0 left-1/2 w-px bg-rail" />
                    <span
                      className={`absolute inset-y-0.5 ${g.ecart >= 0 ? "rounded-r" : "rounded-l"}`}
                      style={{ background: g.ecart >= 0 ? C.bleu : C.orange, width: `${w}%`, left: g.ecart >= 0 ? "50%" : `${50 - w}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-ink-soft">{g.n ? pct(g.ecart, true) : "—"}</span>
                </div>
              );
            })}
            <p className="pt-2 text-xs text-ink-soft">Bleu : plus de validations que d'habitude. Orange : moins.</p>
          </div>
        )}
      </Card>

      <Card
        title="Avec quel titre de transport"
        hint={f.ligne && !f.station ? "Disponible pour le réseau entier ou pour une station" : "Part de chaque catégorie de titre, par mois"}
        className="lg:col-span-3"
        loading={titres.loading}
      >
        {f.ligne && !f.station ? <Empty>Choisir une station, ou retirer le filtre de ligne.</Empty> : (
          <>
            <Legend items={titresPresents.map(([label, color]) => ({ label, color }))} />
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={parts} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.grille} vertical={false} />
                <XAxis dataKey="mois" {...AXE} tickFormatter={dateMois} minTickGap={40} />
                <YAxis {...AXE} tickFormatter={(v) => `${v} %`} width={52} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} />
                <Tooltip
                  cursor={{ stroke: C.doux, strokeWidth: 1 }}
                  content={<Tip title={(p) => dateMois(p.mois)} rows={(p) => titresPresents.map(([k, color]) => ({ label: k, value: `${Number(p[k]).toFixed(1).replace(".", ",")} %`, color }))} />}
                />
                {titresPresents.map(([k, color]) => (
                  <Area key={k} dataKey={k} stackId="1" stroke="#fff" strokeWidth={1} fill={color} fillOpacity={1} isAnimationActive={false} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </>
        )}
      </Card>

      {f.station && (
        <Card
          title="À quelle heure"
          hint={`Part des validations de la journée, heure par heure${profil.data?.[0] ? ` (profil ${profil.data[0].periode})` : ""}`}
          className="lg:col-span-6"
          loading={profil.loading}
        >
          {!profil.data?.length ? <Empty>Pas de profil horaire pour cette station.</Empty> : (
            <>
              <Legend items={TYPES_JOUR.map(([, label, color]) => ({ label, color }))} />
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={heures} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={C.grille} vertical={false} />
                  <XAxis dataKey="heure" {...AXE} tickFormatter={(h) => `${h} h`} interval={1} />
                  <YAxis {...AXE} tickFormatter={(v) => `${v} %`} width={52} />
                  <Tooltip
                    cursor={{ stroke: C.doux, strokeWidth: 1 }}
                    content={<Tip title={(p) => `De ${p.heure} h à ${p.heure + 1} h`} rows={(p) => TYPES_JOUR.filter(([k]) => p[k] != null).map(([k, label, color]) => ({ label, value: `${Number(p[k]).toFixed(1).replace(".", ",")} %`, color }))} />}
                  />
                  {TYPES_JOUR.map(([k, , color]) => <Line key={k} dataKey={k} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </Card>
      )}
      {/* les pastilles de lignes servent aussi de rappel du périmètre */}
      {f.ligne && lignes.get(f.ligne) && !f.station && (
        <p className="flex items-center gap-2 text-xs text-ink-soft lg:col-span-6">
          <Pastille ligne={lignes.get(f.ligne)!} size={18} />
          Pour une ligne, on additionne les validations de ses stations : une station de correspondance compte pour chacune de ses lignes.
        </p>
      )}
    </div>
  );
}
