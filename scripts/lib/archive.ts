/** Assemblage de l'archive d'installation d'un plugin. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync, type Zippable } from "fflate";
import type { Manifest } from "./manifest";
import { binaryName, TARGETS } from "./targets";
import { walk } from "./validate";

export interface ArchiveEntry {
  data: Uint8Array;
  executable?: boolean;
}

export type ArchiveFiles = Map<string, ArchiveEntry>;

export interface CollectOptions {
  /** Dossier contenant `<cible>/<bin>[.exe]` (binaires construits par la CI). */
  binsDir?: string;
  /** Tolère des cibles manquantes (essais locaux) ; la CI ne le fait jamais. */
  allowMissingTargets?: boolean;
}

export interface CollectResult {
  files: ArchiveFiles;
  missingTargets: string[];
}

const posix = (p: string) => p.replaceAll("\\", "/");

function addDir(files: ArchiveFiles, from: string, to: string) {
  for (const file of walk(from, new Set(["node_modules", ".git"]))) {
    files.set(`${to}/${posix(relative(from, file))}`, { data: readFileSync(file) });
  }
}

/**
 * Contenu de l'archive, à plat (pas de dossier racine) :
 * plugin.toml, README.md, icône, schéma de réglages, ui/ (sortie de build), skills/, bin/<cible>/.
 */
export function collectFiles(dir: string, m: Manifest, options: CollectOptions = {}): CollectResult {
  const files: ArchiveFiles = new Map();
  const add = (rel: string) => files.set(rel, { data: readFileSync(join(dir, rel)) });

  add("plugin.toml");
  add("README.md");
  if (existsSync(join(dir, "LICENSE"))) add("LICENSE");
  if (m.icon) add(m.icon);
  if (m.settings) add(m.settings.schema);

  if (m.ui) {
    const uiDir = join(dir, "ui");
    const built = join(uiDir, "dist");
    if (existsSync(join(uiDir, "package.json"))) {
      if (!existsSync(join(built, "index.html"))) {
        throw new Error("ui/dist/index.html absent : construisez l'UI (pnpm build) avant d'assembler");
      }
      addDir(files, built, "ui");
    } else {
      addDir(files, uiDir, "ui"); // UI statique, sans build
    }
    if (!files.has(m.ui.entry)) throw new Error(`ui.entry ${m.ui.entry} absent de l'archive`);
  }

  const skills = join(dir, "skills");
  if (existsSync(skills)) addDir(files, skills, "skills");

  const missingTargets: string[] = [];
  if (m.server) {
    for (const target of TARGETS) {
      const name = binaryName(m.server.bin, target);
      const path = options.binsDir ? join(options.binsDir, target.id, name) : null;
      if (path && existsSync(path) && statSync(path).isFile()) {
        files.set(`bin/${target.id}/${name}`, { data: readFileSync(path), executable: true });
      } else {
        missingTargets.push(target.id);
      }
    }
    if (missingTargets.length && !options.allowMissingTargets) {
      throw new Error(`binaire ${m.server.bin} manquant pour : ${missingTargets.join(", ")}`);
    }
  }
  return { files, missingTargets };
}

/** Date fixe des entrées : deux assemblages des mêmes fichiers donnent la même archive. */
const FIXED_MTIME = new Date("2026-01-01T00:00:00Z");

export function buildZip(files: ArchiveFiles): Uint8Array {
  const tree: Zippable = {};
  for (const path of [...files.keys()].sort()) {
    const entry = files.get(path)!;
    tree[path] = [
      entry.data,
      {
        level: 9,
        mtime: FIXED_MTIME,
        // Unix (3) avec le mode 0755 pour les exécutables, 0644 sinon.
        os: 3,
        attrs: ((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0,
      },
    ];
  }
  return zipSync(tree);
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Ligne du fichier `.sha256`, au format de `sha256sum`. */
export function sha256Line(hash: string, fileName: string): string {
  return `${hash}  ${fileName}\n`;
}
