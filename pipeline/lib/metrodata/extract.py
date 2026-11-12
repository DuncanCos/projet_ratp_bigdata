"""Extraction : téléchargement des sources ouvertes dans la zone brute (RAW), sans transformation."""
import json
import re
import zipfile
from datetime import date, timedelta
from pathlib import Path

import requests

from . import config as c

UA = {"User-Agent": "metrodata-etl (projet etudiant)"}


def _get(url: str, **params) -> requests.Response:
    r = requests.get(url, params=params or None, headers=UA, timeout=300)
    r.raise_for_status()
    return r


def _download(url: str, dest: Path, **params) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, params=params or None, headers=UA, timeout=600, stream=True) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.replace(dest)
    return dest


# ---------- validations : historique annuel (archives zip) ----------

def histo_index() -> dict[int, str]:
    """{année: url du zip} d'après le jeu « historique »."""
    rows = _get(f"{c.PORTAIL}/{c.HISTO}/records", limit=100).json()["results"]
    return {int(r["annee"]): r["reseau_ferre"]["url"] for r in rows}


def download_histo(annee: int) -> dict[str, list[str]]:
    """Télécharge et décompresse une année. Retourne les fichiers « nombre » et « profil »."""
    url = histo_index()[annee]
    dest = c.RAW / "histo" / str(annee)
    zpath = _download(url, c.RAW / "histo" / f"{annee}.zip")
    with zipfile.ZipFile(zpath) as z:
        z.extractall(dest)
    files = [p for p in dest.rglob("*") if p.is_file()]
    return {
        "nb": sorted(str(p) for p in files if re.search(r"_NB_", p.name, re.I)),
        "profil": sorted(str(p) for p in files if re.search(r"PROFIL", p.name, re.I)),
    }


# ---------- validations : trimestres courants (API d'export) ----------

def _periode_du_titre(titre: str) -> str:
    """« ... (2ème trimestre 2026) » -> « 2026-T2 »"""
    m = re.search(r"\((\d)\w*\s+trimestre\s+(\d{4})\)", titre)
    return f"{m.group(2)}-T{m.group(1)}" if m else "inconnu"


def download_trimestre(rang: str) -> dict[str, str]:
    out = {}
    for kind, pattern in (("nb", c.NB_TRIMESTRE), ("profil", c.PROFIL_TRIMESTRE)):
        ds = pattern.format(rang)
        meta = _get(f"{c.PORTAIL}/{ds}").json()
        out["periode"] = _periode_du_titre(meta["metas"]["default"]["title"])
        out[kind] = str(_download(f"{c.PORTAIL}/{ds}/exports/csv", c.RAW / "trimestre" / f"{rang}_{kind}.csv",
                                  delimiter=";"))
    return out


# ---------- référentiels ----------

def download_referentiels() -> dict[str, str]:
    return {
        "gares": str(_download(f"{c.PORTAIL}/{c.GARES}/exports/json", c.RAW / "ref" / "gares.json")),
        "lignes": str(_download(f"{c.PORTAIL}/{c.LIGNES}/exports/json", c.RAW / "ref" / "lignes.json")),
    }


# ---------- contexte : météo, jours fériés, vacances ----------

def download_contexte(debut: str = "2015-01-01") -> dict[str, str]:
    d = c.RAW / "contexte"
    daily = "temperature_2m_max,temperature_2m_min,precipitation_sum"
    common = dict(latitude=c.LAT, longitude=c.LON, daily=daily, timezone="Europe/Paris")
    # l'archive (réanalyse ERA5) a quelques jours de retard : le flux de prévision couvre le trou et l'avenir
    fin_archive = (date.today() - timedelta(days=7)).isoformat()
    return {
        "meteo_archive": str(_download("https://archive-api.open-meteo.com/v1/archive", d / "meteo_archive.json",
                                       start_date=debut, end_date=fin_archive, **common)),
        "meteo_prevision": str(_download("https://api.open-meteo.com/v1/forecast", d / "meteo_prevision.json",
                                         past_days=14, forecast_days=16, **common)),
        "feries": str(_download("https://calendrier.api.gouv.fr/jours-feries/metropole.json", d / "feries.json")),
        "vacances": str(_download(
            "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/exports/json",
            d / "vacances.json", where='zones="Zone C" and location="Paris"')),
    }


def read_json(path: str):
    return json.loads(Path(path).read_text(encoding="utf-8"))
