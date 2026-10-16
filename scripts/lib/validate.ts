/**
 * Validation d'un dossier de plugin : manifeste contre le schéma, puis tout ce que le schéma ne
 * peut pas voir (fichiers référencés, skills, vues, réglages, binaires commités).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { ICON_NAMES } from "../../packages/ui/src/icons/names";
import { parseManifestText, SCHEMA_PATH, type Manifest } from "./manifest";
import { checkSkill } from "./skill";

export interface Report {
  id: string;
  errors: string[];
  warnings: string[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
let schemaValidator: ReturnType<typeof ajv.compile> | null = null;

function manifestValidator() {
  schemaValidator ??= ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
  return schemaValidator;
}

/** Message d'erreur Ajv en français. */
export function describeSchemaError(e: ErrorObject): string {
  const at = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "racine";
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required":
      return `${at} : champ obligatoire « ${String(p.missingProperty)} » absent`;
    case "additionalProperties":
      return `${at} : champ « ${String(p.additionalProperty)} » inconnu de l'API 1`;
    case "type":
      return `${at} : type attendu ${String(p.type)}`;
    case "const":
      return `${at} : valeur attendue ${JSON.stringify(p.allowedValue)}`;
    case "enum":
      return `${at} : valeur parmi ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "pattern":
      return `${at} : format invalide (motif ${String(p.pattern)})`;
    case "minItems":
      return `${at} : au moins ${String(p.limit)} élément(s)`;
    case "minLength":
      return `${at} : ne doit pas être vide`;
    case "maxLength":
      return `${at} : ${String(p.limit)} caractères au plus`;
    case "not":
      return `${at} : chemin interdit (absolu ou qui remonte hors du plugin)`;
    default:
      return `${at} : ${e.message ?? e.keyword}`;
  }
}

/** Fichiers suivis d'un dossier (hors dépendances et builds). */
export function walk(dir: string, skip = new Set(["node_modules", "dist", "target", ".git"])): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, skip));
    else out.push(path);
  }
  return out;
}

const BINARY_EXT = new Set([".exe", ".dll", ".so", ".dylib", ".node", ".a", ".lib", ".o", ".obj", ".pdb"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Types de propriétés acceptés dans le schéma de réglages (sous-ensemble rendu par Cadence). */
const SETTING_TYPES = new Set(["string", "number", "integer", "boolean"]);

function checkSettingsSchema(path: string, errors: string[]) {
  let schema: any;
  try {
    schema = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`réglages : ${basename(path)} n'est pas du JSON valide (${(e as Error).message})`);
    return;
  }
  try {
    ajv.compile(schema);
  } catch (e) {
    errors.push(`réglages : schéma invalide (${(e as Error).message})`);
    return;
  }
  if (schema.type !== "object" || typeof schema.properties !== "object") {
    errors.push("réglages : le schéma doit être un objet `type: object` avec `properties`");
    return;
  }
  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) errors.push(`réglages : clé « ${key} » invalide (snake_case)`);
    const ok = SETTING_TYPES.has(prop?.type) || Array.isArray(prop?.enum);
    if (!ok) errors.push(`réglages : « ${key} » doit être string, number, integer, boolean ou enum`);
    if (typeof prop?.title !== "string") errors.push(`réglages : « ${key} » sans \`title\` (libellé affiché)`);
  }
  for (const key of schema.required ?? []) {
    if (!(key in schema.properties)) errors.push(`réglages : « ${key} » requis mais non déclaré`);
  }
}

/** Identifiants d'outils cités par les skills (`<plugin>__<outil>`). */
function citedTools(pluginId: string, markdown: string): string[] {
  const re = new RegExp(`\\b${pluginId.replace(/-/g, "\\-")}__([a-z0-9_]+)`, "g");
  return [...new Set([...markdown.matchAll(re)].map((m) => m[1]!))];
}

/** Noms d'outils déclarés par un serveur Rust rmcp (`fn nom` sous `#[tool(...)]`). */
function serverTools(serverDir: string): Set<string> | null {
  const src = join(serverDir, "src");
  if (!existsSync(src)) return null;
  const names = new Set<string>();
  for (const file of walk(src).filter((f) => f.endsWith(".rs"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/#\[tool\(([^\]]*)\)\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z0-9_]+)/g)) {
      const explicit = /name\s*=\s*"([^"]+)"/.exec(m[1]!);
      names.add(explicit ? explicit[1]! : m[2]!);
    }
  }
  return names;
}

