"""Transformation : les fichiers bruts (11 ans de formats différents) deviennent des parquet homogènes.

Ce que les fichiers publiés font varier selon les années :
  séparateur (« ; » ou tabulation), encodage (ASCII, Latin-1, UTF-8 avec ou sans BOM, UTF-16,
  UTF-8 relu en Latin-1), format (texte ou Excel en 2025), dates (JJ/MM/AAAA, JJ/MM/AA, AAAA-MM-JJ),
  nom des colonnes (ID_REFA_LDA, lda, ida, ID_ZDC ; JOUR ou Date), nombres (« 1 000 », « 71379.0 », « Moins de 5 »),
  libellés des catégories de titre.
"""
import io
import re
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as c

# Nomenclature unique des titres, pour comparer 2015 et aujourd'hui.
CATEGORIES = {
    "AMETHYSTE": "Améthyste",
    "AUTRE TITRE": "Autres titres", "AUTRES TITRES": "Autres titres",
    "FGT": "Solidarité Transport", "TST": "Solidarité Transport",
    "CONTRAT SOLIDARITE TRANSPORT": "Solidarité Transport",
    "IMAGINE R": "Imagine R",
    "NAVIGO": "Forfait Navigo", "FORFAIT NAVIGO": "Forfait Navigo",
    "NAVIGO JOUR": "Forfaits courts", "FORFAITS COURTS": "Forfaits courts",
    "NON DEFINI": "Non défini", "?": "Non défini", "": "Non défini",
}
CAT_COLS = sorted(set(CATEGORIES.values()))
# « Moins de 5 » : secret statistique, on prend le milieu de 1..4
MOINS_DE_5 = 2


def _sans_accents(s: pd.Series) -> pd.Series:
    return s.str.normalize("NFKD").str.encode("ascii", "ignore").str.decode("ascii")


def _decode(raw: bytes) -> str:
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")
    if "Ã" in text:  # UTF-8 relu en Latin-1 puis réécrit (« SolidaritÃ© »)
        try:
            text = text.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            text = text.replace("Ã©", "é").replace("Ã¨", "è")
    return text


def read_raw(path: str) -> pd.DataFrame:
    """Lit un fichier publié, quel que soit son format. Tout en texte, colonnes en majuscules."""
    p = Path(path)
    if p.suffix.lower() == ".xlsx":
        df = pd.read_excel(p, dtype=str)
    else:
        text = _decode(p.read_bytes())
        sep = ";" if text.split("\n", 1)[0].count(";") >= 3 else "\t"
        df = pd.read_csv(io.StringIO(text), sep=sep, dtype=str, keep_default_na=False)
    df.columns = [str(col).strip().upper() for col in df.columns]
    return df.rename(columns={"ID_REFA_LDA": "ID_ZDC", "LDA": "ID_ZDC", "IDA": "ID_ZDC", "DATE": "JOUR",
                              "POURC_VALIDATIONS": "POURCENTAGE_VALIDATIONS"})


def _dates(s: pd.Series) -> pd.Series:
    s = s.astype(str).str.strip().str.slice(0, 10)
    sample = s.iloc[0]
    if re.match(r"\d{4}-\d{2}-\d{2}", sample):
        fmt = "%Y-%m-%d"
    elif re.match(r"\d{2}/\d{2}/\d{4}", sample):
        fmt = "%d/%m/%Y"
    else:
        fmt = "%d/%m/%y"
    return pd.to_datetime(s, format=fmt, errors="coerce")


def _zdc(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.astype(str).str.strip(), errors="coerce")  # « ? », « ND », vide -> NaN


def clean_nb(path: str) -> tuple[pd.DataFrame, dict]:
    """Nombre de validations par jour : une ligne par (jour, station), une colonne par catégorie."""
    raw = read_raw(path)
    n_raw = len(raw)
    df = pd.DataFrame({
        "jour": _dates(raw["JOUR"]),
        "id_zdc": _zdc(raw["ID_ZDC"]),
        "libelle": raw["LIBELLE_ARRET"].astype(str).str.strip(),
        "categorie": _sans_accents(raw["CATEGORIE_TITRE"].astype(str).str.strip().str.upper()).map(CATEGORIES),
    })
    nb = raw["NB_VALD"].astype(str).str.replace(r"[\s ]", "", regex=True)
    df["nb"] = pd.to_numeric(nb, errors="coerce")
    df.loc[nb.str.lower().str.startswith("moinsde"), "nb"] = MOINS_DE_5
    inconnues = sorted(set(raw.loc[df["categorie"].isna(), "CATEGORIE_TITRE"].unique()))
    df["categorie"] = df["categorie"].fillna("Non défini")

    bad = df["jour"].isna() | df["id_zdc"].isna() | df["nb"].isna() | (df["id_zdc"] <= 0)
    df = df[~bad].astype({"id_zdc": "int32", "nb": "int64"})

    wide = (df.pivot_table(index=["jour", "id_zdc"], columns="categorie", values="nb", aggfunc="sum", fill_value=0)
              .reindex(columns=CAT_COLS, fill_value=0).astype("int32"))
    wide["total"] = wide.sum(axis=1).astype("int32")
    wide["libelle"] = df.groupby(["jour", "id_zdc"])["libelle"].first()
    wide = wide.reset_index()
    stats = {
        "lignes_brutes": n_raw, "lignes_rejetees": int(bad.sum()), "lignes_chargees": len(wide),
        "jour_min": wide["jour"].min().date().isoformat(), "jour_max": wide["jour"].max().date().isoformat(),
        "categories_inconnues": inconnues,
    }
    return wide, stats


