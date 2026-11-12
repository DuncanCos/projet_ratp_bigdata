"""Historique des validations du réseau ferré (2015 à l'an dernier) : une archive zip par année.

Extraction -> nettoyage (parquet « silver ») -> chargement Cassandra, une branche par année en parallèle.
Lancé une fois au premier démarrage, puis à la main quand IDFM publie une nouvelle année
(paramètre `annees`, vide = toutes).
"""
import re
from pathlib import Path

import pendulum
from airflow.sdk import Param, dag, task

from commun import DEFAULT_ARGS, TAGS, VALIDATIONS


def _periode(path: str) -> str:
    m = re.search(r"(\d{4})_?([ST]\d)", Path(path).name, re.I)
    return f"{m.group(1)}-{m.group(2).upper()}"


@dag(schedule="@once", start_date=pendulum.datetime(2026, 1, 1, tz="Europe/Paris"), catchup=False,
     default_args=DEFAULT_ARGS, tags=TAGS + ["etl"], max_active_tasks=3,
     params={"annees": Param([], type="array", items={"type": "integer"}, description="Années à (re)charger, vide = toutes")},
     doc_md=__doc__)
def validations_historique():
    @task
    def lister_annees(params=None) -> list[int]:
        from metrodata import extract
        dispo = sorted(extract.histo_index())
        voulues = [a for a in (params or {}).get("annees") or [] if a in dispo]
        return voulues or dispo

    @task
    def extraire(annee: int) -> dict:
        from metrodata import extract
        return {"annee": annee, **extract.download_histo(annee)}

    @task
    def transformer(fichiers: dict) -> dict:
        from metrodata import transform
        nb = []
        for p in fichiers["nb"]:
            periode = _periode(p)
            nb.append({**transform.to_silver(p, f"histo_{periode}"), "periode": periode})
        # profil horaire : seule la dernière période de l'année sert (la plus récente l'emporte en base)
        dernier = max(fichiers["profil"], key=_periode)
        profil = {"periode": _periode(dernier), "silver": transform.profil_to_silver(dernier, f"histo_{_periode(dernier)}")}
        return {"annee": fichiers["annee"], "nb": nb, "profil": profil}

    @task
    def charger(lot: dict) -> dict:
        from metrodata import load
        n = sum(load.validations(s["silver"], "historique", s["periode"], s) for s in lot["nb"])
        p = load.profils(lot["profil"]["silver"], lot["profil"]["periode"])
        return {"annee": lot["annee"], "validations": n, "profils": p,
                "rejets": sum(s["lignes_rejetees"] for s in lot["nb"])}

    @task(outlets=[VALIDATIONS])
    def bilan(resultats: list[dict]) -> dict:
        total = {"annees": len(resultats), "validations": sum(r["validations"] for r in resultats),
                 "rejets": sum(r["rejets"] for r in resultats)}
        print(total)
        return total

    bilan(charger.expand(lot=transformer.expand(fichiers=extraire.expand(annee=lister_annees()))))


validations_historique()
