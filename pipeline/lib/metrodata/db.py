"""Accès Cassandra : session partagée, schéma, écritures en masse."""
import time
from functools import lru_cache

from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.concurrent import execute_concurrent_with_args
from cassandra.policies import RoundRobinPolicy
from cassandra.query import dict_factory

from .config import CASSANDRA_HOSTS, KEYSPACE

_PERTURBATION = """
        jour date, ligne text, id text, nom_ligne text, mode text, titre text, message text, message_court text,
        gravite text, cause text, debut timestamp, fin timestamp, maj timestamp, toute_la_ligne boolean,
        stations set<int>, premiere_vue timestamp, derniere_vue timestamp, nb_releves int,"""
COLONNES_PERTURBATION = ["jour", "ligne", "id", "nom_ligne", "mode", "titre", "message", "message_court", "gravite",
                         "cause", "debut", "fin", "maj", "toute_la_ligne", "stations", "premiere_vue", "derniere_vue",
                         "nb_releves"]

# Une table par besoin de lecture de l'API (modélisation Cassandra « par requête »).
SCHEMA = [
    f"CREATE KEYSPACE IF NOT EXISTS {KEYSPACE} WITH replication = {{'class': 'SimpleStrategy', 'replication_factor': 1}}",
    # dimensions
    """CREATE TABLE IF NOT EXISTS stations (
        id_zdc int PRIMARY KEY, nom text, lat double, lon double,
        lignes set<text>, modes set<text>, moyenne_jour double, dernier_jour date)""",
    """CREATE TABLE IF NOT EXISTS lignes (
        id text PRIMARY KEY, nom text, mode text, couleur text, couleur_texte text, stations set<int>)""",
    # faits : une partition par station, les jours les plus récents d'abord
    """CREATE TABLE IF NOT EXISTS validations_jour (
        id_zdc int, jour date, total int, categories map<text, int>,
        PRIMARY KEY ((id_zdc), jour)) WITH CLUSTERING ORDER BY (jour DESC)""",
    # agrégats
    """CREATE TABLE IF NOT EXISTS reseau_jour (
        annee int, jour date, total bigint, categories map<text, bigint>, nb_stations int,
        PRIMARY KEY ((annee), jour))""",
    """CREATE TABLE IF NOT EXISTS ligne_jour (
        ligne text, jour date, total bigint,
        PRIMARY KEY ((ligne), jour))""",
    """CREATE TABLE IF NOT EXISTS stations_mois (
        annee int, mois int, id_zdc int, total bigint, nb_jours int,
        PRIMARY KEY ((annee, mois), id_zdc))""",
    """CREATE TABLE IF NOT EXISTS profil_horaire (
        id_zdc int, cat_jour text, heure int, pourcentage double, periode text,
        PRIMARY KEY ((id_zdc), cat_jour, heure))""",
    # contexte : météo (observée puis prévue), jours fériés, vacances scolaires zone C
    """CREATE TABLE IF NOT EXISTS contexte_jour (
        annee int, jour date, tmax double, tmin double, pluie_mm double,
        ferie text, vacances text, prevision boolean,
        PRIMARY KEY ((annee), jour))""",
    # modèle
    """CREATE TABLE IF NOT EXISTS predictions (
        id_zdc int, jour date, prevu int, modele text,
        PRIMARY KEY ((id_zdc), jour))""",
    """CREATE TABLE IF NOT EXISTS predictions_reseau (
        k int, jour date, prevu bigint, modele text,
        PRIMARY KEY ((k), jour))""",
    """CREATE TABLE IF NOT EXISTS modele_metriques (
        modele text PRIMARY KEY, entraine_le timestamp, train_debut date, train_fin date,
        test_debut date, test_fin date, n_train int, n_test int,
        mae double, wape double, r2 double, mae_reference double, wape_reference double,
        importances map<text, double>)""",
    # perturbations relevées sur PRIM : tout le réseau un jour donné (rejeu d'une journée)…
    f"""CREATE TABLE IF NOT EXISTS perturbations_jour ({_PERTURBATION}
        PRIMARY KEY ((jour), ligne, id))""",
    # … et l'historique d'une ligne (croisement avec les validations)
    f"""CREATE TABLE IF NOT EXISTS perturbations_ligne ({_PERTURBATION}
        PRIMARY KEY ((ligne), jour, id)) WITH CLUSTERING ORDER BY (jour DESC, id ASC)""",
    # temps réel PRIM envoyé par l'appli de bureau : positions réelles d'une ligne un jour donné (rejeu)…
    """CREATE TABLE IF NOT EXISTS positions_temps_reel (
        ligne text, jour date, releve timestamp, train text, de int, vers int,
        depart timestamp, arrivee timestamp, a_quai boolean, destination text,
        PRIMARY KEY ((ligne, jour), releve, train))""",
    # … et passages à une station : heure attendue contre heure prévue (retards)
    """CREATE TABLE IF NOT EXISTS passages_temps_reel (
        ligne text, jour date, station int, releve timestamp, attendu timestamp, destination text,
        direction text, prevu timestamp, quai text, a_quai boolean, statut text,
        PRIMARY KEY ((ligne, jour), station, releve, attendu, destination))""",
    # journal des chargements, pour la page « pipeline » et la qualité des données
    """CREATE TABLE IF NOT EXISTS chargements (
        source text, periode text, charge_le timestamp, lignes_brutes int, lignes_rejetees int,
        lignes_chargees int, jour_min date, jour_max date,
        PRIMARY KEY ((source), periode))""",
]


@lru_cache(maxsize=1)
def session():
    profile = ExecutionProfile(
        load_balancing_policy=RoundRobinPolicy(), request_timeout=60, row_factory=dict_factory
    )
    last = None
    for _ in range(30):  # Cassandra met une bonne minute à démarrer
        try:
            cluster = Cluster(CASSANDRA_HOSTS, execution_profiles={EXEC_PROFILE_DEFAULT: profile}, protocol_version=5)
            s = cluster.connect()
            break
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5)
    else:
        raise RuntimeError(f"Cassandra injoignable ({CASSANDRA_HOSTS}) : {last}")
    s.execute(SCHEMA[0])
    s.set_keyspace(KEYSPACE)
    for stmt in SCHEMA[1:]:
        s.execute(stmt)
    return s


def upsert(table: str, columns: list[str], rows, concurrency: int = 64, timestamp: int | None = None) -> int:
    """INSERT (= upsert en Cassandra) de `rows` (tuples dans l'ordre de `columns`). Idempotent.

    `timestamp` fixe l'horodatage d'écriture : Cassandra garde la valeur au plus grand horodatage,
    quel que soit l'ordre d'arrivée (utile quand plusieurs périodes se chargent en parallèle)."""
    s = session()
    using = f" USING TIMESTAMP {int(timestamp)}" if timestamp else ""
    stmt = s.prepare(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))}){using}")
    rows = list(rows)
    for ok, res in execute_concurrent_with_args(s, stmt, rows, concurrency=concurrency, raise_on_first_error=False):
        if not ok:
            raise res
    return len(rows)


def query(cql: str, params=None) -> list[dict]:
    return list(session().execute(cql, params or ()))
