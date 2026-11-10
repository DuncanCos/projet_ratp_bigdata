# Métro Live

Application de bureau (Rust + Tauri 2, React, Tailwind) qui affiche en temps réel la position estimée
des rames sur les 16 lignes du métro parisien et les 5 lignes de RER (A à E), à partir des données
d'Île-de-France Mobilités.

## Lancer

```bash
npm install
npm run tauri dev        # développement
npm run tauri build      # binaire + paquets (deb/rpm/AppImage)
```

Sans clé API l'application fonctionne en **mode démo** : les trains sont simulés à partir des temps
de parcours théoriques du GTFS. Pour le temps réel :

1. créer un compte sur <https://prim.iledefrance-mobilites.fr> et générer un jeton API ;
2. le coller via le bouton « Clé API » (stocké dans `~/.config/fr.ipssi.metrolive/config.json`),
   ou lancer avec `PRIM_API_KEY=xxx npm run tauri dev`.

## Sources de données

| Donnée | Source | Usage |
|---|---|---|
| Stations, quais, ordre des stations, branches, temps de parcours, tracé des voies | GTFS IDFM (statique) | `src/data/metro.json`, généré par `scripts/build_metro_data.py` |
| Prochains passages de chaque course | PRIM `estimated-timetable` (SIRI Lite) | position des trains |
| Prochains passages à une station | PRIM `stop-monitoring` | panneau station |
| Perturbations et travaux (tout le réseau, 1 appel) | PRIM `disruptions_bulk/disruptions/v2` | info trafic |

Régénérer la topologie (≈ 1 Go décompressé) :

```bash
curl -O https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip
unzip IDFM-gtfs.zip -d gtfs routes.txt stops.txt trips.txt stop_times.txt shapes.txt transfers.txt
python3 scripts/build_metro_data.py gtfs
```

## Comment la position des trains est calculée

Le métro ne publie pas de GPS, et dans le flux RATP une « course » SIRI n'est pas un vrai train :
elle regroupe le n-ième prochain passage de chaque station. On raisonne donc station par station.
Pour chaque sens et chaque station B, on garde le prochain passage annoncé. S'il arrive dans moins
que le temps de parcours depuis la station précédente A (médiane du GTFS), le train est forcément
sur le segment A→B, avec un avancement de `1 − (t − maintenant) / durée(A→B)`. Chaque train n'est
ainsi compté qu'une fois. Les annonces « Métro à quai » et « Métro à l'approche » (champs `CallNote`
/ `ArrivalProximityText`) sont prioritaires même si leur heure est déjà passée ; un train attendu en B
dans moins de « trajet + 60 s » est considéré à quai en A. Le sens est donné par le quai de destination (`DestinationRef`), ce qui
gère aussi les branches et les trains qui terminent avant le terminus. Le front interpole la
position toutes les 500 ms entre deux rafraîchissements. Code : `src-tauri/src/positions.rs`.

Vérifier sur une vraie réponse enregistrée :
`ET_JSON=reponse.json cargo test real_response -- --ignored --nocapture` (dans `src-tauri/`).

## RER

Les RER sont générés par `build_rer` dans `scripts/build_metro_data.py`. Ils diffèrent du métro sur
plusieurs points :

- **missions** : beaucoup de trains ne s'arrêtent pas partout (directs, semi-directs). Le GTFS ne
  donne que les gares desservies, et son `direction_id` n'est pas fiable. Deux gares sont considérées
  **voisines** si elles se suivent dans une mission et qu'aucune autre mission ne s'arrête entre elles.
  On en déduit des **parcours** omnibus (toutes les gares, choisis pour couvrir toutes les voies). Ils
  servent au tracé, au plan de ligne (un onglet par parcours, ex. « Cergy le Haut – Marne-la-Vallée »)
  et à l'info trafic. Les missions réelles sont gardées dans `services` ;
- **quais** : le GTFS RER désigne la zone d'arrêt (`monomodalStopPlace`). Les quais utilisés par le
  temps réel viennent du référentiel des arrêts (`zdaid`) ;
