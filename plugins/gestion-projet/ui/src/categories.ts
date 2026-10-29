/**
 * Catégories d'issues côté écran : taxonomie domaine › catégorie (`list_categories`), filtre de
 * l'arbre latéral, regroupements de la vue Issues, édition de la personnalisation d'un dépôt.
 * Fonctions pures, testées dans `categories.test.ts`. Sur GitHub : label `cat/<catégorie>`, et
 * `etape/<étape>` pour les domaines à pipeline (voir `server/src/categories.rs`).
 */
import type { Issue, IssueStatus } from "./domain";
import { issueStatuses, statusOrder } from "./domain";

export interface Stage {
  id: string;
  label: string;
}

export interface CategoryView {
  id: string;
  label: string;
  description: string;
  custom: boolean;
  hidden: boolean;
}

export interface DomainView {
  id: string;
  label: string;
  color: string;
  description: string;
  pipeline: Stage[] | null;
  custom: boolean;
  hidden: boolean;
  categories: CategoryView[];
}

export interface Category {
  id: string;
  label: string;
  description?: string;
}

export interface Domain {
  id: string;
  label: string;
  color: string;
  description?: string;
  pipeline?: Stage[] | null;
  categories: Category[];
}

/** Personnalisation d'un dépôt (`config` de `list_categories`, renvoyée à `save_categories`). */
export interface CategoryConfig {
  domains?: Domain[];
  categories?: (Category & { domain: string })[];
  hidden?: string[];
}

/** Réponse de `list_categories` / `save_categories`. */
export interface CategoryList {
  repo: string;
  domains: DomainView[];
  config: CategoryConfig;
}

/** Couleur des issues sans catégorie. */
export const NO_CATEGORY_COLOR = "#7b8692";

/** Palette proposée pour un domaine ajouté (accordée au thème sombre). */
export const domainColors = [
  "#5b8def",
  "#3fb562",
  "#a277f0",
  "#e0a44c",
  "#d97757",
  "#4fb3bf",
  "#e07aa8",
  "#e0655a",
  "#8fb339",
  "#9aa4b0",
];

/* ---------- Taxonomie ---------- */

/**
 * Taxonomie de plusieurs dépôts (« Tous les dépôts ») : les domaines dans l'ordre de leur
 * première apparition, catégories réunies sans doublon. Un élément n'est masqué que s'il l'est
 * partout.
 */
export function mergeTaxonomies(lists: readonly DomainView[][]): DomainView[] {
  const out: DomainView[] = [];
  for (const list of lists) {
    for (const d of list) {
      const known = out.find((o) => o.id === d.id);
      if (!known) {
        out.push({ ...d, categories: d.categories.map((c) => ({ ...c })) });
        continue;
      }
      known.hidden = known.hidden && d.hidden;
      for (const c of d.categories) {
        const same = known.categories.find((k) => k.id === c.id);
        if (same) same.hidden = same.hidden && c.hidden;
        else known.categories.push({ ...c });
      }
    }
  }
  return out;
}

export interface CategoryRef {
  domain: DomainView;
  category: CategoryView;
}

/** Index catégorie → (domaine, catégorie). */
export function indexCategories(domains: readonly DomainView[]): Map<string, CategoryRef> {
  const map = new Map<string, CategoryRef>();
  for (const domain of domains)
    for (const category of domain.categories) map.set(category.id, { domain, category });
  return map;
}

/** Domaines et catégories à proposer dans un sélecteur : sans les masqués (sauf `keep`). */
export function pickable(domains: readonly DomainView[], keep?: string | null): DomainView[] {
  return domains
    .map((d) => ({
      ...d,
      categories: d.categories.filter((c) => (!c.hidden && !d.hidden) || c.id === keep),
    }))
    .filter((d) => d.categories.length > 0);
}

/** Étapes du pipeline de la catégorie d'une issue, `null` sans pipeline. */
export function pipelineOf(
  index: Map<string, CategoryRef>,
  category: string | null | undefined,
): Stage[] | null {
  if (!category) return null;
  return index.get(category)?.domain.pipeline ?? null;
}

/* ---------- Filtre de l'arbre latéral ---------- */

/** Ce que l'arbre filtre : tout, un domaine (ses catégories comprises), une catégorie, ou rien. */
export type CategoryFilter =
  | { kind: "all" }
  | { kind: "domain"; id: string }
  | { kind: "category"; id: string }
  | { kind: "none" };

