"""Validations récentes : les quatre jeux « trimestre » du portail IDFM (API d'export).

Chaque jeu contient le dernier trimestre publié de son rang ; le portail les remplace sans prévenir,
d'où un passage quotidien. Le chargement est un upsert : rejouer ne duplique rien.
"""
import pendulum
from airflow.sdk import dag, task

from commun import DEFAULT_ARGS, TAGS, VALIDATIONS


@dag(schedule="0 5 * * *", start_date=pendulum.datetime(2026, 1, 1, tz="Europe/Paris"), catchup=False,
     default_args=DEFAULT_ARGS, tags=TAGS + ["etl"], doc_md=__doc__)
def validations_trimestres():
    @task
    def lister() -> list[str]:
        from metrodata import config
        return config.TRIMESTRES

    @task
    def extraire(rang: str) -> dict:
        from metrodata import extract
        return extract.download_trimestre(rang)

    @task
    def transformer(f: dict) -> dict:
        from metrodata import transform
        return {**transform.to_silver(f["nb"], f"trimestre_{f['periode']}"), "periode": f["periode"],
                "profil": transform.profil_to_silver(f["profil"], f"trimestre_{f['periode']}")}

    @task
    def charger(s: dict) -> dict:
        from metrodata import load
        return {"periode": s["periode"], "validations": load.validations(s["silver"], "trimestre", s["periode"], s),
                "profils": load.profils(s["profil"], s["periode"]), "rejets": s["lignes_rejetees"]}

    @task(outlets=[VALIDATIONS])
    def bilan(resultats: list[dict]) -> list[dict]:
        print(resultats)
        return resultats

    bilan(charger.expand(s=transformer.expand(f=extraire.expand(rang=lister()))))


validations_trimestres()
