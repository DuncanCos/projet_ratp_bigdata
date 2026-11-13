"""API locale de démonstration, sans authentification : lecture pour la web app (séries, classements, profils,
prédictions) et une seule écriture, le temps réel PRIM envoyé par l'appli de bureau (`POST /api/temps-reel`)."""
import re
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from metrodata import config, db

app = FastAPI(title="Métro Live Data", description="Fréquentation du réseau ferré d'Île-de-France (open data IDFM)")
# GET seulement : le POST du temps réel vient du Rust de l'appli, pas d'un navigateur
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"])
app.mount("/figures", StaticFiles(directory=config.FIGURES), name="figures")

_cache: dict[str, tuple[float, object]] = {}
PARIS = ZoneInfo("Europe/Paris")


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


def _utc(v: datetime | None) -> str | None:
    """Horodatage Cassandra (UTC sans fuseau) -> ISO 8601 UTC."""
    return v.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if v else None


@app.get("/api/perturbations")
def perturbations(jour: date | None = None, ligne: str | None = None, debut: date | None = None, fin: date | None = None):
    """Perturbations archivées par le DAG perturbations_prim : un jour (tout le réseau ou une ligne),
    ou l'historique d'une ligne entre `debut` et `fin`. `fin_observee` : une perturbation disparue du flux
    avant sa fin annoncée est considérée terminée 10 minutes après le dernier relevé qui la montrait."""
    def load():
        if ligne and (debut or fin):
            f = fin or datetime.now(PARIS).date()
            rows = db.query("SELECT * FROM perturbations_ligne WHERE ligne = %s AND jour >= %s AND jour <= %s",
                            (ligne, debut or f - timedelta(days=30), f))
        else:
            j = jour or datetime.now(PARIS).date()
            rows = db.query("SELECT * FROM perturbations_jour WHERE jour = %s" + (" AND ligne = %s" if ligne else ""),
                            (j, ligne) if ligne else (j,))
        out = []
        for r in rows:
            vue = r["derniere_vue"] + timedelta(minutes=10) if r["derniere_vue"] else None
            obs = min((x for x in (r["fin"], vue) if x), default=None)
            out.append({**r, "jour": d(r["jour"]), "stations": sorted(r["stations"] or []),
                        **{k: _utc(r[k]) for k in ("debut", "fin", "maj", "premiere_vue", "derniere_vue")},
                        "fin_observee": _utc(obs)})
        return sorted(out, key=lambda r: (-r["jour"].toordinal(), r["ligne"], r["debut"] or ""))
    return cached(f"perturbations:{jour}:{ligne}:{debut}:{fin}", 60, load)


# ---------- temps réel PRIM archivé par l'appli de bureau ----------

class Position(BaseModel):
    ligne: str
    train: str
    de: int
    vers: int
    depart_ms: int
    arrivee_ms: int
    a_quai: bool
    destination: str


class Passage(BaseModel):
    ligne: str
    station: int
    destination: str
    direction: str = ""
    attendu_ms: int
    prevu_ms: int | None = None
    quai: str | None = None
    a_quai: bool = False
    statut: str | None = None


class Releve(BaseModel):
    releve_ms: int = Field(gt=0)
    positions: list[Position] = []
    passages: list[Passage] = []


def _ms(v: int | None) -> datetime | None:
    return datetime.fromtimestamp(v / 1000, timezone.utc) if v is not None else None


@app.post("/api/temps-reel")
def ecrire_temps_reel(r: Releve):
    """Positions d'une ligne ou passages à une station, tels que l'appli les a reçus de PRIM."""
    releve = _ms(r.releve_ms)
    jour = releve.astimezone(PARIS).date()
    pos = [(p.ligne, jour, releve, p.train, p.de, p.vers, _ms(p.depart_ms), _ms(p.arrivee_ms), p.a_quai, p.destination)
           for p in r.positions]
    pas = [(p.ligne, jour, p.station, releve, _ms(p.attendu_ms), p.destination, p.direction, _ms(p.prevu_ms), p.quai,
            p.a_quai, p.statut) for p in r.passages]
    if pos:
        db.upsert("positions_temps_reel", ["ligne", "jour", "releve", "train", "de", "vers", "depart", "arrivee",
                                           "a_quai", "destination"], pos)
    if pas:
        db.upsert("passages_temps_reel", ["ligne", "jour", "station", "releve", "attendu", "destination", "direction",
                                          "prevu", "quai", "a_quai", "statut"], pas)
    return {"positions": len(pos), "passages": len(pas)}