export function matchesFilter(
  issue: Pick<Issue, "category">,
  filter: CategoryFilter,
  index: Map<string, CategoryRef>,
): boolean {
  const category = issue.category ?? null;
  switch (filter.kind) {
    case "all":
      return true;
    case "none":
      return category === null || !index.has(category);
    case "category":
      return category === filter.id;
    case "domain":
      return category !== null && index.get(category)?.domain.id === filter.id;
  }
}

/** Compteurs de l'arbre : par domaine, par catégorie, et sans catégorie. */
export function countByCategory(
  issues: readonly Pick<Issue, "category">[],
  index: Map<string, CategoryRef>,
): { domains: Map<string, number>; categories: Map<string, number>; none: number } {
  const domains = new Map<string, number>();
  const categories = new Map<string, number>();
  let none = 0;
  for (const i of issues) {
    const ref = i.category ? index.get(i.category) : undefined;
    if (!ref) {
      none += 1;
      continue;
    }
    categories.set(ref.category.id, (categories.get(ref.category.id) ?? 0) + 1);
    domains.set(ref.domain.id, (domains.get(ref.domain.id) ?? 0) + 1);
  }
  return { domains, categories, none };
}

/* ---------- Regroupements de la table ---------- */

export type GroupBy = "domain" | "category" | "status" | "milestone" | "priority" | "none";

export const groupings: { id: GroupBy; label: string }[] = [
  { id: "domain", label: "Domaine" },
  { id: "category", label: "Catégorie" },
  { id: "status", label: "État" },
  { id: "milestone", label: "Version" },
  { id: "priority", label: "Priorité" },
  { id: "none", label: "Aucun" },
];

export function isGroupBy(value: unknown): value is GroupBy {
  return groupings.some((g) => g.id === value);
}

export interface IssueGroup<T> {
  key: string;
  label: string;
  /** Couleur de la barre du groupe (#rrggbb). */
  color: string;
  /** Sous-titre (domaine d'une catégorie). */
  hint?: string;
  items: T[];
}

const statusColor: Record<IssueStatus, string> = {
  todo: "#7b8692",
  doing: "#d97757",
  review: "#5b8def",
  done: "#3fb562",
};

export function statusColorOf(status: IssueStatus): string {
  return statusColor[status];
}

const priorityColor = ["#a277f0", "#e0655a", "#e0a44c", "#5b8def", "#9aa4b0", "#7b8692"];

/**
 * Groupes de la table, dans l'ordre de la taxonomie (domaine, catégorie), du flux (état), des
 * priorités ou des versions ; « Sans … » en dernier. L'ordre des issues de chaque groupe est
 * celui de `issues` (déjà trié). Groupes vides omis.
 */
export function groupIssues<
  T extends Pick<Issue, "category" | "status" | "milestone" | "priority">,
>(
  issues: readonly T[],
  by: GroupBy,
  domains: readonly DomainView[],
  compareVersions: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): IssueGroup<T>[] {
  const index = indexCategories(domains);
  const bucket = new Map<string, T[]>();
  const push = (key: string, issue: T) => {
    const list = bucket.get(key);
    if (list) list.push(issue);
    else bucket.set(key, [issue]);
  };
  const NONE = "∅";
  const build = (
    order: { key: string; label: string; color: string; hint?: string }[],
    noneLabel: string,
  ) => {
    const out: IssueGroup<T>[] = [];
    for (const o of order) {
      const items = bucket.get(o.key);
      if (items?.length) out.push({ ...o, items });
    }
    const rest = bucket.get(NONE);
    if (rest?.length)
      out.push({ key: NONE, label: noneLabel, color: NO_CATEGORY_COLOR, items: rest });
    return out;
  };

  switch (by) {
    case "none":
      return issues.length
        ? [{ key: "all", label: "Toutes les issues", color: NO_CATEGORY_COLOR, items: [...issues] }]
        : [];
    case "domain":
      for (const i of issues) push((i.category && index.get(i.category)?.domain.id) || NONE, i);
      return build(
        domains.map((d) => ({ key: d.id, label: d.label, color: d.color })),
        "Sans catégorie",
      );
    case "category":
      for (const i of issues) push(i.category && index.has(i.category) ? i.category : NONE, i);
      return build(
        domains.flatMap((d) =>
          d.categories.map((c) => ({ key: c.id, label: c.label, color: d.color, hint: d.label })),
        ),
        "Sans catégorie",
      );
    case "status":
      for (const i of issues) push(i.status, i);
      return build(
        statusOrder.map((s) => ({ key: s, label: issueStatuses[s].label, color: statusColor[s] })),
        "",
      );
    case "priority":
      for (const i of issues)
        push(i.priority === null || i.priority === undefined ? NONE : String(i.priority), i);
      return build(
        [0, 1, 2, 3, 4, 5].map((p) => ({
          key: String(p),
          label: p === 0 ? "P0 · socle" : `P${p}`,
          color: priorityColor[p]!,
        })),
        "Sans priorité",
      );
    case "milestone": {
      for (const i of issues) push(i.milestone ?? NONE, i);
      const versions = [...bucket.keys()].filter((k) => k !== NONE).sort(compareVersions);
      return build(
        versions.map((v) => ({ key: v, label: v, color: "#d97757" })),
        "Sans version",
      );
    }
  }
}