def clean_profil(path: str) -> pd.DataFrame:
    """Profil horaire : part des validations par heure, par station et type de jour."""
    raw = read_raw(path)
    df = pd.DataFrame({
        "id_zdc": _zdc(raw["ID_ZDC"]),
        "cat_jour": raw["CAT_JOUR"].astype(str).str.strip().str.upper(),
        "heure": pd.to_numeric(raw["TRNC_HORR_60"].astype(str).str.extract(r"^(\d+)H")[0], errors="coerce"),
        "pourcentage": pd.to_numeric(raw["POURCENTAGE_VALIDATIONS"].astype(str).str.replace(",", "."), errors="coerce"),
    }).dropna()
    df = df[df["id_zdc"] > 0].astype({"id_zdc": "int32", "heure": "int16"})
    # plusieurs codes d'arrêt pour une même zone de correspondance : on moyenne
    return df.groupby(["id_zdc", "cat_jour", "heure"], as_index=False)["pourcentage"].mean()


def to_silver(path: str, nom: str) -> dict:
    """Nettoie un fichier « nombre » et l'écrit en parquet. Retourne les compteurs qualité."""
    wide, stats = clean_nb(path)
    out = c.SILVER / "validations" / f"{nom}.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    wide.to_parquet(out, index=False)
    return {**stats, "silver": str(out), "nom": nom}


def profil_to_silver(path: str, nom: str) -> str:
    out = c.SILVER / "profils" / f"{nom}.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    clean_profil(path).to_parquet(out, index=False)
    return str(out)


def all_validations() -> pd.DataFrame:
    """Toute la zone silver, dédoublonnée (un trimestre peut exister dans l'archive et dans l'API)."""
    files = sorted((c.SILVER / "validations").glob("*.parquet"))  # « histo_* » avant « trimestre_* »
    if not files:
        raise FileNotFoundError("zone silver vide : lancer d'abord le DAG validations_historique")
    df = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    return df.drop_duplicates(["jour", "id_zdc"], keep="last").sort_values(["jour", "id_zdc"], ignore_index=True)


# ---------- référentiels ----------

def stations_et_lignes(gares: list[dict], lignes_ref: list[dict]) -> tuple[pd.DataFrame, pd.DataFrame]:
    couleurs = {l["id_line"]: l for l in lignes_ref}
    st, li = {}, {}
    for g in gares:
        zdc = g.get("id_ref_zdc")
        if not zdc or not g.get("geo_point_2d"):
            continue
        s = st.setdefault(int(zdc), {"nom": g.get("nom_zdc") or g.get("nom_long"), "lat": [], "lon": [],
                                     "lignes": set(), "modes": set()})
        s["lat"].append(g["geo_point_2d"]["lat"])
        s["lon"].append(g["geo_point_2d"]["lon"])
        noms = [x.strip() for x in (g.get("res_com") or "").split("/")]
        ids = [x.strip() for x in (g.get("idrefligc") or "").split("/")]
        for nom, lid in zip(noms, ids):
            if not lid:
                continue
            mode = nom.split(" ")[0] if " " in nom else (g.get("mode") or "").split("/")[0].strip()
            ref = couleurs.get(lid, {})
            l = li.setdefault(lid, {"nom": nom, "mode": mode, "couleur": "#" + (ref.get("colourweb_hexa") or "5b6672"),
                                    "couleur_texte": "#" + (ref.get("textcolourweb_hexa") or "ffffff"), "stations": set()})
            l["stations"].add(int(zdc))
            s["lignes"].add(lid)
            s["modes"].add(mode)
    stations = pd.DataFrame([{"id_zdc": k, "nom": v["nom"], "lat": float(np.mean(v["lat"])), "lon": float(np.mean(v["lon"])),
                              "lignes": v["lignes"], "modes": v["modes"]} for k, v in st.items()])
    lignes = pd.DataFrame([{"id": k, **v} for k, v in li.items()])
    return stations, lignes


# ---------- contexte ----------

def contexte(meteo_archive: dict, meteo_prevision: dict, feries: dict, vacances: list[dict]) -> pd.DataFrame:
    def meteo(j, prevision):
        d = pd.DataFrame(j["daily"]).rename(columns={"time": "jour", "temperature_2m_max": "tmax",
                                                     "temperature_2m_min": "tmin", "precipitation_sum": "pluie_mm"})
        d["jour"] = pd.to_datetime(d["jour"])
        d["prevision"] = prevision
        return d.dropna(subset=["tmax"])

    arch, prev = meteo(meteo_archive, False), meteo(meteo_prevision, True)
    prev.loc[prev["jour"] < pd.Timestamp.today().normalize(), "prevision"] = False
    df = pd.concat([arch, prev[~prev["jour"].isin(arch["jour"])]], ignore_index=True).sort_values("jour")

    df["ferie"] = df["jour"].dt.strftime("%Y-%m-%d").map(feries)
    df["vacances"] = None
    for v in vacances:
        # dates en UTC (22 h la veille) ; la fin est le jour de reprise, exclu
        a = pd.Timestamp(v["start_date"]).tz_convert("Europe/Paris").tz_localize(None).normalize()
        b = pd.Timestamp(v["end_date"]).tz_convert("Europe/Paris").tz_localize(None).normalize()
        if b > a:
            df.loc[(df["jour"] >= a) & (df["jour"] < b), "vacances"] = v["description"]
    return df.reset_index(drop=True)
