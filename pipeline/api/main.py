"""API de lecture pour la web app : séries, classements, profils, prédictions. Lecture seule sur Cassandra."""
import re
import time
from collections import defaultdict
from datetime import date, timedelta

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from metrodata import config, db

app = FastAPI(title="Métro Live Data", description="Fréquentation du réseau ferré d'Île-de-France (open data IDFM)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"])
app.mount("/figures", StaticFiles(directory=config.FIGURES), name="figures")

_cache: dict[str, tuple[float, object]] = {}


def cached(key: str, ttl: int, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def d(v) -> date | None:
    """Date Cassandra -> date Python."""
    return v.date() if v is not None and hasattr(v, "date") else v


def _naturel(nom: str):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", nom)]


ORDRE_MODES = {"METRO": 0, "RER": 1, "TRAIN": 2, "TRAM": 3}


def lignes() -> list[dict]:
    def load():
        rows = db.query("SELECT id, nom, mode, couleur, couleur_texte, stations FROM lignes")
        out = [{**r, "stations": sorted(r["stations"] or [])} for r in rows]
        return sorted(out, key=lambda l: (ORDRE_MODES.get(l["mode"], 9), _naturel(l["nom"])))
    return cached("lignes", 300, load)


def stations() -> dict[int, dict]:
    def load():
        rows = db.query("SELECT id_zdc, nom, lat, lon, lignes, modes, moyenne_jour, dernier_jour FROM stations")
        return {r["id_zdc"]: {**r, "lignes": sorted(r["lignes"] or []), "modes": sorted(r["modes"] or []),
                              "dernier_jour": d(r["dernier_jour"])} for r in rows}
    return cached("stations", 300, load)


def reseau() -> list[dict]:
    """Tout le réseau jour par jour (~4 000 lignes), gardé en mémoire."""
    def load():
        rows = db.query("SELECT jour, total, categories, nb_stations FROM reseau_jour")
        return sorted(({"jour": d(r["jour"]), "total": r["total"], "categories": dict(r["categories"] or {}),
                        "nb_stations": r["nb_stations"]} for r in rows), key=lambda r: r["jour"])
    return cached("reseau", 300, load)


def contexte() -> dict[date, dict]:
    def load():
        rows = db.query("SELECT jour, tmax, tmin, pluie_mm, ferie, vacances, prevision FROM contexte_jour")
        return {d(r["jour"]): {k: r[k] for k in ("tmax", "tmin", "pluie_mm", "ferie", "vacances", "prevision")} for r in rows}
    return cached("contexte", 300, load)


def bornes(debut: date | None, fin: date | None) -> tuple[date, date]:
    r = reseau()
    if not r:
        raise HTTPException(503, "Aucune donnée : le pipeline Airflow n'a pas encore chargé les validations.")
    fin = min(fin or r[-1]["jour"], r[-1]["jour"])
    debut = max(debut or fin - timedelta(days=364), r[0]["jour"])
    return debut, fin


def jours(debut: date, fin: date, ligne: str | None, station: int | None, categorie: str | None) -> list[dict]:
    """Série quotidienne [{jour, total}] pour le réseau, une ligne ou une station."""
    if station is not None:
        rows = db.query("SELECT jour, total, categories FROM validations_jour WHERE id_zdc = %s AND jour >= %s AND jour <= %s",
                        (station, debut, fin))
        out = [{"jour": d(r["jour"]), "total": (r["categories"] or {}).get(categorie, 0) if categorie else r["total"]} for r in rows]
    elif ligne:
        rows = db.query("SELECT jour, total FROM ligne_jour WHERE ligne = %s AND jour >= %s AND jour <= %s", (ligne, debut, fin))
        out = [{"jour": d(r["jour"]), "total": r["total"]} for r in rows]
    else:
        out = [{"jour": r["jour"], "total": r["categories"].get(categorie, 0) if categorie else r["total"]}
               for r in reseau() if debut <= r["jour"] <= fin]
    return sorted(out, key=lambda r: r["jour"])


@app.get("/api/meta")
def meta():
    r = reseau()
    cats = sorted({k for row in r[-400:] for k in row["categories"]}) if r else []
    modele = db.query("SELECT * FROM modele_metriques")
    return {
        "jour_min": r[0]["jour"] if r else None, "jour_max": r[-1]["jour"] if r else None,
        "categories": cats, "lignes": [{k: l[k] for k in ("id", "nom", "mode", "couleur", "couleur_texte")} for l in lignes()],
        "nb_stations": sum(1 for s in stations().values() if s["moyenne_jour"]), "modele": modele[0]["modele"] if modele else None,
    }


@app.get("/api/stations")
def liste_stations(ligne: str | None = None):
    ids = None
    if ligne:
        ids = set(next((l["stations"] for l in lignes() if l["id"] == ligne), []))
    out = [s for s in stations().values() if s["moyenne_jour"] and (ids is None or s["id_zdc"] in ids)]
    return sorted(out, key=lambda s: -(s["moyenne_jour"] or 0))


@app.get("/api/serie")
def serie(debut: date | None = None, fin: date | None = None, pas: str = Query("jour", pattern="^(jour|semaine|mois)$"),
          ligne: str | None = None, station: int | None = None, categorie: str | None = None):
    """Validations dans le temps. `moyenne` = validations par jour sur la période du pas (comparable d'un pas à l'autre)."""
    debut, fin = bornes(debut, fin)
    rows = jours(debut, fin, ligne, station, categorie)
    ctx = contexte()
    if pas == "jour":
        return [{**r, "moyenne": r["total"], **{k: ctx.get(r["jour"], {}).get(k) for k in ("tmax", "tmin", "pluie_mm", "ferie", "vacances")}}
                for r in rows]
    cle = (lambda j: j - timedelta(days=j.weekday())) if pas == "semaine" else (lambda j: j.replace(day=1))
    acc = defaultdict(lambda: [0, 0])
    for r in rows:
        a = acc[cle(r["jour"])]
        a[0] += r["total"]
        a[1] += 1
    return [{"jour": k, "total": t, "nb_jours": n, "moyenne": round(t / n)} for k, (t, n) in sorted(acc.items())]


@app.get("/api/categories")
def categories(debut: date | None = None, fin: date | None = None, station: int | None = None):
    """Répartition par catégorie de titre sur la période, par mois (réseau ou station)."""
    debut, fin = bornes(debut, fin)
    if station is not None:
        rows = [{"jour": d(r["jour"]), "categories": r["categories"] or {}} for r in db.query(
            "SELECT jour, categories FROM validations_jour WHERE id_zdc = %s AND jour >= %s AND jour <= %s", (station, debut, fin))]
    else:
        rows = [r for r in reseau() if debut <= r["jour"] <= fin]
    acc = defaultdict(lambda: defaultdict(int))
    for r in rows:
        for k, v in r["categories"].items():
            acc[r["jour"].replace(day=1)][k] += v
    return [{"mois": m, **acc[m]} for m in sorted(acc)]


@app.get("/api/classement")
def classement(debut: date | None = None, fin: date | None = None, ligne: str | None = None, limit: int = Query(15, le=1000)):
    """Stations les plus fréquentées (mois entiers couvrant la période)."""
    debut, fin = bornes(debut, fin)
    ids = set(next((l["stations"] for l in lignes() if l["id"] == ligne), [])) if ligne else None
    tot, nj = defaultdict(int), defaultdict(int)
    m = debut.replace(day=1)
    while m <= fin:
        for r in db.query("SELECT id_zdc, total, nb_jours FROM stations_mois WHERE annee = %s AND mois = %s", (m.year, m.month)):
            tot[r["id_zdc"]] += r["total"]
            nj[r["id_zdc"]] += r["nb_jours"]
        m = (m + timedelta(days=32)).replace(day=1)
    st = stations()
    out = [{"id_zdc": z, "nom": st.get(z, {}).get("nom") or str(z), "lignes": st.get(z, {}).get("lignes", []),
            "lat": st.get(z, {}).get("lat"), "lon": st.get(z, {}).get("lon"),
            "total": t, "moyenne": round(t / max(nj[z], 1))}
           for z, t in tot.items() if ids is None or z in ids]
    return sorted(out, key=lambda r: -r["total"])[:limit]


@app.get("/api/stations/{id_zdc}/profil")
def profil(id_zdc: int):
    """Part des validations par heure et par type de jour (JOHV = jour ouvré hors vacances, etc.)."""
    rows = db.query("SELECT cat_jour, heure, pourcentage, periode FROM profil_horaire WHERE id_zdc = %s", (id_zdc,))
    return sorted(rows, key=lambda r: (r["cat_jour"], r["heure"]))


@app.get("/api/prediction")
def prediction(station: int | None = None):
    """Réel et prédit : période de test (comparaison possible), puis jusqu'à 14 jours après aujourd'hui."""
    if station is not None:
        pred = db.query("SELECT jour, prevu FROM predictions WHERE id_zdc = %s", (station,))
    else:
        pred = db.query("SELECT jour, prevu FROM predictions_reseau WHERE k = 0")
    if not pred:
        raise HTTPException(404, "Pas de prédiction : le DAG modele_prediction n'a pas encore tourné (ou station trop peu fréquentée).")
    # les prédictions d'un entraînement précédent, antérieures à la période de test actuelle, sont ignorées
    m = db.query("SELECT test_debut FROM modele_metriques")
    test_debut = d(m[0]["test_debut"]) if m else date.min
    pred = {d(r["jour"]): r["prevu"] for r in pred if d(r["jour"]) >= test_debut}
    debut = min(pred) - timedelta(days=60)
    reel = {r["jour"]: r["total"] for r in jours(debut, date.today(), None, station, None)}
    ctx = contexte()
    out, j, fin = [], debut, max(pred)
    while j <= fin:
        if j in reel or j in pred:
            out.append({"jour": j, "reel": reel.get(j), "prevu": pred.get(j), **ctx.get(j, {})})
        j += timedelta(days=1)
    return out


@app.get("/api/modele")
def modele():
    rows = db.query("SELECT * FROM modele_metriques")
    if not rows:
        raise HTTPException(404, "Modèle pas encore entraîné.")
    m = max(rows, key=lambda r: r["entraine_le"])
    for k in ("train_debut", "train_fin", "test_debut", "test_fin"):
        m[k] = d(m[k])
    m["importances"] = sorted(({"variable": k, "importance": v} for k, v in (m["importances"] or {}).items()),
                              key=lambda x: -x["importance"])
    m["figures"] = [f"/figures/{p.name}" for p in sorted(config.FIGURES.glob("*.png"))]
    return m


@app.get("/api/pipeline")
def pipeline():
    """Journal des chargements : volumes et rejets par période (qualité des données)."""
    rows = db.query("SELECT * FROM chargements")
    for r in rows:
        r["jour_min"], r["jour_max"] = d(r["jour_min"]), d(r["jour_max"])
    return sorted(rows, key=lambda r: (r["jour_min"], r["source"]))


@app.get("/api/sante")
def sante():
    return {"ok": True, "jours": len(reseau())}