/** Répartition des états d'un groupe (barre « batterie » de l'en-tête). */
export function statusShares(
  issues: readonly Pick<Issue, "status">[],
): { status: IssueStatus; count: number; color: string }[] {
  return statusOrder
    .map((status) => ({
      status,
      count: issues.filter((i) => i.status === status).length,
      color: statusColor[status],
    }))
    .filter((s) => s.count > 0);
}

/** Story points d'un groupe (issues estimées seulement). */
export function pointsOf(issues: readonly Pick<Issue, "points">[]): number {
  return issues.reduce((sum, i) => sum + (i.points ?? 0), 0);
}

/** Recherche plein texte : titre, numéro (`#12` ou `12`), labels. */
export function matchesSearch(
  issue: Pick<Issue, "title" | "number" | "labels">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (/^#?\d+$/.test(q)) return String(issue.number).startsWith(q.replace("#", ""));
  return (
    issue.title.toLowerCase().includes(q) || issue.labels.some((l) => l.toLowerCase().includes(q))
  );
}

/* ---------- Personnalisation (vue Catégories) ---------- */

/** Identifiant tiré d'un libellé : « Développement mobile » → `developpement-mobile`. */
export function slugify(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Identifiant libre : `base`, sinon `base-2`, `base-3`… */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = base || "categorie";
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const id = `${root.slice(0, 37)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Tous les identifiants pris (domaines et catégories), défauts compris. */
export function takenIds(domains: readonly DomainView[]): Set<string> {
  const ids = new Set<string>();
  for (const d of domains) {
    ids.add(d.id);
    for (const c of d.categories) ids.add(c.id);
  }
  return ids;
}

/** Ajoute une catégorie : dans un domaine ajouté, ou à la liste des ajouts d'un domaine existant. */
export function addCategory(
  config: CategoryConfig,
  domains: readonly DomainView[],
  domainId: string,
  label: string,
  description = "",
): CategoryConfig {
  const id = uniqueId(slugify(label), takenIds(domains));
  const category: Category = { id, label: label.trim(), description: description.trim() };
  const custom = config.domains?.find((d) => d.id === domainId);
  if (custom) {
    return {
      ...config,
      domains: config.domains!.map((d) =>
        d.id === domainId ? { ...d, categories: [...d.categories, category] } : d,
      ),
    };
  }
  return {
    ...config,
    categories: [...(config.categories ?? []), { ...category, domain: domainId }],
  };
}

/** Ajoute un domaine (couleur de la palette, pipeline facultatif). */
export function addDomain(
  config: CategoryConfig,
  domains: readonly DomainView[],
  label: string,
  color: string,
  pipeline: string[] = [],
): CategoryConfig {
  const id = uniqueId(slugify(label), takenIds(domains));
  const stages = pipeline
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i, all) => ({
      id: uniqueId(slugify(l), new Set(all.slice(0, i).map(slugify))),
      label: l,
    }));
  const domain: Domain = {
    id,
    label: label.trim(),
    color,
    categories: [],
    ...(stages.length ? { pipeline: stages } : {}),
  };
  return { ...config, domains: [...(config.domains ?? []), domain] };
}

/** Retire un élément ajouté (domaine avec ses catégories, ou catégorie). */
export function removeCustom(config: CategoryConfig, id: string): CategoryConfig {
  return {
    ...config,
    domains: (config.domains ?? [])
      .filter((d) => d.id !== id)
      .map((d) => ({ ...d, categories: d.categories.filter((c) => c.id !== id) })),
    categories: (config.categories ?? []).filter((c) => c.id !== id && c.domain !== id),
  };
}

/** Masque ou réaffiche un élément par défaut. */
export function toggleHidden(config: CategoryConfig, id: string, hidden: boolean): CategoryConfig {
  const set = new Set(config.hidden ?? []);
  if (hidden) set.add(id);
  else set.delete(id);
  return { ...config, hidden: [...set].sort() };
}
