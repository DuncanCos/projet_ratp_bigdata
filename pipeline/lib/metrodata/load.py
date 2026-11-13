"""Chargement Cassandra : faits, dimensions, agrégats. Tout est un upsert, donc rejouable."""
from datetime import datetime, timezone

import pandas as pd

from . import config as c
from . import db
from .transform import CAT_COLS, PARIS, all_validations


def _d(ts):
    return ts.date() if hasattr(ts, "date") else ts


def validations(silver_path: str, source: str, periode: str, stats: dict | None = None) -> int:
    df = pd.read_parquet(silver_path)
    cats = df[CAT_COLS].to_dict("records")
    rows = ((int(z), _d(j), int(t), {k: int(v) for k, v in cat.items() if v})
            for z, j, t, cat in zip(df["id_zdc"], df["jour"], df["total"], cats))
    n = db.upsert("validations_jour", ["id_zdc", "jour", "total", "categories"], rows)
    s = stats or {}
    db.upsert("chargements",
              ["source", "periode", "charge_le", "lignes_brutes", "lignes_rejetees", "lignes_chargees", "jour_min", "jour_max"],
              [(source, periode, datetime.now(timezone.utc), s.get("lignes_brutes"), s.get("lignes_rejetees"), n,
                _d(df["jour"].min()), _d(df["jour"].max()))])
    return n


def profils(silver_path: str, periode: str) -> int:
    """`periode` au format « 2026-T2 » ou « 2023-S1 ». La période la plus récente l'emporte."""
    df = pd.read_parquet(silver_path)
    annee, rang = periode.split("-")
    ordre = int(annee) * 10 + (int(rang[1]) * 2 if rang[0] == "S" else int(rang[1]))
    return db.upsert("profil_horaire", ["id_zdc", "cat_jour", "heure", "pourcentage", "periode"],
                     ((int(r.id_zdc), r.cat_jour, int(r.heure), float(r.pourcentage), periode) for r in df.itertuples()),
                     timestamp=ordre * 1_000_000)


def referentiels(stations: pd.DataFrame, lignes: pd.DataFrame) -> dict:
    # colonnes nommées : on ne touche pas à moyenne_jour / dernier_jour, calculées par les agrégats
    db.upsert("stations", ["id_zdc", "nom", "lat", "lon", "lignes", "modes"],
              ((int(r.id_zdc), r.nom, r.lat, r.lon, set(r.lignes), set(r.modes)) for r in stations.itertuples()))
    db.upsert("lignes", ["id", "nom", "mode", "couleur", "couleur_texte", "stations"],
              ((r.id, r.nom, r.mode, r.couleur, r.couleur_texte, set(r.stations)) for r in lignes.itertuples()))
    return {"stations": len(stations), "lignes": len(lignes)}


def contexte(df: pd.DataFrame) -> int:
    nn = lambda v: None if pd.isna(v) else v  # noqa: E731
    return db.upsert("contexte_jour", ["annee", "jour", "tmax", "tmin", "pluie_mm", "ferie", "vacances", "prevision"],
                     ((r.jour.year, _d(r.jour), nn(r.tmax), nn(r.tmin), nn(r.pluie_mm), nn(r.ferie), nn(r.vacances),
                       bool(r.prevision)) for r in df.itertuples()))


