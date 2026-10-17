/**
 * Génère `catalog.json` à partir des releases GitHub du dépôt.
 *
 *   GITHUB_TOKEN=… pnpm catalog --out catalog.json [--repo RemiSDV/cadence-plugins]
 *
 * Pour chaque plugin encore présent dans plugins/, retient sa dernière release publiée
 * (tag `<id>-v<version>`, assets `<id>-<version>.zip` et `.sha256`), relit le manifeste au tag
 * (git, sinon raw.githubusercontent.com), les sources de son serveur (outils MCP exposés) et
 * l'empreinte publiée. Chaque entrée porte ce que Cadence montre sans télécharger l'archive :
 * `official`, `category`, `color`, `icon`, `services`, `requires`, `views`, `actions`, `tools`,
 * `targets`, `size`. La CI téléverse ensuite le fichier sur la release fixe `catalog`.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  catalogEntry,
  latestReleases,
  parseSha256,
  rawUrl,
  type Catalog,
  type GithubRelease,
} from "./lib/catalog";
import { listFiles, showFile } from "./lib/git";
import { DEFAULT_REPO, listPlugins, parseManifestText, REPO_ROOT, type Manifest } from "./lib/manifest";
import { exposedTools } from "./lib/tools";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO },
    out: { type: "string", default: "catalog.json" },
  },
});
const repo = values.repo!;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "cadence-plugins-catalog",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function fetchText(url: string, auth = false): Promise<string> {
  const res = await fetch(url, { headers: auth ? headers : { "User-Agent": headers["User-Agent"]! } });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return res.text();
}

async function allReleases(): Promise<GithubRelease[]> {
  const out: GithubRelease[] = [];
  for (let page = 1; ; page++) {
    const text = await fetchText(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, true);
    const batch = JSON.parse(text) as GithubRelease[];
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

/** Fichier du dépôt au tag : git local, sinon raw.githubusercontent.com. */
async function fileAt(tag: string, path: string): Promise<string> {
  return showFile(tag, path) ?? (await fetchText(rawUrl(repo, tag, path)));
}

/** Sources Rust du serveur d'un plugin au tag (git local, sinon l'arbre du tag par l'API). */
async function serverSources(tag: string, id: string): Promise<string[]> {
  const dir = `plugins/${id}/server/src/`;
  let paths = listFiles(tag, dir);
  if (paths === null) {
    const tree = JSON.parse(
      await fetchText(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`, true),
    ) as { tree: { path: string; type: string }[] };
    paths = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(dir)).map((e) => e.path);
  }
  return Promise.all(paths.filter((p) => p.endsWith(".rs")).map((p) => fileAt(tag, p)));
}

const ids = listPlugins().map((p) => p.id);
const latest = latestReleases(await allReleases(), ids);
const catalog: Catalog = { api: 1, generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), plugins: [] };

for (const release of latest) {
  const manifest = parseManifestText(await fileAt(release.tag, `plugins/${release.id}/plugin.toml`)) as Manifest;
  const sha = parseSha256(await fetchText(release.shaUrl));
  const tools = manifest.server ? exposedTools(await serverSources(release.tag, release.id)) : [];
  const entry = catalogEntry(repo, release, manifest, sha, tools);
  catalog.plugins.push(entry);
  console.log(`✓ ${release.id} ${release.version}${entry.official ? " (officiel)" : ""} · ${tools.length} outil(s) MCP`);
}

const out = resolve(REPO_ROOT, values.out!);
writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
const missing = ids.filter((id) => !latest.some((r) => r.id === id));
if (missing.length) console.log(`  sans release publiée : ${missing.join(", ")}`);
console.log(`${catalog.plugins.length} plugin(s) dans ${values.out}`);
