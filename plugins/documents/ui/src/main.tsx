import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { connect, isFramed, setCadence } from "@cadence/plugin-sdk";
import { App } from "./App";
import "./index.css";

// Hors de Cadence (pnpm dev dans un navigateur) : hôte simulé avec des données d'exemple.
// Absent du build de production (import.meta.env.DEV est remplacé par false).
if (import.meta.env.DEV && !isFramed()) {
  const { devHost } = await import("./dev");
  setCadence(connect({ dev: devHost }));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
