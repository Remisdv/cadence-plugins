/** Lecture des manifestes `plugins/<id>/plugin.toml` (API 1). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PLUGINS_DIR = join(REPO_ROOT, "plugins");
export const SCHEMA_PATH = join(REPO_ROOT, "schema", "plugin.schema.json");
/** Dépôt GitHub public du catalogue. */
export const DEFAULT_REPO = "RemiSDV/cadence-plugins";

export type ActionMode = "chat" | "background";

export interface ViewDecl {
  id: string;
  title: string;
  icon?: string;
  section?: string;
}

export interface Manifest {
  api: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
  icon?: string;
  min_cadence: string;
  server?: { bin: string };
  ui?: { entry: string; views?: ViewDecl[] };
  secrets?: { id: string; label: string }[];
  setup?: { id: string; title: string; view: string }[];
  settings?: { schema: string };
  actions?: { id: string; label: string; skill: string; mode: ActionMode; context?: string }[];
}

export interface PluginDir {
  id: string;
  dir: string;
  manifestPath: string;
}

/** Dossiers de `plugins/` qui contiennent un `plugin.toml`. */
export function listPlugins(root = PLUGINS_DIR): PluginDir[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, dir: join(root, d.name), manifestPath: join(root, d.name, "plugin.toml") }))
    .filter((p) => existsSync(p.manifestPath))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** TOML → objet brut (non validé). */
export function parseManifestText(text: string): unknown {
  return parseToml(text);
}

export function readManifest(path: string): Manifest {
  return parseManifestText(readFileSync(path, "utf8")) as unknown as Manifest;
}

/** Tag de release d'un plugin : `<id>-v<version>`. */
export function releaseTag(id: string, version: string): string {
  return `${id}-v${version}`;
}

/** Nom de l'archive : `<id>-<version>.zip`. */
export function archiveName(id: string, version: string): string {
  return `${id}-${version}.zip`;
}

/** Lit un tag de release ; `null` si ce n'est pas un tag de plugin. */
export function parseReleaseTag(tag: string): { id: string; version: string } | null {
  const m = /^([a-z0-9-]+?)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag);
  return m ? { id: m[1]!, version: m[2]! } : null;
}
