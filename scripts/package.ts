/**
 * Assemble l'archive d'installation d'un plugin : `<id>-<version>.zip` + `<id>-<version>.zip.sha256`.
 *
 *   pnpm package gestion-projet --bins bins --out out
 *   pnpm package documents --allow-missing-targets   # essai local, sans tous les binaires
 *
 * Options :
 *   --bins <dossier>          binaires construits, rangés en <cible>/<bin>[.exe]
 *   --out <dossier>           dossier de sortie (out/ par défaut)
 *   --build                   construit l'UI (pnpm build) avant d'assembler
 *   --allow-missing-targets   tolère des plateformes manquantes (jamais en CI)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildZip, collectFiles, sha256, sha256Line } from "./lib/archive";
import { archiveName, listPlugins, readManifest, REPO_ROOT } from "./lib/manifest";
import { validatePlugin } from "./lib/validate";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bins: { type: "string" },
    out: { type: "string", default: "out" },
    build: { type: "boolean", default: false },
    "allow-missing-targets": { type: "boolean", default: false },
  },
});

const [id] = positionals;
const plugin = listPlugins().find((p) => p.id === id);
if (!id || !plugin) {
  console.error(id ? `✕ plugin « ${id} » introuvable` : "Usage : pnpm package <id> [--bins dir] [--out dir]");
  process.exit(1);
}

const report = validatePlugin(plugin.dir, plugin.id);
if (report.errors.length) {
  console.error(`✕ ${id} invalide :\n${report.errors.map((e) => `    ${e}`).join("\n")}`);
  process.exit(1);
}

const manifest = readManifest(plugin.manifestPath);
if (values.build && manifest.ui) {
  execFileSync("pnpm", ["--dir", join(plugin.dir, "ui"), "build"], { stdio: "inherit", shell: process.platform === "win32" });
}

try {
  const { files, missingTargets } = collectFiles(plugin.dir, manifest, {
    binsDir: values.bins ? resolve(REPO_ROOT, values.bins) : undefined,
    allowMissingTargets: values["allow-missing-targets"],
  });
  const zip = buildZip(files);
  const name = archiveName(manifest.id, manifest.version);
  const outDir = resolve(REPO_ROOT, values.out!);
  mkdirSync(outDir, { recursive: true });
  const hash = sha256(zip);
  writeFileSync(join(outDir, name), zip);
  writeFileSync(join(outDir, `${name}.sha256`), sha256Line(hash, name));

  console.log(`✓ ${join(values.out!, name)} (${files.size} fichiers, ${(zip.length / 1024).toFixed(0)} Kio)`);
  console.log(`  sha256 ${hash}`);
  if (missingTargets.length) console.log(`  attention : sans binaire pour ${missingTargets.join(", ")}`);
} catch (e) {
  console.error(`✕ ${(e as Error).message}`);
  process.exit(1);
}
