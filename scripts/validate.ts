/**
 * Valide les plugins du dépôt.
 *
 *   pnpm validate                       # tous les plugins
 *   pnpm validate gestion-projet        # un seul
 *   pnpm validate --base origin/main    # + version incrémentée pour chaque plugin modifié (CI des PR)
 *
 * Sort en erreur (code 1) si un plugin est invalide ; les avertissements n'échouent pas.
 */
import { parseArgs } from "node:util";
import { changedFiles, showFile } from "./lib/git";
import { listPlugins, parseManifestText, readManifest, type Manifest } from "./lib/manifest";
import { compareSemver } from "./lib/semver";
import { validatePlugin, type Report } from "./lib/validate";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { base: { type: "string" } },
});

const all = listPlugins();
const selected = positionals.length ? all.filter((p) => positionals.includes(p.id)) : all;
for (const id of positionals) {
  if (!all.some((p) => p.id === id)) {
    console.error(`✕ plugin « ${id} » introuvable dans plugins/`);
    process.exit(1);
  }
}

const reports: Report[] = selected.map((p) => validatePlugin(p.dir, p.id));

/* Version incrémentée : tout changement d'un plugin existant sur la base doit monter sa version. */
if (values.base) {
  const changed = changedFiles(values.base);
  if (changed === null) {
    console.error(`✕ impossible de comparer avec ${values.base} (git diff a échoué)`);
    process.exit(1);
  }
  for (const [i, report] of reports.entries()) {
    const plugin = selected[i]!;
    const prefix = `plugins/${plugin.id}/`;
    if (!changed.some((f) => f.startsWith(prefix))) continue;
    const before = showFile(values.base, `${prefix}plugin.toml`);
    if (before === null) continue; // nouveau plugin
    try {
      const old = parseManifestText(before) as Manifest;
      const current = readManifest(plugin.manifestPath);
      if (compareSemver(current.version, old.version) <= 0) {
        report.errors.push(
          `plugin modifié mais version non incrémentée (${old.version} sur ${values.base}, ${current.version} ici)`,
        );
      }
    } catch (e) {
      report.errors.push(`comparaison de version impossible : ${(e as Error).message}`);
    }
  }
}

let failed = false;
for (const r of reports) {
  const status = r.errors.length ? "✕" : "✓";
  console.log(`${status} ${r.id}`);
  for (const e of r.errors) console.log(`    erreur : ${e}`);
  for (const w of r.warnings) console.log(`    attention : ${w}`);
  failed ||= r.errors.length > 0;
}
if (!reports.length) console.log("Aucun plugin à valider.");
console.log(failed ? "\nValidation échouée." : `\n${reports.length} plugin(s) valide(s).`);
process.exit(failed ? 1 : 0);