def _lignes_tr(rows: list[dict], cles: tuple[str, ...]) -> list[dict]:
    return sorted(({**r, "jour": d(r["jour"]), **{k: _utc(r[k]) for k in cles}} for r in rows),
                  key=lambda r: (r["releve"], r.get("station") or 0))


@app.get("/api/temps-reel/positions")
def positions_temps_reel(ligne: str, jour: date | None = None, limite: int = Query(5000, ge=1, le=100000)):
    """Positions réelles des trains d'une ligne un jour donné (aujourd'hui à Paris par défaut), par relevé."""
    j = jour or datetime.now(PARIS).date()
    rows = db.query("SELECT * FROM positions_temps_reel WHERE ligne = %s AND jour = %s LIMIT %s", (ligne, j, limite))
    return _lignes_tr(rows, ("releve", "depart", "arrivee"))


@app.get("/api/temps-reel/passages")
def passages_temps_reel(ligne: str, jour: date | None = None, station: int | None = None,
                        limite: int = Query(5000, ge=1, le=100000)):
    """Passages relevés sur une ligne (une station ou toutes) : heure attendue et heure prévue."""
    j = jour or datetime.now(PARIS).date()
    if station is not None:
        rows = db.query("SELECT * FROM passages_temps_reel WHERE ligne = %s AND jour = %s AND station = %s LIMIT %s",
                        (ligne, j, station, limite))
    else:
        rows = db.query("SELECT * FROM passages_temps_reel WHERE ligne = %s AND jour = %s LIMIT %s", (ligne, j, limite))
    return _lignes_tr(rows, ("releve", "attendu", "prevu"))


@app.get("/api/temps-reel/resume")
def resume_temps_reel(jour: date | None = None):
    """Ce qui a été archivé un jour donné, ligne par ligne (une partition par ligne et par jour)."""
    j = jour or datetime.now(PARIS).date()
    out = []
    for l in lignes():
        pos = db.query("SELECT releve FROM positions_temps_reel WHERE ligne = %s AND jour = %s", (l["id"], j))
        pas = db.query("SELECT releve FROM passages_temps_reel WHERE ligne = %s AND jour = %s", (l["id"], j))
        releves = {r["releve"] for r in pos + pas}
        if releves:
            out.append({"ligne": l["id"], "nom": l["nom"], "jour": j, "nb_releves": len(releves),
                        "premier": _utc(min(releves)), "dernier": _utc(max(releves)),
                        "nb_positions": len(pos), "nb_passages": len(pas)})
    return out


@app.get("/api/sante")
def sante():
    return {"ok": True, "jours": len(reseau())}


# ---------- résumés pour la carte temps réel (appli de bureau) ----------

def _type_jour(j: date) -> list[str]:
    """Types de jour des profils horaires, du plus précis au plus général."""
    c = contexte().get(j, {})
    vac = "VS" if c.get("vacances") else "HV"
    if c.get("ferie") or j.weekday() == 6:
        return ["DIJFP"]
    return [f"SA{vac}", "SAHV"] if j.weekday() == 5 else [f"JO{vac}", "JOHV"]


def _mots(nom: str) -> set[str]:
    import unicodedata
    plat = unicodedata.normalize("NFKD", nom.lower()).encode("ascii", "ignore").decode()
    return {m for m in re.split(r"[^a-z0-9]+", plat) if len(m) > 1}


