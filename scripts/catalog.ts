/**
 * Génère `catalog.json` à partir des releases GitHub du dépôt.
 *
 *   GITHUB_TOKEN=… pnpm catalog --out catalog.json [--repo RemiSDV/cadence-plugins]
 *
 * Pour chaque plugin encore présent dans plugins/, retient sa dernière release publiée
 * (tag `<id>-v<version>`, assets `<id>-<version>.zip` et `.sha256`), relit le manifeste au tag
 * (git, sinon raw.githubusercontent.com) et l'empreinte publiée. La CI téléverse ensuite le
 * fichier sur la release fixe `catalog`.
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
import { showFile } from "./lib/git";
import { DEFAULT_REPO, listPlugins, parseManifestText, REPO_ROOT, type Manifest } from "./lib/manifest";

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

const ids = listPlugins().map((p) => p.id);
const latest = latestReleases(await allReleases(), ids);
const catalog: Catalog = { api: 1, plugins: [] };

for (const release of latest) {
  const path = `plugins/${release.id}/plugin.toml`;
  const text = showFile(release.tag, path) ?? (await fetchText(rawUrl(repo, release.tag, path)));
  const manifest = parseManifestText(text) as Manifest;
  const sha = parseSha256(await fetchText(release.shaUrl));
  catalog.plugins.push(catalogEntry(repo, release, manifest, sha));
  console.log(`✓ ${release.id} ${release.version}`);
}

const out = resolve(REPO_ROOT, values.out!);
writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
const missing = ids.filter((id) => !latest.some((r) => r.id === id));
if (missing.length) console.log(`  sans release publiée : ${missing.join(", ")}`);
console.log(`${catalog.plugins.length} plugin(s) dans ${values.out}`);