- **tracé** : il est assemblé tronçon par tronçon à partir de plusieurs tracés GTFS (couverture 100 %).
  Un train direct suit les voies entre ses deux arrêts (`segmentPoints` dans `src/lib/metro.ts`) ;
- **temps réel** : une course SIRI RER est un vrai train. Chaque course est placée entre l'arrêt
  qu'elle vient de quitter et le prochain qu'elle dessert. Quand seuls les arrêts à venir sont connus,
  la gare précédente est déduite de la mission qui correspond le mieux. Les courses et arrêts
  supprimés (`Cancellation`, `cancelled`) sont ignorés (`from_vehicles` dans `positions.rs`) ;
- **simulation** : environ un train toutes les 3 min par sens sur le tronc commun, réparti entre les
  missions selon leur nombre de courses ;
- **correspondances** : en plus des gares de même nom, celles de `transfers.txt` à moins de 10 min
  et 500 m à pied (Châtelet ↔ Châtelet - Les Halles, Gare du Nord ↔ Magenta, Opéra ↔ Auber…) ;
- **itinéraire** : un tronçon qu'aucune mission ne fait d'un bout à l'autre est coupé (« Changement de
  train à Nanterre - Préfecture »). Le trajet peut aussi commencer ou finir par une marche vers une
  gare d'un autre nom.

Le temps réel RER n'a pas encore été vérifié sur une vraie réponse PRIM (quota épuisé le jour de
l'ajout). Pour le vérifier : `ET_JSON=reponse.json LINE=C01742 cargo test real_response -- --ignored --nocapture`.

## Tracé des voies

Le tracé de chaque parcours vient de `shapes.txt` (GTFS), simplifié à 2 m près. Chaque station est
accrochée au tracé par programmation dynamique (ordre des stations respecté, distance totale
minimale, 250 m maximum). Les tronçons absents du GTFS, comme certains prolongements récents
(ligne 4 vers Bagneux), sont tracés en ligne droite. Couverture : 87 à 100 % selon les lignes.
Les trains avancent le long de ce tracé, et les stations sont placées sur la voie.

## Panneau station : correspondances et accessibilité

Calculées à la génération de `metro.json` :

- **correspondances métro** : même zone d'arrêt (ou même nom à moins de 400 m), avec le temps
  de correspondance minimal entre quais de `transfers.txt` ;
- **RER, Transilien, tram, câble** : arrêts du jeu « arrêts-lignes » à moins de 120 m, ou à
  moins de 400 m avec un mot du nom en commun ; couleurs du référentiel des lignes ;
