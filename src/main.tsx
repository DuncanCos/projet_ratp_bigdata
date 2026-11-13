import React, { Suspense, lazy, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/archivo/wdth.css";
import "leaflet/dist/leaflet.css";
import "./index.css";
import App from "./App";
import { DataDashboard } from "./components/data/DataDashboard";

/** La carte temps réel a besoin de Tauri ; dans un navigateur, seule la partie « données » existe. */
const inTauri = "__TAURI_INTERNALS__" in window;
// la journée en accéléré ne dépend pas de Tauri : ses horaires (700 ko) ne sont chargés qu'à la demande
const DayReplay = lazy(() => import("./components/replay/DayReplay"));
type Page = "carte" | "donnees" | "journee";
const page = (): Page => {
  const h = window.location.hash;
  if (h.startsWith("#/journee")) return "journee";
  return !inTauri || h.startsWith("#/donnees") ? "donnees" : "carte";
};

function Root() {
  const [p, setP] = useState(page);
  useEffect(() => {
    const on = () => setP(page());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (p === "journee")
    return (
      <Suspense fallback={null}>
        <DayReplay carte={inTauri} />
      </Suspense>
    );
  return p === "donnees" ? <DataDashboard carte={inTauri} /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