def _resoudre(id_zdc: int, nom: str | None) -> dict | None:
    """Station de l'API pour une station de la carte : même identifiant, sinon nom emboîté
    (« Châtelet - Les Halles » sur la carte, « Les Halles » dans les validations)."""
    st = stations()
    s = st.get(id_zdc)
    if s and s["moyenne_jour"]:
        return s
    if not nom:
        return None
    cible = _mots(nom)
    best = None
    for x in st.values():
        m = _mots(x["nom"] or "")
        if x["moyenne_jour"] and m and (m <= cible or cible <= m):
            cle = (len(m & cible), x["moyenne_jour"])
            if best is None or cle > best[0]:
                best = (cle, x)
    return best[1] if best else None


@app.get("/api/stations/{id_zdc}/resume")
def resume_station(id_zdc: int, nom: str | None = None):
    """L'essentiel d'une station : niveau habituel, prédiction des prochains jours, profil horaire du jour."""
    s = _resoudre(id_zdc, nom)
    if not s:
        raise HTTPException(404, "Station sans données de validation.")
    z, auj = s["id_zdc"], date.today()
    actives = sorted((x["moyenne_jour"] for x in stations().values() if x["moyenne_jour"]), reverse=True)
    pred = db.query("SELECT jour, prevu FROM predictions WHERE id_zdc = %s AND jour >= %s AND jour <= %s",
                    (z, auj, auj + timedelta(days=2)))
    profils = db.query("SELECT cat_jour, heure, pourcentage FROM profil_horaire WHERE id_zdc = %s", (z,))
    cat = next((c for c in _type_jour(auj) if any(p["cat_jour"] == c for p in profils)), None)
    return {
        "id_zdc": z, "nom": s["nom"], "moyenne_jour": round(s["moyenne_jour"]),
        "rang": actives.index(s["moyenne_jour"]) + 1, "nb_stations": len(actives),
        "previsions": sorted(({"jour": d(p["jour"]), "prevu": p["prevu"]} for p in pred), key=lambda p: p["jour"]),
        "type_jour": cat,
        "profil": sorted(({"heure": p["heure"], "pourcentage": p["pourcentage"]} for p in profils if p["cat_jour"] == cat),
                         key=lambda p: p["heure"]),
    }


@app.get("/api/lignes/{ligne}/resume")
def resume_ligne(ligne: str):
    """L'essentiel d'une ligne : niveau des 12 derniers mois, évolution, série par semaine, poids de chaque station."""
    l = next((x for x in lignes() if x["id"] == ligne), None)
    if not l:
        raise HTTPException(404, "Ligne inconnue.")
    def load():
        _, fin = bornes(None, None)
        rows = jours(fin - timedelta(days=727), fin, ligne, None, None)
        if not rows:
            raise HTTPException(404, "Ligne sans données de validation.")
        coupe = fin - timedelta(days=363)
        recents = [r for r in rows if r["jour"] > coupe]
        avant = {r["jour"] + timedelta(days=364): r["total"] for r in rows if r["jour"] <= coupe}
        communs = [(r["total"], avant[r["jour"]]) for r in recents if r["jour"] in avant]
        sem = defaultdict(lambda: [0, 0])
        for r in recents:
            a = sem[r["jour"] - timedelta(days=r["jour"].weekday())]
            a[0] += r["total"]
            a[1] += 1
        st = stations()
        auj = date.today()
        prevu = sum(p["prevu"] for z in l["stations"]
                    for p in db.query("SELECT prevu FROM predictions WHERE id_zdc = %s AND jour = %s", (z, auj)))
        return {
            "id": ligne, "nom": l["nom"], "jour_max": fin,
            "moyenne_jour": round(sum(r["total"] for r in recents) / len(recents)),
            "evolution": (sum(a for a, _ in communs) / sum(b for _, b in communs) - 1) if communs else None,
            "prevu_aujourdhui": prevu or None,
            "semaines": [{"jour": k, "moyenne": round(t / n)} for k, (t, n) in sorted(sem.items()) if n == 7],
            "stations": {z: round(st[z]["moyenne_jour"]) for z in l["stations"] if z in st and st[z]["moyenne_jour"]},
        }
    return cached(f"resume_ligne:{ligne}:{date.today()}", 600, load)
