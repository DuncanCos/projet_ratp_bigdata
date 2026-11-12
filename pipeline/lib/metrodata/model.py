"""Modèle de prédiction de la fréquentation quotidienne par station.

Les validations sont publiées avec plusieurs mois de retard : le modèle ne peut donc pas s'appuyer sur
« hier » ou « la semaine dernière ». Pour chaque station et chaque jour on calcule une *référence* à
partir de données vieilles d'au moins RETARD jours (moyenne du même jour de semaine sur un an), et le
modèle apprend l'écart à cette référence en fonction du calendrier et de la météo.

    cible = log(validations + 1) - log(référence + 1)

La référence seule sert de point de comparaison : le modèle doit faire mieux qu'elle.
"""
from datetime import date, datetime, timedelta, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import r2_score

from . import config as c
from . import db
from .transform import all_validations

RETARD = 210  # jours : âge minimal des données utilisées pour la référence
FEATURES = ["jour_semaine", "mois", "jour_annee", "ferie", "veille_ferie", "lendemain_ferie", "pont",
            "vacances", "vacances_ete", "tmax", "tmin", "pluie_mm",
            "log_ref", "ratio_moyenne", "ratio_an_passe", "tendance",
            "metro", "rer", "train", "nb_lignes", "distance_centre_km"]
LIBELLES = {
    "jour_semaine": "Jour de la semaine", "mois": "Mois", "jour_annee": "Jour de l'année", "ferie": "Jour férié",
    "veille_ferie": "Veille de férié", "lendemain_ferie": "Lendemain de férié", "pont": "Pont",
    "vacances": "Vacances scolaires", "vacances_ete": "Vacances d'été", "tmax": "Température max",
    "tmin": "Température min", "pluie_mm": "Pluie", "log_ref": "Niveau habituel de la station",
    "ratio_moyenne": "Poids du jour dans la semaine", "ratio_an_passe": "Même jour un an avant",
    "tendance": "Tendance récente de la station", "metro": "Station de métro", "rer": "Gare RER",
    "train": "Gare Transilien", "nb_lignes": "Nombre de lignes", "distance_centre_km": "Distance à Châtelet",
}


def _contexte() -> pd.DataFrame:
    df = pd.DataFrame(db.query("SELECT jour, tmax, tmin, pluie_mm, ferie, vacances FROM contexte_jour"))
    if df.empty:
        raise RuntimeError("contexte_jour vide : lancer d'abord le DAG contexte")
    df["jour"] = pd.to_datetime(df["jour"].map(lambda d: d.date()))
    df = df.sort_values("jour").set_index("jour")
    f = df["ferie"].notna()
    out = pd.DataFrame({
        "ferie": f.astype(int),
        "veille_ferie": f.shift(-1, fill_value=False).astype(int),
        "lendemain_ferie": f.shift(1, fill_value=False).astype(int),
        "vacances": df["vacances"].notna().astype(int),
        "vacances_ete": df["vacances"].fillna("").str.contains("t[ée]", case=False, regex=True).astype(int),
        "tmax": df["tmax"], "tmin": df["tmin"], "pluie_mm": df["pluie_mm"],
    })
    dow = out.index.dayofweek
    # vendredi après un jeudi férié, lundi avant un mardi férié
    out["pont"] = (((dow == 4) & (out["lendemain_ferie"] == 1)) | ((dow == 0) & (out["veille_ferie"] == 1))).astype(int)
    return out


def _stations() -> pd.DataFrame:
    df = pd.DataFrame(db.query("SELECT id_zdc, lat, lon, lignes, modes FROM stations"))
    modes = df["modes"].map(lambda m: set(m or []))
    out = pd.DataFrame({
        "id_zdc": df["id_zdc"],
        "metro": modes.map(lambda m: int("METRO" in m)), "rer": modes.map(lambda m: int("RER" in m)),
        "train": modes.map(lambda m: int("TRAIN" in m)),
        "nb_lignes": df["lignes"].map(lambda l: len(l or [])),
    })
    # distance à Châtelet (approximation plane, suffisante à cette échelle)
    out["distance_centre_km"] = np.hypot((df["lat"] - 48.8585) * 111.2, (df["lon"] - 2.3470) * 73.2)
    return out


