import { useEffect, useMemo, useState } from "react";
import { Map as MapIcon, X } from "lucide-react";
import { Meta, StationRef, dateLongue, decale } from "@/lib/dataApi";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AnalyseTab, Filtres } from "./AnalyseTab";
import { PredictionTab } from "./PredictionTab";
import { PipelineTab } from "./PipelineTab";
import { Empty, Pastille, nomLigne, useApi } from "./kit";

type Onglet = "analyse" | "prediction" | "pipeline";
const ONGLETS: [Onglet, string][] = [["analyse", "Analyse"], ["prediction", "Prédiction"], ["pipeline", "Pipeline"]];
const PERIODES: [string, string, number | null][] = [["3m", "3 mois", 91], ["1a", "1 an", 364], ["3a", "3 ans", 1092], ["tout", "Tout", null]];
const TOUT = "__tout__";

/** Tableau de bord de fréquentation : filtres communs, puis trois onglets. */
export function DataDashboard({ carte }: { carte: boolean }) {
  const meta = useApi<Meta>("/api/meta");
  const [onglet, setOnglet] = useState<Onglet>("analyse");
  const [periode, setPeriode] = useState("1a");
  const [debut, setDebut] = useState("");
  const [fin, setFin] = useState("");
  const [ligne, setLigne] = useState<string | null>(null);
  const [station, setStation] = useState<number | null>(null);
  const [categorie, setCategorie] = useState<string | null>(null);
  const [pasChoisi, setPasChoisi] = useState<Filtres["pas"] | null>(null);
  const [recherche, setRecherche] = useState("");

  const m = meta.data;
  useEffect(() => {
    if (!m?.jour_max || !m.jour_min || periode === "perso") return;
    const jours = PERIODES.find(([k]) => k === periode)?.[2];
    setFin(m.jour_max);
    setDebut(jours == null ? m.jour_min : decale(m.jour_max, -jours + 1) < m.jour_min ? m.jour_min : decale(m.jour_max, -jours + 1));
  }, [m, periode]);

  const toutes = useApi<StationRef[]>("/api/stations");
  const stations = useMemo(() => (toutes.data ?? []).filter((s) => !ligne || s.lignes.includes(ligne)), [toutes.data, ligne]);
  const choisie = useMemo(() => (toutes.data ?? []).find((s) => s.id_zdc === station) ?? null, [toutes.data, station]);
  const propositions = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return q.length < 2 ? [] : stations.filter((s) => s.nom?.toLowerCase().includes(q)).slice(0, 8);
  }, [recherche, stations]);

  if (meta.error) {
    return (
      <Shell carte={carte}>
        <Empty>
          {meta.error}. Lancer la stack : <code className="mx-1 rounded bg-white px-1.5 py-0.5">docker compose up -d</code> dans le dossier pipeline.
        </Empty>
      </Shell>
    );
  }
  if (!m || !debut) return <Shell carte={carte}><Empty>Chargement…</Empty></Shell>;
  if (!m.jour_max) return <Shell carte={carte}><Empty>La base est vide : le DAG validations_historique est sans doute en cours dans Airflow.</Empty></Shell>;

  const nbJours = Math.round((Date.parse(fin) - Date.parse(debut)) / 86400000) + 1;
  const pas: Filtres["pas"] = pasChoisi ?? (nbJours <= 130 ? "jour" : nbJours <= 800 ? "semaine" : "mois");
  const filtres: Filtres = { debut, fin, ligne, station, categorie: ligne && !station ? null : categorie, pas };
  const champ = "h-9 rounded-md border border-input bg-white px-2 text-sm";

  return (
    <Shell carte={carte} sousTitre={`Validations du ${dateLongue(m.jour_min!)} au ${dateLongue(m.jour_max)}, ${m.nb_stations} gares et stations`}>
      <nav className="flex gap-1 border-b border-border" aria-label="Sections">
        {ONGLETS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setOnglet(k)}
            aria-current={onglet === k ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${onglet === k ? "border-ink text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {onglet !== "pipeline" && (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-xl border border-border bg-white px-4 py-3">
          {onglet === "analyse" && (
            <>
              <Champ label="Période">
                <div className="flex overflow-hidden rounded-md border border-input">
                  {PERIODES.map(([k, label]) => (
                    <button key={k} onClick={() => setPeriode(k)} aria-pressed={periode === k}
                      className={`h-9 px-2.5 text-sm ${periode === k ? "bg-ink font-semibold text-white" : "bg-white hover:bg-tile"}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </Champ>
              <Champ label="Du">
                <input type="date" className={champ} value={debut} min={m.jour_min!} max={fin}
                  onChange={(e) => { if (e.target.value) { setDebut(e.target.value); setPeriode("perso"); } }} />
              </Champ>
              <Champ label="Au">
                <input type="date" className={champ} value={fin} min={debut} max={m.jour_max}
                  onChange={(e) => { if (e.target.value) { setFin(e.target.value); setPeriode("perso"); } }} />
              </Champ>
              <Champ label="Ligne">
                <Select value={ligne ?? TOUT} onValueChange={(v) => { setLigne(v === TOUT ? null : v); setStation(null); }}>
                  <SelectTrigger className="h-9 w-44 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-80">
                    <SelectItem value={TOUT}>Toutes les lignes</SelectItem>
                    {m.lignes.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        <span className="flex items-center gap-2"><Pastille ligne={l} size={18} />{nomLigne(l)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Champ>
            </>
          )}
          <Champ label="Station">
            {choisie ? (
              <span className="flex h-9 items-center gap-1 rounded-md bg-ink pl-3 pr-1 text-sm font-semibold text-white">
                {choisie.nom}
                <button onClick={() => setStation(null)} aria-label="Retirer la station" className="rounded p-1 hover:bg-white/20"><X className="size-3.5" /></button>
              </span>
            ) : (
              <div className="relative">
                <input className={`${champ} w-56`} placeholder="Chercher une station" value={recherche} onChange={(e) => setRecherche(e.target.value)} />
                {propositions.length > 0 && (
                  <ul className="absolute z-20 mt-1 w-72 rounded-md border border-border bg-white py-1 shadow-lg">
                    {propositions.map((s) => (
                      <li key={s.id_zdc}>
                        <button className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm hover:bg-tile"
                          onClick={() => { setStation(s.id_zdc); setRecherche(""); }}>
                          <span className="mr-auto truncate">{s.nom}</span>
                          {s.lignes.slice(0, 5).map((id) => { const l = m.lignes.find((x) => x.id === id); return l ? <Pastille key={id} ligne={l} size={16} /> : null; })}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Champ>
          {onglet === "analyse" && (
            <>
              <Champ label="Titre de transport">
                <Select value={filtres.categorie ?? TOUT} onValueChange={(v) => setCategorie(v === TOUT ? null : v)} disabled={!!ligne && !station}>
                  <SelectTrigger className="h-9 w-48 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={TOUT}>Tous les titres</SelectItem>
                    {m.categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Champ>
              <Champ label="Regrouper par">
                <Select value={pas} onValueChange={(v) => setPasChoisi(v as Filtres["pas"])}>
                  <SelectTrigger className="h-9 w-32 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jour">Jour</SelectItem>
                    <SelectItem value="semaine">Semaine</SelectItem>
                    <SelectItem value="mois">Mois</SelectItem>
                  </SelectContent>
                </Select>
              </Champ>
            </>
          )}
        </div>
      )}

      {onglet === "analyse" && <AnalyseTab f={filtres} meta={m} onStation={setStation} />}
      {onglet === "prediction" && <PredictionTab station={station} nomStation={choisie?.nom ?? null} />}
      {onglet === "pipeline" && <PipelineTab meta={m} />}
    </Shell>
  );
}

function Champ({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function Shell({ carte, sousTitre, children }: { carte: boolean; sousTitre?: string; children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-3 px-4 py-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="condensed text-[28px] font-bold leading-none">Fréquentation du réseau</h1>
            <p className="mt-1.5 text-sm text-ink-soft">{sousTitre ?? "Métro, RER et trains d'Île-de-France, données ouvertes d'Île-de-France Mobilités"}</p>
          </div>
          {carte && (
            <Button asChild variant="outline" className="h-9 gap-2 rounded-full bg-white">
              <a href="#/"><MapIcon className="size-4" />Carte en direct</a>
            </Button>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
