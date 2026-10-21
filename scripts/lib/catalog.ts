/** Construction du catalogue `catalog.json` à partir des releases GitHub. */
import {
  archiveName,
  DEFAULT_REPO,
  effectiveRequires,
  parseReleaseTag,
  type ActionMode,
  type Category,
  type Color,
  type EffectiveRequirement,
  type Manifest,
  type Service,
} from "./manifest";
import { compareSemver } from "./semver";
import { TARGETS } from "./targets";

/**
 * Plugins publiés par le mainteneur du dépôt (@RemiSDV) : marqués `official` dans le catalogue
 * (badge « Officiel » de Cadence, présélection à l'onboarding). Un plugin proposé par la
 * communauté n'y figure pas ; l'ajouter passe par la revue d'une pull request, comme le reste.
 * Le drapeau n'est posé que pour le catalogue du dépôt officiel, jamais pour celui d'un fork.
 */
export const OFFICIAL_PLUGINS: readonly string[] = ["documents", "exemple", "gestion-projet"];

/** Vrai si le plugin `id` du catalogue publié depuis `repo` est un plugin officiel. */
export function isOfficial(repo: string, id: string): boolean {
  return repo.toLowerCase() === DEFAULT_REPO.toLowerCase() && OFFICIAL_PLUGINS.includes(id);
}

/** Vue de la barre du plugin, pour la fiche du catalogue. */
export interface CatalogView {
  id: string;
  title: string;
  /** Icône du kit. */
  icon: string;
}

/** Bouton lié à un skill, pour la fiche du catalogue. */
export interface CatalogAction {
  id: string;
  label: string;
  mode: ActionMode;
}

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
  /** Publié par le mainteneur du dépôt (voir `OFFICIAL_PLUGINS`). */
  official: boolean;
  /** Groupe du rail (révision 1.1) ; `null` pour un manifeste antérieur sans `category`. */
  category: Category | null;
  /** Couleur de la tuile (révision 1.3) ; `null` : couleur tirée de l'identifiant par Cadence. */
  color: Color | null;
  /** Icône du kit pour la tuile : celle de la première vue (`icon` du manifeste est un SVG). */
  icon: string | null;
  /** Services de Cadence activés (`repos`). */
  services: Service[];
  /**
   * Outils externes nécessaires (révision 1.2) : `[[requires]]` fusionné avec les outils des
   * services activés, un par outil (vide pour un manifeste antérieur à la révision 1.1).
   */
  requires: EffectiveRequirement[];
  views: CatalogView[];
  actions: CatalogAction[];
  /** Outils MCP exposés aux IA (`<plugin>__<outil>`), hors outils réservés à l'interface. */
  tools: string[];
  /** Plateformes du binaire serveur ; `null` : pas de serveur, installable partout. */
  targets: string[] | null;
  icon_url: string | null;
  url: string;
  /** Taille de l'archive en octets, si GitHub la donne. */
  size: number | null;
  sha256: string;
  min_cadence: string;
}

export interface Catalog {
  api: 1;
  /** Date de génération (RFC 3339). */
  generated_at: string;
  plugins: CatalogEntry[];
}

/** Sous-ensemble de la réponse `GET /repos/{repo}/releases`. */
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; size?: number }[];
}

export interface LatestRelease {
  id: string;
  version: string;
  tag: string;
  zipUrl: string;
  /** Taille de l'archive (octets), `null` si inconnue. */
  zipSize: number | null;
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
        zipSize: typeof zip.size === "number" ? zip.size : null,
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

/**
 * Icône du kit de la tuile, comme la calcule Cadence : `icon` du manifeste quand ce n'est pas un
 * SVG, sinon celle de la première vue.
 */
export function railIcon(manifest: Manifest): string | null {
  if (manifest.icon && !manifest.icon.endsWith(".svg")) return manifest.icon;
  return manifest.ui?.views?.find((v) => v.icon)?.icon ?? null;
}

/**
 * Entrée du catalogue d'un plugin publié. `tools` : outils MCP exposés aux IA, lus dans les
 * sources du serveur au tag de la release (voir `exposedTools`).
 */
export function catalogEntry(
  repo: string,
  release: LatestRelease,
  manifest: Manifest,
  sha256: string,
  tools: string[] = [],
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
    official: isOfficial(repo, manifest.id),
    category: manifest.category ?? null,
    color: manifest.color ?? null,
    icon: railIcon(manifest),
    services: manifest.services ?? [],
    requires: effectiveRequires(manifest),
    views: (manifest.ui?.views ?? [])
      .filter((v) => !v.hidden)
      .map((v) => ({ id: v.id, title: v.title, icon: v.icon ?? "layers" })),
    actions: (manifest.actions ?? []).map((a) => ({ id: a.id, label: a.label, mode: a.mode })),
    tools: manifest.server ? tools : [],
    targets: manifest.server ? TARGETS.map((t) => t.id) : null,
    icon_url:
      manifest.icon?.endsWith(".svg") === true
        ? rawUrl(repo, release.tag, `plugins/${manifest.id}/${manifest.icon}`)
        : null,
    url: release.zipUrl,
    size: release.zipSize,
    sha256,
    min_cadence: manifest.min_cadence,
  };
}
