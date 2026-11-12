"""Entraînement du modèle de fréquentation et prédictions à 14 jours.

Relancé quand les agrégats changent (nouvelles validations) ou quand le contexte est mis à jour
(nouvelles prévisions météo, donc nouvelles prédictions chaque matin)."""
import pendulum
from airflow.sdk import dag, task

from commun import AGREGATS, CONTEXTE, DEFAULT_ARGS, TAGS


@dag(schedule=(AGREGATS | CONTEXTE), start_date=pendulum.datetime(2026, 1, 1, tz="Europe/Paris"), catchup=False,
     default_args=DEFAULT_ARGS, tags=TAGS + ["ml"], max_active_runs=1, doc_md=__doc__)
def modele_prediction():
    @task
    def pret() -> bool:
        """Le modèle a besoin de l'historique agrégé et du contexte : sinon on attend le prochain déclenchement."""
        from airflow.exceptions import AirflowSkipException
        from metrodata import db
        from metrodata import config
        avant = int(config.TRAIN_START[:4]) - 2  # la référence d'un jour remonte jusqu'à deux ans en arrière
        for table in ("reseau_jour", "contexte_jour"):
            if not db.query(f"SELECT jour FROM {table} WHERE annee = %s LIMIT 1", (avant,)):
                raise AirflowSkipException(f"{table} ne remonte pas encore à {avant} : historique en cours de chargement")
        return True

    @task
    def entrainer_et_predire(_: bool) -> dict:
        from metrodata import model
        return model.train()

    entrainer_et_predire(pret())


modele_prediction()
