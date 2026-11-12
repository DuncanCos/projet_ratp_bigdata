"""Référentiels (gares, lignes) puis tables d'agrégats lues par la web app.

Se déclenche dès qu'un DAG de validations a chargé des données."""
import pendulum
from airflow.sdk import dag, task

from commun import AGREGATS, DEFAULT_ARGS, TAGS, VALIDATIONS


@dag(schedule=[VALIDATIONS], start_date=pendulum.datetime(2026, 1, 1, tz="Europe/Paris"), catchup=False,
     default_args=DEFAULT_ARGS, tags=TAGS + ["gold"], max_active_runs=1, doc_md=__doc__)
def agregats():
    @task
    def referentiels() -> dict:
        from metrodata import extract, load, transform
        f = extract.download_referentiels()
        return load.referentiels(*transform.stations_et_lignes(extract.read_json(f["gares"]), extract.read_json(f["lignes"])))

    @task(outlets=[AGREGATS])
    def calculer() -> dict:
        from metrodata import load
        return load.agregats()

    referentiels() >> calculer()


agregats()
