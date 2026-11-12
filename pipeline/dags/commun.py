"""Éléments partagés par les DAGs."""
from datetime import timedelta

from airflow.sdk import Asset

# Les DAGs se déclenchent les uns les autres par ces « assets » (ordonnancement piloté par les données).
VALIDATIONS = Asset("cassandra://metrolive/validations_jour")
CONTEXTE = Asset("cassandra://metrolive/contexte_jour")
AGREGATS = Asset("cassandra://metrolive/reseau_jour")

DEFAULT_ARGS = {"retries": 2, "retry_delay": timedelta(minutes=2)}
TAGS = ["metrolive", "open-data"]