- **accessibilité** (fauteuil, annonces sonores et visuelles) : par quai de la ligne, depuis le
  GTFS (`wheelchair_boarding`) et le référentiel des arrêts. « Partiellement » quand les quais
  ne sont pas tous équipés (ex. ligne 14 à Gare de Lyon, d'après la source).

## Info trafic

Un seul appel toutes les 2 minutes (cache côté Rust) récupère les perturbations de tout le réseau.
Pour chaque ligne de métro, on garde celles en cours et celles qui commencent dans les 7 jours
(périodes en heure de Paris). Les stations touchées viennent des quais, des zones d'arrêt et des
tronçons interrompus (`impactedSections`, développés le long de la ligne).

- pastille rouge (bloquante) ou orange (perturbée) dans la barre des lignes ;
- liste des lignes perturbées dans l'encart en haut à gauche ;
- détail dans le plan de ligne, stations touchées barrées et entourées de rouge sur la carte.

Vérifier sur une réponse enregistrée : `INFO_JSON=disruptions.json cargo test real_traffic -- --ignored --nocapture`.

## Itinéraire

Bouton « Itinéraire » en haut à droite, ou « Partir d'ici / Y aller » dans le panneau d'une station.

- **Calcul** (`src/lib/route.ts`, côté front, sans appel réseau) : Dijkstra sur le graphe (ligne, station).
  Arcs = segments GTFS orientés (boucles 7bis et 10 à sens unique) et correspondances
  (`transfers.txt` + 2 min d'attente, + 1 min de pénalité pour préférer le direct).
- **Plusieurs trajets** (jusqu'à 4) : le plus rapide, celui avec le moins de correspondances, et des
  variantes qui changent à une autre station ou se passent d'une ligne du trajet le plus rapide.
  Doublons et détours trop longs (plus de 50 % et 10 min de plus) écartés. Le trajet choisi est tracé.
- **Éviter le trafic interrompu** : les stations touchées par une perturbation bloquante en cours sont
  contournées.
- **Résultat** : durée, heure d'arrivée estimée, tronçons (« Métro 12 vers … »), correspondances,
  perturbations sur le trajet, prochain train au départ (1 requête `stop-monitoring` par minute),
  tracé sur la carte. Seule la première ligne du trajet passe en temps réel (quota).
- **Tracer moi-même** : onglet du panneau Itinéraire. On touche une station sur la carte, ou on glisse
  le doigt de station en station (un appui loin des stations déplace la carte). Le trajet suit la ligne
  en cours. Toucher une station d'une autre ligne qui passe là où l'on est fait la correspondance à
  cette intersection. Toucher une station déjà parcourue revient en arrière. Boutons Annuler, Effacer
  et « Compléter jusqu'à l'arrivée » (trajet le plus rapide depuis la dernière station). Code :
  `extendPath`, `completePath`, `journeyFromPath` dans `src/lib/route.ts`, `DrawLayer` dans `MapView.tsx`.
  Pendant le tracé, la carte zoome sur la station de départ et ne montre que la ligne en cours (au
  départ : celles du lieu de départ) et les lignes qui la croisent, sans les trains.
- **Sauvegarde** (`src/lib/trips.ts`, stockage local) : trajets enregistrés avec un nom (renommer,
  supprimer, trajet retour ; un tracé à la main est enregistré tel quel), 6 recherches récentes, dernière recherche retrouvée au lancement.

## Architecture

```
src-tauri/src/
  lib.rs        commandes Tauri (get_trains, get_departures, set_api_key…), cache 20 s par ligne
  prim.rs       client HTTP PRIM + parsing SIRI Lite
  positions.rs  estimation des positions + simulation (mode démo)
  topology.rs   topologie embarquée (include_str! de metro.json)
  traffic.rs    info trafic (perturbations, travaux)
src/
  App.tsx                 mise en page, polling
  components/MapView.tsx  carte Leaflet (OSM) avec lignes, stations, trains
  components/StripMap.tsx plan de ligne vertical, une voie par sens
  components/StationPanel.tsx prochains passages
  components/TripPlanner.tsx  itinéraire et trajets enregistrés
  lib/route.ts            calcul d'itinéraire
  lib/trips.ts            trajets enregistrés et récents
```

## Quotas PRIM

Chaque service PRIM est limité à **1 000 requêtes par jour** par jeton (en-têtes
`x-ratelimit-remaining-day`, remise à zéro vers 1 h du matin). Suivre les 16 lignes en continu est
donc impossible. Par défaut :

- seule la ligne choisie est en temps réel (1 requête toutes les 2 minutes, environ 720 par jour) ;
- les autres lignes affichées sont **simulées** (temps de parcours du GTFS, un train toutes les
  4 minutes environ), et l'interface le dit ;
- en cas de quota épuisé (429), l'app n'appelle plus PRIM jusqu'à la remise à zéro et passe en
  simulation ;
- le quota restant s'affiche dans les réglages. « Tout le réseau en temps réel » reste disponible,
  mais épuise le quota en une heure environ.

Pour aller plus loin, on peut demander une hausse de quota sur PRIM.

## Interface

React, Tailwind 4 et shadcn/ui (Radix, preset Nova, palette du projet dans `src/index.css`).

- **Choix des lignes affichées** : tiroir vaul (`src/components/LineDrawer.tsx`), mémorisé dans le
  navigateur ; en bas sur téléphone, à gauche sur ordinateur.
- **Sous 768 px** : lignes en bandeau défilant en haut, panneau ligne/station en tiroir en bas
  (`Sheet.tsx`, trois hauteurs).
- Réglages : `Popover`, `Select`, `Switch`. Clé API : `Dialog`.

Tests Rust : `cd src-tauri && cargo test`.
