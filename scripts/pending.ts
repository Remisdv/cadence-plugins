/**
 * Plugins à publier : ceux dont la version du manifeste n'a pas encore de tag `<id>-v<version>`.
 *
 *   pnpm pending                 # affiche la liste en JSON
 *   pnpm pending --github-output # l'écrit aussi dans $GITHUB_OUTPUT (plugins, count, servers)
 *
 * `servers` liste les crates Rust à construire sur chaque plateforme.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { existingTags } from "./lib/git";
import { listPlugins, parseManifestText, readManifest, releaseTag } from "./lib/manifest";

const { values } = parseArgs({ options: { "github-output": { type: "boolean", default: false } } });

export interface PendingPlugin {
  id: string;
  name: string;
  version: string;
  tag: string;
  ui: boolean;
  /** Crate Rust et nom du binaire, si le plugin a un serveur. */
  server: { crate: string; bin: string } | null;
}

const tags = existingTags();
const pending: PendingPlugin[] = [];
for (const plugin of listPlugins()) {
  const m = readManifest(plugin.manifestPath);
  const tag = releaseTag(m.id, m.version);
  if (tags.has(tag)) continue;
  let server: PendingPlugin["server"] = null;
  if (m.server) {
    const cargo = join(plugin.dir, "server", "Cargo.toml");
    if (!existsSync(cargo)) throw new Error(`${m.id} : server/Cargo.toml absent, la CI ne sait pas construire ce serveur`);
    const crate = (parseManifestText(readFileSync(cargo, "utf8")) as any).package.name as string;
    server = { crate, bin: m.server.bin };
  }
  pending.push({ id: m.id, name: m.name, version: m.version, tag, ui: !!m.ui, server });
}

console.log(JSON.stringify(pending, null, 2));
if (values["github-output"] && process.env.GITHUB_OUTPUT) {
  const servers = pending.flatMap((p) => (p.server ? [p.server] : []));
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `plugins=${JSON.stringify(pending)}\ncount=${pending.length}\nservers=${JSON.stringify(servers)}\n`,
  );
}
