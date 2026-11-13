import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("METRODATA_DIR", "/opt/data"))
RAW = DATA_DIR / "raw"          # fichiers tels que publiés (zip, csv, json)
SILVER = DATA_DIR / "silver"    # parquet nettoyés, un fichier par période
MODELS = DATA_DIR / "models"
FIGURES = DATA_DIR / "figures"

CASSANDRA_HOSTS = os.environ.get("CASSANDRA_HOSTS", "cassandra").split(",")
KEYSPACE = os.environ.get("CASSANDRA_KEYSPACE", "metrolive")

PORTAIL = "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets"
HISTO = "histo-validations-reseau-ferre"
# Les quatre jeux « trimestre » tournent : chacun contient le dernier trimestre publié de son rang.
TRIMESTRES = ["1er-trimestre", "2eme-trimestre", "3eme-trimestre", "4eme-trimestre"]
NB_TRIMESTRE = "validations-reseau-ferre-nombre-validations-par-jour-{}"
PROFIL_TRIMESTRE = "validations-reseau-ferre-profils-horaires-par-jour-type-{}"
GARES = "emplacement-des-gares-idf-data-generalisee"
LIGNES = "referentiel-des-lignes"

# Info trafic en temps réel (PRIM, clé gratuite) : 1 000 appels par jour, partagés avec l'appli de bureau.
PRIM_PERTURBATIONS = "https://prim.iledefrance-mobilites.fr/marketplace/disruptions_bulk/disruptions/v2"
PRIM_API_KEY = os.environ.get("PRIM_API_KEY", "")
MODES_FERRES = {"Metro", "RapidTransit", "LocalTrain", "Tramway", "SuspendedCableCar"}  # tout sauf Bus
JOURS_BRUT_PERTURBATIONS = 3  # relevés bruts gardés sur disque

# Paris, pour la météo (Open-Meteo)
LAT, LON = 48.8566, 2.3522

# Le modèle apprend sur l'après-Covid ; les derniers jours connus servent de test.
TRAIN_START = "2023-01-01"
TEST_DAYS = 90
HORIZON_DAYS = 14

for d in (RAW, SILVER, MODELS, FIGURES):
    d.mkdir(parents=True, exist_ok=True)