export function validatePlugin(dir: string, dirName = basename(dir)): Report {
  const report: Report = { id: dirName, errors: [], warnings: [] };
  const { errors, warnings } = report;
  const manifestPath = join(dir, "plugin.toml");
  if (!existsSync(manifestPath)) {
    errors.push("plugin.toml absent");
    return report;
  }

  let raw: unknown;
  try {
    raw = parseManifestText(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    errors.push(`plugin.toml illisible : ${(e as Error).message}`);
    return report;
  }
  const validate = manifestValidator();
  if (!validate(raw)) {
    errors.push(...(validate.errors ?? []).map(describeSchemaError));
    return report;
  }
  const m = raw as Manifest;
  report.id = m.id;

  if (m.id !== dirName) errors.push(`id « ${m.id} » différent du dossier « ${dirName} »`);
  if (!existsSync(join(dir, "README.md"))) errors.push("README.md absent");
  if (m.icon && !existsSync(join(dir, m.icon))) errors.push(`icône ${m.icon} introuvable`);

  const unique = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${kind} « ${id} » déclaré deux fois`);
      seen.add(id);
    }
  };

  /* Serveur */
  const serverDir = join(dir, "server");
  if (m.server) {
    const cargo = join(serverDir, "Cargo.toml");
    if (!existsSync(serverDir)) errors.push("[server] déclaré mais dossier server/ absent");
    else if (!existsSync(cargo)) {
      warnings.push("server/ sans Cargo.toml : la CI ne sait construire que les serveurs Rust");
    } else {
      const crate = parseManifestText(readFileSync(cargo, "utf8")) as any;
      const bins: string[] = [crate.package?.name, ...(crate.bin ?? []).map((b: any) => b.name)].filter(Boolean);
      if (!bins.includes(m.server.bin)) {
        errors.push(`server.bin « ${m.server.bin} » ne correspond à aucun binaire de server/Cargo.toml`);
      }
    }
  }

  /* UI */
  const uiDir = join(dir, "ui");
  const views = m.ui?.views ?? [];
  if (m.ui) {
    if (!existsSync(uiDir)) errors.push("[ui] déclaré mais dossier ui/ absent");
    else {
      if (!existsSync(join(dir, m.ui.entry))) errors.push(`ui.entry ${m.ui.entry} introuvable dans les sources`);
      const pkg = join(uiDir, "package.json");
      if (existsSync(pkg)) {
        const json = JSON.parse(readFileSync(pkg, "utf8"));
        if (!json.scripts?.build) errors.push("ui/package.json sans script `build` (sortie attendue : ui/dist)");
      }
    }
  } else if (views.length || m.setup?.length) {
    errors.push("vues ou étapes de setup déclarées sans [ui]");
  }
  unique("vue", views.map((v) => v.id));
  for (const v of views) {
    if (v.icon && !(ICON_NAMES as readonly string[]).includes(v.icon)) {
      errors.push(`vue « ${v.id} » : icône « ${v.icon} » absente du kit (${ICON_NAMES.join(", ")})`);
    }
  }
  // Chaque route déclarée doit être gérée par l'UI : son identifiant apparaît dans ui/src.
  const routes = [...views.map((v) => v.id), ...(m.setup ?? []).map((s) => s.view)];
  const uiSrc = join(uiDir, "src");
  if (routes.length && existsSync(uiSrc)) {
    const sources = walk(uiSrc)
      .filter((f) => /\.(tsx?|jsx?|vue|svelte|html)$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const route of new Set(routes)) {
      if (!sources.includes(`"${route}"`) && !sources.includes(`'${route}'`)) {
        errors.push(`vue « ${route} » déclarée mais introuvable dans ui/src`);
      }
    }
  }

  /* Secrets, setup */
  unique("secret", (m.secrets ?? []).map((s) => s.id));
  unique("étape de setup", (m.setup ?? []).map((s) => s.id));

  /* Réglages */
  if (m.settings) {
    const path = join(dir, m.settings.schema);
    if (!existsSync(path)) errors.push(`réglages : ${m.settings.schema} introuvable`);
    else checkSettingsSchema(path, errors);
  }

  /* Skills */
  const skillsDir = join(dir, "skills");
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const tools = m.server ? serverTools(serverDir) : null;
  for (const skill of skills) {
    const file = join(skillsDir, skill, "SKILL.md");
    if (!existsSync(file)) {
      errors.push(`skills/${skill}/SKILL.md absent`);
      continue;
    }
    const markdown = readFileSync(file, "utf8");
    errors.push(...checkSkill(skill, markdown).map((e) => `skills/${skill}/SKILL.md : ${e}`));
    if (tools) {
      for (const tool of citedTools(m.id, markdown)) {
        if (!tools.has(tool)) warnings.push(`skills/${skill} cite ${m.id}__${tool}, absent du serveur`);
      }
    }
  }

  /* Actions */
  unique("action", (m.actions ?? []).map((a) => a.id));
  for (const a of m.actions ?? []) {
    if (!skills.includes(a.skill)) errors.push(`action « ${a.id} » : skill « ${a.skill} » introuvable (skills/${a.skill}/SKILL.md)`);
  }
  const used = new Set((m.actions ?? []).map((a) => a.skill));
  for (const skill of skills.filter((s) => !used.has(s))) {
    warnings.push(`skill « ${skill} » lié à aucune action (utilisable seulement depuis le chat)`);
  }

  /* Binaires et gros fichiers */
  for (const file of walk(dir)) {
    const rel = relative(dir, file).replaceAll("\\", "/");
    if (rel.startsWith("bin/")) errors.push(`${rel} : pas de binaire commité (la CI construit bin/)`);
    else if (BINARY_EXT.has(extname(file).toLowerCase())) errors.push(`${rel} : pas de binaire commité`);
    else if (statSync(file).size > MAX_FILE_BYTES) errors.push(`${rel} : fichier de plus de 5 Mo`);
  }

  return report;
}
