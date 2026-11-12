import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/archivo/wdth.css";
import "leaflet/dist/leaflet.css";
import "./index.css";
import App from "./App";
import { DataDashboard } from "./components/data/DataDashboard";

/** La carte temps réel a besoin de Tauri ; dans un navigateur, seule la partie « données » existe. */
const inTauri = "__TAURI_INTERNALS__" in window;
const isData = () => !inTauri || window.location.hash.startsWith("#/donnees");

function Root() {
  const [data, setData] = useState(isData);
  useEffect(() => {
    const on = () => setData(isData());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return data ? <DataDashboard carte={inTauri} /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
