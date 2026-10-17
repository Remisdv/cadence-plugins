/**
 * Données et règles de l'écran, sans React : faciles à tester (domain.test.ts).
 *
 * Les identifiants de vue doivent apparaître tels quels dans ui/src : `pnpm validate` vérifie que
 * chaque `[[ui.views]]` et chaque vue de `[[setup]]` du manifeste est gérée par l'écran.
 */
import type { ExternalToolStatus } from "@cadence/plugin-sdk";

/** Routes de l'écran : la vue « accueil » et l'étape de configuration « setup-prenom ». */
export const VIEWS = { accueil: "accueil", prenom: "setup-prenom" } as const;

/** Réglages globaux du plugin (`settings.schema.json`). */
export interface ExempleSettings {
  prenom: string;
  pas: number;
  [key: string]: unknown;
}

/** Réponse de l'outil `etat` (réservé à l'écran). */
export interface Etat {
  valeur: number;
  settings: { prenom: string; pas: number };
  /** Chemin de git d'après `CADENCE_TOOLS`, `null` si Cadence ne l'a pas trouvé. */
  git: string | null;
  version: string;
}

/** Réponse de l'outil `incrementer`. */
export interface Increment {
  valeur: number;
  pas: number;
  prenom: string;
}

/** Charge de l'événement `compteur` émis par le serveur. */
export interface CompteurEvent {
  valeur: number;
}

/** Pas possibles, comme dans le schéma de réglages. */
export const PAS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Pas valide (entier de 1 à 10), 1 sinon. */
export function pasValide(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

/** « Bonjour Rémi ! », ou « Bonjour ! » sans prénom. */
export function salutation(prenom: string | undefined): string {
  const p = prenom?.trim();
  return p ? `Bonjour ${p} !` : "Bonjour !";
}

/** État d'un outil externe en une ligne. */
export function toolLine(status: ExternalToolStatus | null, path: string | null): string {
  if (!status) return "État inconnu";
  if (!status.installed) return "Non installé : le plugin fonctionne sans (dépendance optionnelle).";
  const version = status.version ? `version ${status.version}` : "version inconnue";
  return path ? `${version} · ${path}` : version;
}