def build_dataset(fin: date) -> tuple[pd.DataFrame, pd.Timestamp]:
    """Une ligne par (jour, station) du début de l'apprentissage à `fin` ; `total` vide au-delà des données."""
    val = all_validations()[["jour", "id_zdc", "total"]]
    dernier = val["jour"].max()
    jours = pd.date_range(val["jour"].min(), pd.Timestamp(fin))
    P = val.pivot(index="jour", columns="id_zdc", values="total").reindex(jours)

    # référence : moyenne du même jour de semaine sur 52 semaines, décalée de RETARD jours
    sem = RETARD // 7
    ref = pd.concat([P.iloc[k::7].rolling(52, min_periods=20).mean().shift(sem) for k in range(7)]).sort_index()
    moy = P.rolling(364, min_periods=120).mean().shift(RETARD)          # tous jours confondus
    an = P.shift(364)                                                   # même jour de semaine, un an avant
    # dynamique récente : 8 dernières semaines connues contre les mêmes semaines un an plus tôt
    court = P.rolling(56, min_periods=28).mean().shift(RETARD)
    tendance = court / court.shift(364)

    def long(m, name):
        return m.stack(future_stack=True).rename(name)

    df = pd.concat([long(P, "total"), long(ref, "ref"), long(moy, "moy"), long(an, "an"), long(tendance, "tendance")],
                   axis=1).reset_index(names=["jour", "id_zdc"])
    df = df[(df["jour"] >= c.TRAIN_START) & df["ref"].notna() & (df["ref"] >= 50)]  # stations fermées ou marginales
    df = df[df["total"].notna() | (df["jour"] > dernier)]

    df["log_ref"] = np.log1p(df["ref"])
    df["ratio_moyenne"] = df["ref"] / df["moy"].clip(lower=1)
    df["ratio_an_passe"] = (df["an"] / df["ref"]).clip(upper=5)
    df["tendance"] = df["tendance"].clip(0.2, 5)
    df["jour_semaine"], df["mois"], df["jour_annee"] = df["jour"].dt.dayofweek, df["jour"].dt.month, df["jour"].dt.dayofyear
    df = df.merge(_contexte(), left_on="jour", right_index=True, how="left").merge(_stations(), on="id_zdc", how="left")
    df["y"] = np.log1p(df["total"]) - df["log_ref"]
    return df.reset_index(drop=True), dernier


def _fit(df: pd.DataFrame) -> HistGradientBoostingRegressor:
    m = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.06, max_leaf_nodes=63, min_samples_leaf=40,
                                      l2_regularization=1.0, categorical_features=[0], random_state=0)
    return m.fit(df[FEATURES], df["y"])


def _predict(m, df: pd.DataFrame) -> np.ndarray:
    return np.clip(np.expm1(m.predict(df[FEATURES]) + df["log_ref"]), 0, None)


def _scores(reel, prevu) -> dict:
    err = np.abs(reel - prevu)
    return {"mae": float(err.mean()), "wape": float(err.sum() / reel.sum()), "r2": float(r2_score(reel, prevu))}


def train() -> dict:
    """Entraîne, évalue sur les derniers jours connus, écrit prédictions, métriques et figures."""
    horizon = date.today() + timedelta(days=c.HORIZON_DAYS)
    df, dernier = build_dataset(horizon)
    connu = df[df["total"].notna()]
    test_debut = dernier - pd.Timedelta(days=c.TEST_DAYS - 1)
    train_df, test_df = connu[connu["jour"] < test_debut], connu[connu["jour"] >= test_debut].copy()

    modele = _fit(train_df)
    test_df["prevu"] = _predict(modele, test_df)
    s, s_ref = _scores(test_df["total"], test_df["prevu"]), _scores(test_df["total"], test_df["ref"])

    ech = test_df.sample(min(len(test_df), 20000), random_state=0)
    imp = permutation_importance(modele, ech[FEATURES], ech["y"], n_repeats=3, random_state=0,
                                 scoring="neg_mean_absolute_error").importances_mean
    importances = {LIBELLES[f]: float(max(v, 0)) for f, v in zip(FEATURES, imp)}

    # modèle final : tout l'historique connu, pour prédire après le dernier jour publié
    final = _fit(connu)
    futur = df[df["total"].isna()].copy()
    futur["prevu"] = _predict(final, futur)
    version = f"hgb-{datetime.now(timezone.utc):%Y%m%d-%H%M}"
    joblib.dump({"modele": final, "features": FEATURES, "version": version}, c.MODELS / "frequentation.joblib")

    pred = pd.concat([test_df[["id_zdc", "jour", "prevu"]], futur[["id_zdc", "jour", "prevu"]]])
    # pas de TRUNCATE : l'API continue de servir les anciennes prédictions pendant l'écriture des nouvelles
    db.upsert("predictions", ["id_zdc", "jour", "prevu", "modele"],
              ((int(z), j.date(), int(round(p)), version) for z, j, p in zip(pred["id_zdc"], pred["jour"], pred["prevu"])))
    res = pred.groupby("jour")["prevu"].sum()
    db.upsert("predictions_reseau", ["k", "jour", "prevu", "modele"],
              ((0, j.date(), int(round(p)), version) for j, p in res.items()))
    anciens = [r["modele"] for r in db.query("SELECT modele FROM modele_metriques")]
    db.upsert("modele_metriques",
              ["modele", "entraine_le", "train_debut", "train_fin", "test_debut", "test_fin", "n_train", "n_test",
               "mae", "wape", "r2", "mae_reference", "wape_reference", "importances"],
              [(version, datetime.now(timezone.utc), train_df["jour"].min().date(), train_df["jour"].max().date(),
                test_debut.date(), dernier.date(), len(train_df), len(test_df),
                s["mae"], s["wape"], s["r2"], s_ref["mae"], s_ref["wape"], importances)])
    for a in anciens:
        db.session().execute("DELETE FROM modele_metriques WHERE modele = %s", (a,))
    figures(test_df, importances)
    return {"modele": version, **s, "mae_reference": s_ref["mae"], "wape_reference": s_ref["wape"],
            "n_train": len(train_df), "n_test": len(test_df), "predictions": len(pred),
            "test": f"{test_debut.date()} -> {dernier.date()}", "futur_jusqu_au": horizon.isoformat()}


