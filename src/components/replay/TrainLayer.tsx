import { MutableRefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { LINES, isRer, lineTitle } from "@/lib/metro";
import { Journee, Pose, heure, placer, premiereApres } from "@/lib/journee";

/** Ce que le calque sait après chaque image : trains en circulation, par ligne et par sens. */
export interface Compte {
  total: number;
  parLigne: Uint16Array;
  /** ligne choisie : trains dans chaque sens */
  sens: [number, number];
}

interface Props {
  journee: Journee;
  /** ligne choisie (seuls ses trains sont dessinés), sinon tout le réseau */
  focused: string | null;
  /** rempli par le calque : `dessiner(t)` trace les trains à la seconde `t` de la journée */
  dessiner: MutableRefObject<((t: number) => void) | null>;
  compte: MutableRefObject<Compte>;
}

/**
 * Trains de la journée, dessinés sur un canevas posé sur la carte. Plusieurs centaines de points
 * bougent à chaque image : on ne passe ni par React ni par des marqueurs Leaflet.
 */
export function TrainLayer({ journee, focused, dessiner, compte }: Props) {
  const map = useMap();
  const [survol, setSurvol] = useState<{ x: number; y: number; texte: string } | null>(null);
  const etat = useRef({ journee, focused });
  etat.current = { journee, focused };

  useEffect(() => {
    const pane = map.getPane("trains") ?? map.createPane("trains");
    pane.style.zIndex = "450"; // au-dessus des lignes, sous les infobulles
    pane.style.pointerEvents = "none";
    const canvas = L.DomUtil.create("canvas", "leaflet-zoom-animated", pane) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const pose: Pose = { x: 0, y: 0, dx: 0, dy: 0, k: 0, aQuai: false };

    // Vue figée pendant une animation de zoom : Leaflet met le canevas à l'échelle en CSS, et on
    // continue à dessiner dans les coordonnées d'avant le zoom.
    let zoomEnCours = false;
    let echelle = 1;
    let ox = 0;
    let oy = 0;
    let zoom = map.getZoom();
    let coin = map.containerPointToLatLng([0, 0]);
    let large = 0;
    let haut = 0;
    // trains de la dernière image, pour le survol : x, y, numéro de course
    let vus: number[] = [];
    let dernier = -1;

    const cadrer = () => {
      const taille = map.getSize();
      const dpr = window.devicePixelRatio || 1;
      if (taille.x !== large || taille.y !== haut) {
        large = taille.x;
        haut = taille.y;
        canvas.width = large * dpr;
        canvas.height = haut * dpr;
        canvas.style.width = `${large}px`;
        canvas.style.height = `${haut}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const haut_gauche = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, haut_gauche);
      zoom = map.getZoom();
      coin = map.containerPointToLatLng([0, 0]);
      echelle = 256 * Math.pow(2, zoom);
      const origine = map.getPixelOrigin();
      ox = origine.x + haut_gauche.x;
      oy = origine.y + haut_gauche.y;
    };

    const tracer = (t: number) => {
      dernier = t;
      if (!zoomEnCours) cadrer();
      const { journee: j, focused: choisie } = etat.current;
      const c = compte.current;
      c.total = 0;
      c.parLigne.fill(0);
      c.sens = [0, 0];
      vus = [];
      ctx.clearRect(0, 0, large, haut);
      const r = choisie ? (zoom >= 14 ? 7 : 5.5) : zoom < 11.5 ? 2.6 : zoom < 13 ? 3.4 : zoom < 14.5 ? 4.8 : 6.5;
      const ecart = r * 0.85;
      ctx.lineWidth = r > 4 ? 2 : 1.3;
      const fin = premiereApres(j, t);
      for (let i = premiereApres(j, t - j.dureeMax - 1); i < fin; i++) {
        const g = j.gabarits[i];
        const rel = t - j.departs[i];
        if (rel > g.duree) continue;
        c.total++;
        c.parLigne[g.ligne]++;
        const line = LINES[g.ligne];
        if (choisie) {
          if (line.id !== choisie) continue;
          c.sens[g.sens]++;
        }
        placer(g, rel, pose);
        let x = pose.x * echelle - ox;
        let y = pose.y * echelle - oy;
        // les deux sens côte à côte : le métro roule à droite, le RER à gauche
        const n = Math.hypot(pose.dx, pose.dy);
        if (n > 0) {
          const cote = isRer(line) ? -ecart : ecart;
          x += (-pose.dy / n) * cote;
          y += (pose.dx / n) * cote;
        }
        if (x < -10 || y < -10 || x > large + 10 || y > haut + 10) continue;
        vus.push(x, y, i);
        // sens 0 : point plein à la couleur de la ligne ; sens 1 : point blanc cerclé
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fillStyle = g.sens === 0 ? line.color : "#fff";
        ctx.strokeStyle = g.sens === 0 ? "#fff" : line.color;
        ctx.fill();
        ctx.stroke();
      }
    };
    dessiner.current = tracer;

    const debutZoom = (e: L.LeafletEvent) => {
      const ev = e as L.ZoomAnimEvent;
      zoomEnCours = true;
      // même calcul que les calques de Leaflet : où tombe l'ancien coin haut gauche après le zoom
      const pos = (map as unknown as { _latLngToNewLayerPoint(l: L.LatLng, z: number, c: L.LatLng): L.Point })._latLngToNewLayerPoint(coin, ev.zoom, ev.center);
      L.DomUtil.setTransform(canvas, pos, map.getZoomScale(ev.zoom, zoom));
    };
    const finZoom = () => {
      zoomEnCours = false;
      if (dernier >= 0) tracer(dernier);
    };
    const bouge = (e: L.LeafletMouseEvent) => {
      let best = -1;
      let d = 12 * 12;
      // pendant un zoom animé les positions ne correspondent plus à l'écran
      if (!zoomEnCours)
        for (let k = 0; k < vus.length; k += 3) {
          const dd = (vus[k] - e.containerPoint.x) ** 2 + (vus[k + 1] - e.containerPoint.y) ** 2;
          if (dd < d) {
            d = dd;
            best = k;
          }
        }
      if (best < 0) return setSurvol((s) => (s ? null : s));
      const j = etat.current.journee;
      const g = j.gabarits[vus[best + 2]];
      const line = LINES[g.ligne];
      const rel = dernier - j.departs[vus[best + 2]];
      placer(g, Math.max(0, Math.min(g.duree, rel)), pose);
      const k = Math.min(pose.aQuai ? pose.k : pose.k + 1, g.arrets.length - 1);
      const terminus = line.stations[g.arrets[g.arrets.length - 1]].name;
      const ici = line.stations[g.arrets[k]].name;
      const suite = pose.aQuai ? `à quai à ${ici}` : `arrive à ${ici} à ${heure(j.departs[vus[best + 2]] + g.arr[k])}`;
      setSurvol({ x: vus[best], y: vus[best + 1], texte: `${lineTitle(line)} vers ${terminus}, ${suite}` });
    };
    const sort = () => setSurvol(null);

    map.on("zoomanim", debutZoom);
    map.on("zoomend moveend viewreset resize", finZoom);
    map.on("mousemove", bouge);
    map.on("mouseout", sort);
    return () => {
      dessiner.current = null;
      map.off("zoomanim", debutZoom);
      map.off("zoomend moveend viewreset resize", finZoom);
      map.off("mousemove", bouge);
      map.off("mouseout", sort);
      canvas.remove();
    };
  }, [map, dessiner, compte]);

  if (!survol) return null;
  return createPortal(
    <div
      className="pointer-events-none absolute z-[1000] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-xs font-semibold text-white"
      style={{ left: survol.x, top: survol.y - 10, fontStretch: "85%" }}
    >
      {survol.texte}
    </div>,
    map.getContainer(),
  );
}
