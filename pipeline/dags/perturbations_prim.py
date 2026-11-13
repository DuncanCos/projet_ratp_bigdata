"""Archive de l'info trafic : toutes les 10 minutes, relevé des perturbations en cours sur le réseau ferré
(métro, RER, Transilien, tramway, câble) via l'API PRIM d'Île-de-France Mobilités.

PRIM ne donne que l'instantané : sans ce relevé, rien n'est historisé. 144 appels par jour sur un quota
de 1 000, partagé avec l'appli de bureau. Demande une clé gratuite (PRIM_API_KEY dans pipeline/.env) :
sans clé, ou quota épuisé, le relevé est sauté plutôt qu'en échec."""
from datetime import timedelta

import pendulum
from airflow.sdk import dag, task

from commun import TAGS


@dag(schedule="*/10 * * * *", start_date=pendulum.datetime(2026, 1, 1, tz="Europe/Paris"), catchup=False,
     default_args={"retries": 1, "retry_delay": timedelta(minutes=2)}, tags=TAGS + ["temps-reel"],
     max_active_runs=1, doc_md=__doc__)
def perturbations_prim():
    @task
    def extraire() -> dict:
        from airflow.exceptions import AirflowSkipException
        from metrodata import extract
        try:
            return extract.download_perturbations()
        except (extract.CleAbsente, extract.QuotaEpuise) as e:
            raise AirflowSkipException(str(e))

    @task
    def transformer_et_charger(f: dict) -> dict:
        from datetime import datetime
        from metrodata import extract, load, transform
        instant = datetime.fromisoformat(f["instant"])  # heure réelle de l'appel, pas la date logique
        return {**load.perturbations(transform.perturbations(extract.read_json(f["fichier"]), instant), instant),
                "quota_restant": f["quota_restant"]}

    transformer_et_charger(extraire())


perturbations_prim()