# ---------- figures d'analyse du modèle (matplotlib) ----------

ENCRE, DOUX, GRILLE = "#1d2733", "#5b6672", "#dfe4e1"
BLEU, ORANGE, GRIS = "#2a78d6", "#eb6834", "#9aa3a0"


def figures(test: pd.DataFrame, importances: dict) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter

    plt.rcParams.update({
        "font.family": "DejaVu Sans", "font.size": 10, "text.color": ENCRE, "axes.labelcolor": DOUX,
        "axes.edgecolor": GRILLE, "xtick.color": DOUX, "ytick.color": DOUX, "axes.spines.top": False,
        "axes.spines.right": False, "axes.grid": True, "grid.color": GRILLE, "grid.linewidth": 0.8,
        "axes.axisbelow": True, "figure.facecolor": "white", "axes.titlesize": 12, "axes.titleweight": "bold",
        "axes.titlelocation": "left", "legend.frameon": False, "savefig.dpi": 150, "savefig.bbox": "tight",
    })
    millions = FuncFormatter(lambda v, _: f"{v / 1e6:.1f} M".replace(".", ","))
    milliers = FuncFormatter(lambda v, _: f"{v:,.0f}".replace(",", " "))

    # 1. réseau entier : réel, modèle, référence
    j = test.groupby("jour")[["total", "prevu", "ref"]].sum()
    fig, ax = plt.subplots(figsize=(10, 4))
    ax.plot(j.index, j["ref"], color=GRIS, lw=1.5, ls="--", label="Référence (moyenne du même jour)")
    ax.plot(j.index, j["total"], color=BLEU, lw=2, label="Réel")
    ax.plot(j.index, j["prevu"], color=ORANGE, lw=2, label="Prédit par le modèle")
    ax.yaxis.set_major_formatter(millions)
    ax.set_ylim(0)
    ax.grid(axis="x", visible=False)
    ax.set_title("Validations par jour sur le réseau, période de test")
    ax.legend(loc="lower left", ncols=3)
    fig.savefig(c.FIGURES / "test_reseau.png"); plt.close(fig)

    # 2. prédit contre réel, par station et par jour
    fig, ax = plt.subplots(figsize=(5.5, 5.5))
    lim = [50, float(max(test["total"].max(), test["prevu"].max())) * 1.2]
    ax.hexbin(test["total"].clip(lower=50), test["prevu"].clip(lower=50), gridsize=60, xscale="log", yscale="log",
              bins="log", cmap="Blues", mincnt=1, linewidths=0)
    ax.plot(lim, lim, color=ENCRE, lw=1, ls="--")
    ax.set_xlim(lim); ax.set_ylim(lim)
    ax.set_xlabel("Validations réelles (station, jour)"); ax.set_ylabel("Validations prédites")
    ax.xaxis.set_major_formatter(milliers); ax.yaxis.set_major_formatter(milliers)
    ax.set_title("Prédit contre réel")
    fig.savefig(c.FIGURES / "predit_vs_reel.png"); plt.close(fig)

    # 3. importance des variables (permutation)
    imp = pd.Series(importances).sort_values().tail(12)
    fig, ax = plt.subplots(figsize=(7, 4.5))
    ax.barh(imp.index, imp.values, color=BLEU, height=0.6)
    ax.grid(axis="y", visible=False)
    ax.set_xlabel("Hausse de l'erreur quand la variable est brouillée")
    ax.set_title("Ce qui compte le plus pour le modèle")
    fig.savefig(c.FIGURES / "importances.png"); plt.close(fig)

    # 4. erreur relative par jour de semaine : modèle contre référence
    t = test.assign(e_modele=(test["total"] - test["prevu"]).abs(), e_ref=(test["total"] - test["ref"]).abs())
    g = t.groupby("jour_semaine")[["e_modele", "e_ref", "total"]].sum()
    x = np.arange(7)
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.bar(x - 0.2, g["e_ref"] / g["total"] * 100, width=0.36, color=GRIS, label="Référence")
    ax.bar(x + 0.2, g["e_modele"] / g["total"] * 100, width=0.36, color=ORANGE, label="Modèle")
    ax.set_xticks(x, ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."])
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.0f} %"))
    ax.grid(axis="x", visible=False)
    ax.set_title("Erreur relative par jour de la semaine")
    ax.legend(loc="upper left", ncols=2)
    fig.savefig(c.FIGURES / "erreur_jour_semaine.png"); plt.close(fig)