def perturbations(lignes: list[dict], instant: datetime) -> dict:
    """Archive un relevé PRIM : une perturbation déjà vue ce jour-là garde sa première apparition
    et compte un relevé de plus. Lecture puis écriture : le DAG ne tourne jamais en double."""
    jour = instant.astimezone(PARIS).date()
    deja = {(r["ligne"], r["id"]): r for r in db.query(
        "SELECT ligne, id, premiere_vue, nb_releves FROM perturbations_jour WHERE jour = %s", (jour,))}
    rows = []
    for p in lignes:
        avant = deja.get((p["ligne"], p["id"]))
        premiere = avant["premiere_vue"].replace(tzinfo=timezone.utc) if avant and avant["premiere_vue"] else instant
        rows.append((jour, p["ligne"], p["id"], p["nom_ligne"], p["mode"], p["titre"], p["message"], p["message_court"],
                     p["gravite"], p["cause"], p["debut"], p["fin"], p["maj"], p["toute_la_ligne"], set(p["stations"]),
                     min(premiere, instant), instant, (avant["nb_releves"] or 0) + 1 if avant else 1))
    for table in ("perturbations_jour", "perturbations_ligne"):
        db.upsert(table, db.COLONNES_PERTURBATION, rows)
    distinctes = {i for _, i in deja} | {p["id"] for p in lignes}
    return {"jour": jour.isoformat(), "en_cours": len(rows), "nouvelles": sum(1 for p in lignes if (p["ligne"], p["id"]) not in deja),
            "perturbations_du_jour": len(distinctes)}


def agregats() -> dict:
    """Recalcule les tables d'agrégats à partir de toute la zone silver."""
    df = all_validations()

    # réseau entier, par jour
    g = df.groupby("jour")
    res = g[CAT_COLS + ["total"]].sum()
    res["nb_stations"] = g["id_zdc"].nunique()
    cats = res[CAT_COLS].to_dict("records")
    db.upsert("reseau_jour", ["annee", "jour", "total", "categories", "nb_stations"],
              ((j.year, _d(j), int(t), {k: int(v) for k, v in cat.items() if v}, int(n))
               for j, t, n, cat in zip(res.index, res["total"], res["nb_stations"], cats)))

    # par station et par mois (classements)
    df["annee"], df["mois"] = df["jour"].dt.year, df["jour"].dt.month
    sm = df.groupby(["annee", "mois", "id_zdc"])["total"].agg(["sum", "count"]).reset_index()
    db.upsert("stations_mois", ["annee", "mois", "id_zdc", "total", "nb_jours"],
              (tuple(int(x) for x in row) for row in sm.itertuples(index=False, name=None)))

    # stations : moyenne des 365 derniers jours connus ; les stations absentes du référentiel prennent leur libellé
    fin = df["jour"].max()
    recent = df[df["jour"] > fin - pd.Timedelta(days=365)].groupby("id_zdc")["total"].mean()
    dernier = df.groupby("id_zdc")["jour"].max()
    libelle = df.groupby("id_zdc")["libelle"].last()
    connues = {r["id_zdc"] for r in db.query("SELECT id_zdc FROM stations")}
    db.upsert("stations", ["id_zdc", "moyenne_jour", "dernier_jour"],
              ((int(z), float(recent.get(z, 0.0)), _d(dernier[z])) for z in dernier.index))
    db.upsert("stations", ["id_zdc", "nom"],
              ((int(z), str(libelle[z]).title()) for z in dernier.index if int(z) not in connues))

    # par ligne : somme des validations des stations de la ligne (une station de correspondance compte
    # pour chacune de ses lignes : c'est la fréquentation des stations de la ligne, pas celle des rames)
    lignes = db.query("SELECT id, stations FROM lignes")
    paires = pd.DataFrame([(l["id"], z) for l in lignes for z in (l["stations"] or [])], columns=["ligne", "id_zdc"])
    lj = df[["jour", "id_zdc", "total"]].merge(paires, on="id_zdc").groupby(["ligne", "jour"])["total"].sum().reset_index()
    db.upsert("ligne_jour", ["ligne", "jour", "total"],
              ((l, _d(j), int(t)) for l, j, t in zip(lj["ligne"], lj["jour"], lj["total"])))

    return {"jours": len(res), "stations": int(df["id_zdc"].nunique()), "stations_mois": len(sm),
            "ligne_jour": len(lj), "jour_min": _d(df["jour"].min()).isoformat(), "jour_max": _d(fin).isoformat()}
