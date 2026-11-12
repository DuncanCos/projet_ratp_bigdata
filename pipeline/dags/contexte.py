"""Contexte de chaque jour : météo de Paris (Open-Meteo, observée puis prévue à 16 jours),
jours fériés (api.gouv.fr) et vacances scolaires de la zone C (Éducation nationale)."""
import pendulum
from airflow.sdk import dag, task

from commun import CONTEXTE, DEFAULT_ARGS, TAGS


@dag(schedule="30 5 * * *", start_date=pendulum.datetime(2026, 1, 1, tz="Europe/Paris"), catchup=False,
     default_args=DEFAULT_ARGS, tags=TAGS + ["etl"], doc_md=__doc__)
def contexte():
    @task
    def extraire() -> dict:
        from metrodata import extract
        return extract.download_contexte()

    @task(outlets=[CONTEXTE])
    def transformer_et_charger(f: dict) -> dict:
        from metrodata import extract, load, transform
        df = transform.contexte(*(extract.read_json(f[k]) for k in ("meteo_archive", "meteo_prevision", "feries", "vacances")))
        return {"jours": load.contexte(df), "jusqu_au": df["jour"].max().date().isoformat(),
                "feries": int(df["ferie"].notna().sum()), "jours_de_vacances": int(df["vacances"].notna().sum())}

    transformer_et_charger(extraire())


contexte()
