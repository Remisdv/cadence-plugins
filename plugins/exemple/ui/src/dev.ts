/**
 * Hôte simulé pour `pnpm dev` hors de Cadence : il répond comme Cadence, avec des outils écrits à
 * la main qui imitent le serveur (`incrementer` émet aussi l'événement `compteur`).
 * `?view=setup-prenom` dans l'URL ouvre l'étape de configuration.
 */
import { connectMock, type Cadence, type MockHost } from "@cadence/plugin-sdk";
import { pasValide } from "./domain";

export function devCadence(): Cadence {
  let valeur = 0;
  let host: MockHost | null = null;
  const settings = () => host?.settings ?? {};

  const connected = connectMock({
    plugin: { id: "exemple", version: "0.1.0" },
    route: { view: new URLSearchParams(location.search).get("view") ?? "accueil", params: {} },
    settings: { prenom: "", pas: 1 },
    // Outil externe déclaré par [[requires]] : absent, « Installer » simule la boîte de Cadence.
    externalTools: { git: { installed: false } },
    tools: {
      incrementer: ({ pas }) => {
        const p = pas === undefined ? pasValide(settings().pas) : Number(pas);
        if (!Number.isInteger(p) || p < 1 || p > 10) throw new Error(`Pas ${String(pas)} invalide : de 1 à 10.`);
        valeur += p;
        setTimeout(() => host?.emit("compteur", { valeur }));
        return { valeur, pas: p, prenom: String(settings().prenom ?? "") };
      },
      etat: () => ({
        valeur,
        settings: { prenom: settings().prenom ?? "", pas: pasValide(settings().pas) },
        git: host?.externalTools.git?.installed ? "/usr/bin/git" : null,
        version: "0.1.0",
      }),
    },
  });
  host = connected.host;
  return connected.cadence;
}
