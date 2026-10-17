/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Servi par Cadence dans un iframe isolé depuis le dossier du plugin : chemins relatifs.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  // `ui.dev_url` du manifeste : l'iframe de Cadence est isolée (origine opaque « null »),
  // le serveur de dev doit donc accepter toutes les origines.
  server: { port: 5181, strictPort: true, cors: true },
  build: { outDir: "dist", emptyOutDir: true },
  test: { environment: "node", include: ["src/**/*.test.ts"], passWithNoTests: true },
});
