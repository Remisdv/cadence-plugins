/** Lecture des manifestes `plugins/<id>/plugin.toml` (API 1, révision 1.2). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { compareLooseVersion } from "./semver";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PLUGINS_DIR = join(REPO_ROOT, "plugins");
export const SCHEMA_PATH = join(REPO_ROOT, "schema", "plugin.schema.json");
/** Dépôt GitHub public du catalogue. */
export const DEFAULT_REPO = "RemiSDV/cadence-plugins";

export type ActionMode = "chat" | "background";

/** Catégories de l'API, dans l'ordre des groupes du rail de Cadence. */
export const CATEGORIES = ["projet", "etudes", "code", "donnees", "outils"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Services fournis par Cadence qu'un plugin peut activer (`services = [...]`). */
export const SERVICES = ["repos"] as const;
export type Service = (typeof SERVICES)[number];

/** Registre des outils externes connus de Cadence (révision 1.2), dans l'ordre du registre. */
export const TOOLS = ["git", "gh", "claude", "codex", "opencode", "node"] as const;
export type ToolId = (typeof TOOLS)[number];

/** Outils sans commande de connexion : `auth = true` n'a pas de sens pour eux. */
export const TOOLS_WITHOUT_AUTH: readonly ToolId[] = ["git", "node"];

/** Dépendance externe déclarée par `[[requires]]`. */
export interface Requirement {
  tool: ToolId;
  /** Version minimale, semver souple : `2`, `2.30` ou `2.30.1`. */
  min_version?: string;
  /** Le plugin fonctionne sans, en mode dégradé. */
  optional?: boolean;
  /** L'outil doit aussi être connecté. */
  auth?: boolean;
  /** Pourquoi le plugin en a besoin, en français (affiché à l'utilisateur). */
  reason: string;
}

/**
 * Outils que chaque service déclare lui-même : un plugin qui active le service n'a pas à les
 * redéclarer (il peut le faire, par exemple pour exiger une version plus récente).
 */
export const SERVICE_REQUIRES: Record<Service, readonly Requirement[]> = {
  repos: [
    { tool: "git", reason: "Cloner les dépôts et préparer les worktrees" },
    { tool: "gh", optional: true, auth: true, reason: "Réutiliser votre connexion GitHub existante" },
  ],
};

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
  category: Category;
  services?: Service[];
  requires?: Requirement[];
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

/** Dépendance effective d'un plugin : sa déclaration fusionnée avec celles de ses services. */
export interface EffectiveRequirement {
  tool: ToolId;
  min_version: string | null;
  optional: boolean;
  auth: boolean;
  reason: string;
  /** Service qui déclare l'outil (`null` : déclaré par le plugin seul). */
  service: Service | null;
}

/**
 * Outils externes nécessaires au plugin : `[[requires]]` plus les outils de ses services, un par
 * outil, dans l'ordre du registre. Pour un outil déclaré deux fois : requis si l'une des
 * déclarations l'exige, connexion si l'une la demande, la plus haute version minimale, la raison
 * du plugin.
 */
export function effectiveRequires(m: Pick<Manifest, "services" | "requires">): EffectiveRequirement[] {
  const byTool = new Map<ToolId, EffectiveRequirement>();
  const add = (r: Requirement, service: Service | null) => {
    const next: EffectiveRequirement = {
      tool: r.tool,
      min_version: r.min_version ?? null,
      optional: r.optional ?? false,
      auth: r.auth ?? false,
      reason: r.reason,
      service,
    };
    const prev = byTool.get(r.tool);
    if (!prev) {
      byTool.set(r.tool, next);
      return;
    }
    const versions = [prev.min_version, next.min_version].filter((v): v is string => v !== null);
    byTool.set(r.tool, {
      tool: r.tool,
      min_version: versions.sort(compareLooseVersion).at(-1) ?? null,
      optional: prev.optional && next.optional,
      auth: prev.auth || next.auth,
      reason: service === null ? next.reason : prev.reason,
      service: prev.service ?? service,
    });
  };
  for (const s of m.services ?? []) for (const r of SERVICE_REQUIRES[s] ?? []) add(r, s);
  for (const r of m.requires ?? []) add(r, null);
  return [...byTool.values()].sort((a, b) => TOOLS.indexOf(a.tool) - TOOLS.indexOf(b.tool));
}
