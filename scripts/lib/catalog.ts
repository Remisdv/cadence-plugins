/** Construction du catalogue `catalog.json` à partir des releases GitHub. */
import { archiveName, parseReleaseTag, type Category, type Manifest } from "./manifest";
import { compareSemver } from "./semver";

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
  /** Groupe du rail (révision 1.1) ; `null` pour un manifeste antérieur sans `category`. */
  category: Category | null;
  icon_url: string | null;
  url: string;
  sha256: string;
  min_cadence: string;
}

export interface Catalog {
  api: 1;
  plugins: CatalogEntry[];
}

/** Sous-ensemble de la réponse `GET /repos/{repo}/releases`. */
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

export interface LatestRelease {
  id: string;
  version: string;
  tag: string;
  zipUrl: string;
  shaUrl: string;
}

/**
 * Dernière release publiée de chaque plugin encore présent dans le dépôt, avec ses deux assets.
 * Les brouillons, préversions et releases incomplètes sont ignorés.
 */
export function latestReleases(releases: GithubRelease[], pluginIds: string[]): LatestRelease[] {
  const best = new Map<string, LatestRelease>();
  for (const r of releases) {
    if (r.draft || r.prerelease) continue;
    const parsed = parseReleaseTag(r.tag_name);
    if (!parsed || !pluginIds.includes(parsed.id)) continue;
    const zipName = archiveName(parsed.id, parsed.version);
    const zip = r.assets.find((a) => a.name === zipName);
    const sha = r.assets.find((a) => a.name === `${zipName}.sha256`);
    if (!zip || !sha) continue;
    const current = best.get(parsed.id);
    if (!current || compareSemver(parsed.version, current.version) > 0) {
      best.set(parsed.id, {
        ...parsed,
        tag: r.tag_name,
        zipUrl: zip.browser_download_url,
        shaUrl: sha.browser_download_url,
      });
    }
  }
  return [...best.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Première valeur hexadécimale d'un fichier `.sha256` (format sha256sum). */
export function parseSha256(text: string): string {
  const hash = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`empreinte sha256 illisible : « ${text.trim()} »`);
  return hash;
}

/** URL brute d'un fichier du dépôt à un tag. */
export function rawUrl(repo: string, tag: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${tag}/${path}`;
}

export function catalogEntry(
  repo: string,
  release: LatestRelease,
  manifest: Manifest,
  sha256: string,
): CatalogEntry {
  if (manifest.id !== release.id || manifest.version !== release.version) {
    throw new Error(
      `${release.tag} : le manifeste du tag annonce ${manifest.id} ${manifest.version}, pas ${release.id} ${release.version}`,
    );
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    authors: manifest.authors,
    category: manifest.category ?? null,
    icon_url: manifest.icon ? rawUrl(repo, release.tag, `plugins/${manifest.id}/${manifest.icon}`) : null,
    url: release.zipUrl,
    sha256,
    min_cadence: manifest.min_cadence,
  };
}
