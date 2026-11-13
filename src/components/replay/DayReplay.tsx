import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { ChartNoAxesColumn, Check, Map as MapIcon, Pause, Play, Radio, TriangleAlert } from "lucide-react";
import { Disruption } from "@/lib/api";
import { decale, get, iso } from "@/lib/dataApi";
import { dataHref, hashParams } from "@/lib/frequentation";
import { useIsMobile } from "@/lib/hooks";
import { Journee, NOM_TYPE, chargerJournee, heure, typeDuJour } from "@/lib/journee";
import { LINES, Line, geometry, lineById } from "@/lib/metro";
import { BOUNDS, DirectionLegend, FitTo, ZoomControls } from "@/components/MapView";
import { LinePicker } from "@/components/LinePicker";
import { Roundel } from "@/components/Roundel";
import { Button } from "@/components/ui/button";
import { Compte, TrainLayer } from "./TrainLayer";

/** Perturbation archivée par le DAG `perturbations_prim` (API « données »). */
interface Perturbation {
  ligne: string;
  nom_ligne: string;
  id: string;
  titre: string;
  message: string;
  message_court: string;
  gravite: string;
  cause: string;
  debut: string;
  fin_observee: string;
  toute_la_ligne: boolean;
}

/** secondes de journée par seconde réelle */
const VITESSES: [number, string][] = [[1, "1 seconde"], [60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"], [3600, "1 heure"]];
const INK = "#1d2733";
const MUTED = "#aeb7b3";
const fJour = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const nomJour = (date: string) => fJour.format(new Date(`${date}T12:00:00`));

/** Jour de service et seconde en cours : avant 3 h 30, on est encore dans la journée de la veille. */
function maintenant() {
  const n = new Date();
  const s = n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds();
  return s < 3.5 * 3600 ? { date: decale(iso(n), -1), t: s + 86400 } : { date: iso(n), t: s };
}

function useZoom() {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  return zoom;
}

/** Tracé des lignes ; stations de la ligne choisie. */
function Lignes({ focused }: { focused: Line | null }) {
  const zoom = useZoom();
  const poids = zoom < 12 ? 6 : zoom < 14 ? 8 : 10;
  // stations discrètes : ce sont les trains qu'on regarde
  const r = zoom < 12 ? 2.5 : zoom < 13.5 ? 3.5 : 5;
  const ordre = useMemo(() => [...LINES].sort((a, b) => Number(a === focused) - Number(b === focused)), [focused]);
  return (
    <>
      {ordre.map((l) =>
        l.patterns.map((p, i) => (
          <Polyline
            key={`${l.id}-${i}-${l === focused}`}
            positions={p.shape}
            interactive={false}
            pathOptions={{
              color: focused && l !== focused ? MUTED : l.color,
              weight: l === focused ? poids : focused ? 2 : zoom >= 13 ? 4 : 3,
              opacity: l === focused ? 0.55 : focused ? 0.6 : 0.5,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        )),
      )}
      {focused?.stations.map((s, i) => {
        const terminus = focused.patterns.some((p) => p.stations[0] === i || p.stations[p.stations.length - 1] === i);
        const nomme = terminus || zoom >= 13.75;
        return (
          <CircleMarker
            key={`${focused.id}-st-${i}`}
            center={geometry(focused).stationPos[i]}
            radius={terminus ? r + 1 : r}
            pathOptions={{ color: terminus ? INK : "#5b6672", weight: terminus ? 2.5 : 1.5, fillColor: "#fff", fillOpacity: 1 }}
          >
            <Tooltip
              key={nomme ? "label" : "hover"}
              permanent={nomme}
              className={nomme ? `station-label${terminus ? " is-strong" : ""}` : "station-tip"}
              direction={nomme ? "right" : "top"}
              offset={nomme ? [r + 8, 0] : [0, -8]}
            >
              {s.name}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

/** Frise de la journée : trains en circulation minute par minute, curseur à déplacer. */
function Frise({ journee, curseur, onAller }: { journee: Journee; curseur: React.RefObject<HTMLDivElement | null>; onAller: (t: number) => void }) {
  const { debut, fin, charge } = journee;
  const aire = useMemo(() => {
    const max = Math.max(1, ...charge);
    let d = "M0 40";
    for (let m = 0; m < charge.length; m += 2) d += `L${((m / (charge.length - 1)) * 1000).toFixed(1)} ${(40 - (charge[m] / max) * 38).toFixed(1)}`;
    return `${d}L1000 40Z`;
  }, [charge]);
  const heures = useMemo(() => {
    const out: number[] = [];
    for (let h = Math.ceil(debut / 3600); h * 3600 <= fin; h++) out.push(h);
    return out;
  }, [debut, fin]);
  const aller = (e: React.PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    onAller(debut + Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)) * (fin - debut));
  };
  return (
    <div className="select-none">
      <div
        className="relative h-11 cursor-pointer touch-none"
        role="slider"
        aria-label="Heure de la journée"
        aria-valuemin={debut}
        aria-valuemax={fin}
        tabIndex={-1}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          aller(e);
        }}
        onPointerMove={(e) => e.buttons > 0 && aller(e)}
      >
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <path d={aire} fill="#dfe4e1" />
        </svg>
        {/* partie déjà jouée, découverte par le curseur */}
        <div ref={curseur} className="absolute inset-0 [--x:0%]">
          <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" style={{ clipPath: "inset(0 calc(100% - var(--x)) 0 0)" }} aria-hidden>
            <path d={aire} fill="#5b6672" />
          </svg>
          <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-signal" style={{ left: "var(--x)" }} />
        </div>
      </div>
      <div className="relative h-4 text-[11px] text-ink-soft">
        {heures.map((h) => (
          <span
            key={h}
            className={`absolute -translate-x-1/2 tabular-nums ${h % 3 ? "hidden lg:inline" : ""}`}
            style={{ left: `${((h * 3600 - debut) / (fin - debut)) * 100}%` }}
          >
            {h % 24} h
          </span>
        ))}
      </div>
    </div>
  );
}

/** Journée en accéléré : la carte du réseau, et tous les trains de la journée d'après les horaires prévus. */
export default function DayReplay({ carte }: { carte: boolean }) {
  const mobile = useIsMobile();
  const [date, setDate] = useState(() => maintenant().date);
  const type = typeDuJour(date);
  const [journee, setJournee] = useState<Journee | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(() => {
    const l = hashParams().ligne;
    return l && LINES.some((x) => x.id === l) ? l : null;
  });
  const [lecture, setLecture] = useState(true);
  const [vitesse, setVitesse] = useState(300);
  // ce que l'interface affiche, rafraîchi quatre fois par seconde (la carte, elle, à chaque image)
  const [vu, setVu] = useState({ minute: 0, total: 0, parLigne: {} as Record<string, number>, sens: [0, 0] as [number, number] });

  const horloge = useRef({ t: 0, lecture, vitesse });
  // heure à laquelle se placer quand la journée choisie est prête ; sinon on repart du début
  const cible = useRef<number | null>(null);
  horloge.current.lecture = lecture;
  horloge.current.vitesse = vitesse;
  const jRef = useRef<Journee | null>(null);
  jRef.current = journee;
  const dessiner = useRef<((t: number) => void) | null>(null);
  const compte = useRef<Compte>({ total: 0, parLigne: new Uint16Array(LINES.length), sens: [0, 0] });
  const heureEl = useRef<HTMLSpanElement>(null);
  const curseur = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let vivant = true;
    chargerJournee(type)
      .then((j) => {
        if (vivant) setJournee(j);
      })
      .catch((e) => vivant && setErreur(String(e)));
    return () => {
      vivant = false;
    };
  }, [type]);

  // chaque journée choisie repart de son début (ou de l'heure qu'il est, pour le direct)
  useEffect(() => {
    if (!journee) return;
    horloge.current.t = Math.min(journee.fin, Math.max(journee.debut, cible.current ?? journee.debut));
    cible.current = null;
  }, [date, journee]);
  const aller = (t: number) => {
    const j = jRef.current;
    if (j) horloge.current.t = Math.min(j.fin, Math.max(j.debut, t));
  };
  const direct = () => {
    const m = maintenant();
    if (m.date === date) aller(m.t);
    else cible.current = m.t;
    setDate(m.date);
    setVitesse(1);
    setLecture(true);
  };

  // une seule boucle : l'heure avance, la carte et le curseur suivent
  useEffect(() => {
    let id = 0;
    let avant = performance.now();
    let dernierVu = 0;
    const image = (now: number) => {
      const h = horloge.current;
      const j = jRef.current;
      const dt = Math.min(0.1, (now - avant) / 1000);
      avant = now;
      if (j) {
        if (h.lecture) {
          h.t += dt * h.vitesse;
          if (h.t > j.fin) h.t = j.debut; // la journée recommence
        }
        dessiner.current?.(h.t);
        if (heureEl.current) heureEl.current.textContent = heure(h.t);
        curseur.current?.style.setProperty("--x", `${((h.t - j.debut) / (j.fin - j.debut)) * 100}%`);
        if (now - dernierVu > 250) {
          dernierVu = now;
          const c = compte.current;
          const parLigne: Record<string, number> = {};
          LINES.forEach((l, i) => (parLigne[l.id] = c.parLigne[i]));
          setVu({ minute: Math.floor(h.t / 60), total: c.total, parLigne, sens: c.sens });
        }
      }
      id = requestAnimationFrame(image);
    };
    id = requestAnimationFrame(image);
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
      if (e.key === " ") setLecture((l) => !l);
      else if (e.key === "ArrowRight") aller(horloge.current.t + (e.shiftKey ? 1800 : 300));
      else if (e.key === "ArrowLeft") aller(horloge.current.t - (e.shiftKey ? 1800 : 300));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", touche);
    return () => window.removeEventListener("keydown", touche);
  }, []);

  // perturbations archivées ce jour-là, si la stack « données » tourne
  const [archive, setArchive] = useState<Perturbation[] | null>(null);
  const [archiveKo, setArchiveKo] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    setArchive(null);
    setArchiveKo(false);
    get<Perturbation[]>("/api/perturbations", { jour: date }, ctl.signal)
      .then(setArchive)
      .catch(() => !ctl.signal.aborted && setArchiveKo(true));
    return () => ctl.abort();
  }, [date]);
  const nbArchive = new Set((archive ?? []).map((p) => p.id)).size;
  const minuit = useMemo(() => new Date(`${date}T00:00:00`).getTime(), [date]);
  const enCours = useMemo(() => {
    const instant = minuit + vu.minute * 60_000;
    return (archive ?? []).filter((p) => p.gravite !== "INFORMATION" && Date.parse(p.debut) <= instant && instant < Date.parse(p.fin_observee));
  }, [archive, minuit, vu.minute]);
  // même forme que l'info trafic en direct, pour la pastille du sélecteur de lignes
  const trafic = useMemo(() => {
    const out: Record<string, Disruption[]> = {};
    for (const p of enCours)
      (out[p.ligne] ??= []).push({
        id: p.id, title: p.titre, shortMessage: p.message_court, message: p.message, severity: p.gravite, cause: p.cause,
        active: true, beginMs: Date.parse(p.debut), endMs: Date.parse(p.fin_observee), stations: [], wholeLine: p.toute_la_ligne,
      });
    for (const ds of Object.values(out)) ds.sort((a, b) => Number(b.severity === "BLOQUANTE") - Number(a.severity === "BLOQUANTE"));
    return out;
  }, [enCours]);
  const perturbees = LINES.filter((l) => trafic[l.id]);
  const autres = new Set(enCours.filter((p) => !LINES.some((l) => l.id === p.ligne)).map((p) => p.ligne)).size;

  const focusLine = focused ? lineById(focused) : null;
  const bouton = "h-9 rounded-full px-3 text-sm font-semibold tabular-nums";

  return (
    <div className="flex h-full overflow-hidden">
      {!mobile && <LinePicker lines={LINES} focused={focused} counts={vu.parLigne} traffic={trafic} onFocus={setFocused} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="relative min-h-0 flex-1">
          <MapContainer
            center={[48.8566, 2.3522]}
            zoom={12}
            zoomControl={false}
            zoomSnap={0.25}
            zoomDelta={0.5}
            wheelPxPerZoomLevel={90}
            wheelDebounceTime={20}
            minZoom={10}
            maxZoom={18}
            maxBounds={BOUNDS}
            maxBoundsViscosity={0.8}
            className="h-full w-full"
            preferCanvas
          >
            <TileLayer
              maxZoom={18}
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              className="basemap"
            />
            <FitTo line={focusLine} lines={LINES} bottomInset={0} />
            <ZoomControls line={focusLine} lines={LINES} bottomInset={0} />
            {focusLine && <DirectionLegend line={focusLine} counts={vu.sens} bottomInset={0} />}
            <Lignes focused={focusLine} />
            {journee && <TrainLayer journee={journee} focused={focused} dessiner={dessiner} compte={compte} />}
          </MapContainer>

          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-2.5 md:p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="pointer-events-auto min-w-0 max-w-sm rounded-xl bg-white/95 px-3.5 py-2 shadow-md ring-1 ring-border">
                <h1 className="text-lg font-extrabold leading-none tracking-tight">Journée du {nomJour(date)}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {erreur ?? (journee ? `${vu.total} train${vu.total > 1 ? "s" : ""} en circulation${focusLine ? `, dont ${vu.parLigne[focusLine.id] ?? 0} sur la ligne` : ""}` : "Chargement des horaires…")}
                </p>
                {/* ce qu'on a vraiment pour ce jour-là */}
                <ul className="mt-1.5 grid gap-0.5 text-xs">
                  <li className="flex items-start gap-1.5">
                    <Check className="mt-px size-3.5 shrink-0 text-emerald-600" />
                    <span>
                      Trains : horaires prévus d'un <b className="font-semibold">{NOM_TYPE[type]}</b> (GTFS), pas les positions réelles
                    </span>
                  </li>
                  <li className="flex items-start gap-1.5">
                    {nbArchive > 0 ? <Check className="mt-px size-3.5 shrink-0 text-emerald-600" /> : <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-500" />}
                    <span>
                      Perturbations :{" "}
                      {archiveKo
                        ? "archive injoignable (stack données arrêtée)"
                        : !archive
                          ? "recherche dans l'archive…"
                          : nbArchive > 0
                            ? <><b className="font-semibold">{nbArchive} archivées</b> ce jour-là</>
                            : "aucune archive pour ce jour-là"}
                    </span>
                  </li>
                </ul>
                {perturbees.length + autres > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
                    <span className="mr-0.5 font-semibold text-signal">Perturbé à cette heure</span>
                    {perturbees.map((l) => (
                      <button key={l.id} onClick={() => setFocused(l.id)} title={trafic[l.id][0].title} className="rounded-full">
                        <Roundel line={l} size={20} />
                      </button>
                    ))}
                    {autres > 0 && <span className="text-ink-soft">+ {autres} hors métro et RER</span>}
                  </div>
                )}
              </div>
              <div className="pointer-events-auto flex shrink-0 items-center gap-2">
                {carte && (
                  <Button asChild variant="outline" className="h-10 gap-2 rounded-full bg-white px-3 shadow-md">
                    <a href={focused ? `#/?ligne=${focused}` : "#/"} aria-label="Carte en direct">
                      <MapIcon className="size-4" />
                      <span className={mobile ? "sr-only" : ""}>En direct</span>
                    </a>
                  </Button>
                )}
                <Button asChild variant="outline" className="h-10 gap-2 rounded-full bg-white px-3 shadow-md">
                  <a href={dataHref({ ligne: focused })} aria-label="Données de fréquentation">
                    <ChartNoAxesColumn className="size-4" />
                    <span className={mobile ? "sr-only" : ""}>Données</span>
                  </a>
                </Button>
              </div>
            </div>
            {mobile && (
              <div className="pointer-events-auto -mx-2.5 bg-white/90 shadow-sm backdrop-blur">
                <LinePicker lines={LINES} focused={focused} counts={vu.parLigne} traffic={trafic} onFocus={setFocused} horizontal />
              </div>
            )}
          </div>
        </main>

        <footer className="shrink-0 border-t border-border bg-white px-3 pb-2 pt-2.5 md:px-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button className="size-10 rounded-full p-0" onClick={() => setLecture(!lecture)} aria-label={lecture ? "Mettre en pause" : "Lancer"}>
              {lecture ? <Pause className="size-5" /> : <Play className="size-5" />}
            </Button>
            <div className="leading-none">
              <span ref={heureEl} className="text-3xl font-extrabold tabular-nums tracking-tight">
                --:--
              </span>
              {vu.minute >= 1440 && <span className="ml-1.5 text-xs text-ink-soft">le lendemain</span>}
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="Vitesse">
              {VITESSES.map(([v, duree]) => (
                <button
                  key={v}
                  onClick={() => setVitesse(v)}
                  aria-pressed={vitesse === v}
                  title={`1 seconde = ${duree}`}
                  className={`${bouton} ${vitesse === v ? "bg-ink text-white" : "bg-tile text-ink-soft hover:bg-tile-deep"}`}
                >
                  ×{v}
                </button>
              ))}
            </div>
            <span className="hidden text-xs text-ink-soft md:inline">1 seconde = {VITESSES.find(([v]) => v === vitesse)?.[1]}</span>
            <Button variant="outline" className="ml-auto h-9 gap-2 rounded-full bg-white px-3" onClick={direct} title="Aujourd'hui, à l'heure qu'il est, en temps réel">
              <Radio className="size-4 text-signal" />
              Direct
            </Button>
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <span className="hidden sm:inline">{nomJour(date)}</span>
              <input
                type="date"
                value={date}
                max={maintenant().date}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                aria-label="Jour à rejouer"
                className="h-9 rounded-md border border-input bg-white px-2 text-sm text-ink"
              />
            </label>
          </div>
          {journee && <Frise journee={journee} curseur={curseur} onAller={aller} />}
        </footer>
      </div>
    </div>
  );
}
