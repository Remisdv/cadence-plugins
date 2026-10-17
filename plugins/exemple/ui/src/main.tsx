import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isFramed, setCadence } from "@cadence/plugin-sdk";
import { App } from "./App";
import "./index.css";

// Dans Cadence, l'écran tourne dans un iframe et le SDK parle à l'app par postMessage.
// Hors de Cadence (`pnpm dev` dans un navigateur), il parle à un hôte simulé (dev.ts), absent du
// build de production : import.meta.env.DEV y vaut false.
if (import.meta.env.DEV && !isFramed()) {
  const { devCadence } = await import("./dev");
  setCadence(devCadence());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
