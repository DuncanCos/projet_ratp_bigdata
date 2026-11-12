# Métro Live Data : pipeline de fréquentation

Combien de voyageurs valident leur titre dans chaque gare et station d'Île-de-France, jour par jour depuis
2015, et combien en attendre dans les 14 prochains jours. Les données viennent toutes de sources ouvertes ;
Apache Airflow les collecte et les nettoie, Cassandra les stocke, une API les sert au tableau de bord React.

```
 sources ouvertes ──► Airflow (5 DAGs) ──► Parquet (zone nettoyée) ──► Cassandra ──► API FastAPI ──► web app React
                         │                                                 ▲
                         └── modèle scikit-learn : prédictions, métriques, figures matplotlib
```

## Lancer

```bash
cd pipeline
docker compose up -d --build     # Cassandra, Postgres (métadonnées Airflow), Airflow, API
cd .. && npm install && npm run dev   # tableau de bord sur http://127.0.0.1:1420
```

| Service | Adresse |
|---|---|
| Tableau de bord | http://127.0.0.1:1420 (dans l'appli de bureau : bouton « Données ») |
| Airflow | http://localhost:8080 (sans mot de passe, usage local) |
| API | http://localhost:8000/docs |
| Cassandra | `localhost:9042`, keyspace `metrolive` |

Au premier démarrage tout se charge seul : compter une quinzaine de minutes (160 Mo d'archives, 19 millions
de lignes lues, 3 millions de lignes station-jour écrites), puis l'entraînement du modèle.

## Sources

| Donnée | Source | Format |
|---|---|---|
| Validations par jour et par arrêt, 2015 à 2025 | IDFM, jeu `histo-validations-reseau-ferre` | une archive zip par an |
| Validations des derniers trimestres | IDFM, jeux `validations-reseau-ferre-nombre-validations-par-jour-*` | API d'export CSV |
| Profils horaires par type de jour | IDFM, fichiers `PROFIL_FER` et jeux `…profils-horaires…` | idem |
| Gares, stations, lignes desservies | IDFM, `emplacement-des-gares-idf-data-generalisee` | JSON |
| Couleurs des lignes | IDFM, `referentiel-des-lignes` | JSON |
| Météo de Paris, observée et prévue | Open-Meteo (archive ERA5 et prévision) | JSON |
| Jours fériés | calendrier.api.gouv.fr | JSON |
| Vacances scolaires, zone C | data.education.gouv.fr | JSON |

Aucune clé d'API n'est nécessaire.

## Les DAGs

| DAG | Déclenchement | Rôle |
|---|---|---|
| `validations_historique` | une fois au démarrage, puis à la main (`annees`) | une branche par année : zip, nettoyage, chargement |
| `validations_trimestres` | tous les jours à 5 h | les quatre jeux « trimestre » du portail |
| `contexte` | tous les jours à 5 h 30 | météo, jours fériés, vacances |
| `agregats` | quand des validations ont été chargées | référentiels, puis tables d'agrégats |
| `modele_prediction` | quand les agrégats ou le contexte changent | entraînement, évaluation, prédictions à 14 jours |

Les trois derniers enchaînements passent par des *assets* Airflow : un DAG déclare ce qu'il met à jour,
les suivants s'abonnent. Les branches par année et par trimestre utilisent le *dynamic task mapping*.

## Nettoyage

En onze ans le format publié a changé presque chaque année. `lib/metrodata/transform.py` ramène tout à un
schéma unique :

| Ce qui varie | Valeurs rencontrées |
|---|---|
| Séparateur | `;` ou tabulation |
| Encodage | ASCII, Latin-1, UTF-8 avec ou sans BOM, UTF-16, UTF-8 relu en Latin-1 (« SolidaritÃ© ») |
| Format de fichier | texte, Excel en 2025 |
| Dates | `01/01/2015`, `01/07/24`, `2024-10-01` |
| Colonne de l'arrêt | `ID_REFA_LDA`, `lda`, `ida`, `ID_ZDC`, `ID_ZdC` ; la date s'appelle parfois `Date` |
| Nombres | `1 000`, `71379.0`, `Moins de 5` (secret statistique, remplacé par 2) |
| Catégories de titre | `NAVIGO` puis `Forfait Navigo`, `TST` et `FGT` puis `Contrat Solidarité Transport`, `?`… ramenées à 7 catégories |

Les lignes sans arrêt identifiable (`?`, `ND`) sont rejetées et comptées : le détail par fichier est dans
la table `chargements` et dans l'onglet « Pipeline » du tableau de bord. Un trimestre présent à la fois dans
une archive et dans l'API n'est compté qu'une fois.

## Modèle Cassandra

Une table par requête de l'application, comme le veut Cassandra (pas de jointure, pas d'agrégat à la volée).

| Table | Clé de partition, colonnes de tri | Sert à |
|---|---|---|
| `validations_jour` | `(id_zdc)`, `jour` décroissant | série d'une station, avec le détail par titre |
| `reseau_jour` | `(annee)`, `jour` | série du réseau entier |
| `ligne_jour` | `(ligne)`, `jour` | série d'une ligne |
| `stations_mois` | `(annee, mois)`, `id_zdc` | classement des stations sur une période |
| `profil_horaire` | `(id_zdc)`, `cat_jour`, `heure` | répartition dans la journée |
| `contexte_jour` | `(annee)`, `jour` | météo, férié, vacances |
| `predictions`, `predictions_reseau` | `(id_zdc)`, `jour` | sorties du modèle |
| `modele_metriques`, `chargements` | | suivi du modèle et du pipeline |
| `stations`, `lignes` | | dimensions |

Tous les chargements sont des upserts : rejouer un DAG ne crée pas de doublon. Pour les profils horaires,
chargés en parallèle, l'horodatage d'écriture est fixé d'après la période (`USING TIMESTAMP`) : la plus
récente l'emporte quel que soit l'ordre d'arrivée.

Pour une ligne, on additionne les validations de ses stations ; une station de correspondance compte donc
pour chacune de ses lignes (c'est la fréquentation des stations de la ligne, pas le nombre de voyageurs à bord).

## Modèle de prédiction

Les validations sont publiées avec trois à cinq mois de retard. Le modèle ne peut donc pas regarder la veille
ou la semaine précédente. Pour chaque station et chaque jour, on calcule une **référence** avec des données
vieilles d'au moins 210 jours : la moyenne de la station pour ce jour de la semaine, sur un an. Le modèle
(gradient boosting sur histogrammes, scikit-learn) apprend l'**écart à cette référence** à partir du
calendrier, des jours fériés et des ponts, des vacances scolaires, de la météo et du type de station.

- apprentissage à partir de 2023 (après le Covid), test sur les 90 derniers jours publiés, jamais vus ;
- la référence seule sert de point de comparaison : le modèle doit faire mieux ;
- après l'évaluation, le modèle est réentraîné sur tout l'historique et prédit du dernier jour publié
  jusqu'à 14 jours après aujourd'hui (la prévision météo s'arrête à 16 jours) ;
- métriques, importance des variables et figures matplotlib sont recalculées à chaque entraînement
  (`data/figures/`, onglet « Prédiction »).

## Arborescence

```
pipeline/
  docker-compose.yml
  dags/                 les 5 DAGs
  lib/metrodata/        extract, transform, load, model, db (partagé entre Airflow et l'API)
  api/main.py           API de lecture
  data/                 raw (fichiers publiés), silver (parquet), models, figures ; non versionné
```
