/** Frontmatter des `SKILL.md` (format « Agent Skills » : `name`, `description`). */
import { parse as parseYaml } from "yaml";

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

export interface SkillFront {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

/** Frontmatter `---` en tête du fichier ; `null` s'il est absent. */
export function readFrontmatter(markdown: string): SkillFront | null {
  const text = markdown.startsWith("\u{FEFF}") ? markdown.slice(1) : markdown;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const value: unknown = parseYaml(m[1]!);
  return typeof value === "object" && value !== null ? (value as SkillFront) : null;
}

/** Erreurs d'un SKILL.md rangé dans `skills/<dirName>/`. */
export function checkSkill(dirName: string, markdown: string): string[] {
  const front = readFrontmatter(markdown);
  if (!front) return ["frontmatter `---` absent (name, description)"];
  const errors: string[] = [];
  const { name, description } = front;
  if (typeof name !== "string" || !name) errors.push("champ `name` absent");
  else {
    if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) {
      errors.push(`\`name\` « ${name} » invalide (minuscules, chiffres et tirets, ${SKILL_NAME_MAX} caractères au plus)`);
    }
    if (name !== dirName) errors.push(`\`name\` « ${name} » différent du dossier « ${dirName} »`);
  }
  if (typeof description !== "string" || !description.trim()) errors.push("champ `description` absent");
  else if (description.length > SKILL_DESCRIPTION_MAX) {
    errors.push(`\`description\` trop longue (${description.length} > ${SKILL_DESCRIPTION_MAX} caractères)`);
  }
  return errors;
}
