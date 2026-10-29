import { describe, expect, it } from "vitest";
import defaults from "../../server/src/categories.json";
import {
  addCategory,
  addDomain,
  countByCategory,
  groupIssues,
  indexCategories,
  matchesFilter,
  matchesSearch,
  mergeTaxonomies,
  pickable,
  pipelineOf,
  removeCustom,
  slugify,
  statusShares,
  toggleHidden,
  uniqueId,
  type DomainView,
} from "./categories";
import type { Issue } from "./domain";

const domains: DomainView[] = (defaults.domains as DomainView[]).map((d) => ({
  ...d,
  pipeline: d.pipeline ?? null,
  custom: false,
  hidden: false,
  categories: d.categories.map((c) => ({ ...c, custom: false, hidden: false })),
}));

const issue = (number: number, extra: Partial<Issue> = {}): Issue => ({
  repo: "me/app",
  number,
  title: `Issue ${number}`,
  state: "open",
  status: "todo",
  type: null,
  estimate: null,
  points: null,
  priority: null,
  labels: [],
  milestone: null,
  assignees: [],
  author: null,
  comments: 0,
  url: "",
  updated_at: null,
  ...extra,
});

describe("taxonomie", () => {
  it("indexe chaque catégorie avec son domaine", () => {
    const index = indexCategories(domains);
    expect(index.get("dat")?.domain.id).toBe("documentation");
    expect(index.get("back-end")?.domain.id).toBe("dev");
    expect(pipelineOf(index, "questions-client")?.[0]?.id).toBe("a-preparer");
    expect(pipelineOf(index, "back-end")).toBeNull();
    expect(pipelineOf(index, null)).toBeNull();
  });

  it("réunit les taxonomies de plusieurs dépôts sans doublon", () => {
    const other = domains.map((d) =>
      d.id === "dev"
        ? {
            ...d,
            categories: [
              ...d.categories,
              { id: "rust", label: "Rust", description: "", custom: true, hidden: false },
            ],
          }
        : d,
    );
    const hiddenHere = domains.map((d) => (d.id === "design" ? { ...d, hidden: true } : d));
    const merged = mergeTaxonomies([hiddenHere, other]);
    expect(merged).toHaveLength(domains.length);
    expect(merged.find((d) => d.id === "dev")?.categories.some((c) => c.id === "rust")).toBe(true);
    // Masqué dans un seul dépôt : reste proposé.
    expect(merged.find((d) => d.id === "design")?.hidden).toBe(false);
  });

  it("ne propose pas les éléments masqués, sauf celui de l'issue", () => {
    const masked = domains.map((d) =>
      d.id === "dev"
        ? {
            ...d,
            categories: d.categories.map((c) => (c.id === "mobile" ? { ...c, hidden: true } : c)),
          }
        : d,
    );
    const ids = (list: DomainView[]) => list.flatMap((d) => d.categories.map((c) => c.id));
    expect(ids(pickable(masked))).not.toContain("mobile");
    expect(ids(pickable(masked, "mobile"))).toContain("mobile");
  });
});

describe("filtre et compteurs", () => {
  const index = indexCategories(domains);
  const list = [
    issue(1, { category: "back-end" }),
    issue(2, { category: "front-end" }),
    issue(3, { category: "dat" }),
    issue(4),
    issue(5, { category: "supprimee" }),
  ];

  it("filtre par domaine, catégorie ou absence de catégorie", () => {
    const pick = (f: Parameters<typeof matchesFilter>[1]) =>
      list.filter((i) => matchesFilter(i, f, index)).map((i) => i.number);
    expect(pick({ kind: "all" })).toEqual([1, 2, 3, 4, 5]);
    expect(pick({ kind: "domain", id: "dev" })).toEqual([1, 2]);
    expect(pick({ kind: "category", id: "dat" })).toEqual([3]);
    // Une catégorie inconnue (supprimée) compte comme « sans catégorie ».
    expect(pick({ kind: "none" })).toEqual([4, 5]);
  });

  it("compte par domaine et par catégorie", () => {
    const c = countByCategory(list, index);
    expect(c.domains.get("dev")).toBe(2);
    expect(c.categories.get("dat")).toBe(1);
    expect(c.none).toBe(2);
  });

  it("cherche dans le titre, le numéro et les labels", () => {
    expect(matchesSearch(issue(42, { title: "Rédiger le DAT" }), "dat")).toBe(true);
    expect(matchesSearch(issue(42), "#4")).toBe(true);
    expect(matchesSearch(issue(42), "5")).toBe(false);
    expect(matchesSearch(issue(7, { labels: ["area/api"] }), "api")).toBe(true);
  });
});

describe("groupes de la table", () => {
  const list = [
    issue(1, { category: "dat", status: "doing", points: 5 }),
    issue(2, { category: "back-end", priority: 1 }),
    issue(3, { status: "done", milestone: "0.10.0" }),
    issue(4, { category: "front-end", milestone: "0.9.0", priority: 0 }),
  ];

  it("groupe par domaine dans l'ordre de la taxonomie, sans catégorie en dernier", () => {
    const g = groupIssues(list, "domain", domains);
    expect(g.map((x) => x.key)).toEqual(["dev", "documentation", "∅"]);
    expect(g[0]!.items.map((i) => i.number)).toEqual([2, 4]);
    expect(g.at(-1)!.label).toBe("Sans catégorie");
  });

  it("groupe par catégorie, état, priorité et version", () => {
    expect(groupIssues(list, "category", domains).map((g) => g.key)).toEqual([
      "back-end",
      "front-end",
      "dat",
      "∅",
    ]);
    expect(groupIssues(list, "status", domains).map((g) => g.key)).toEqual([
      "todo",
      "doing",
      "done",
    ]);
    expect(groupIssues(list, "priority", domains).map((g) => g.key)).toEqual(["0", "1", "∅"]);
    const semver = (a: string, b: string) =>
      a
        .split(".")
        .map(Number)
        .reduce((r, n, i) => r || n - Number(b.split(".")[i]), 0);
    expect(groupIssues(list, "milestone", domains, semver).map((g) => g.key)).toEqual([
      "0.9.0",
      "0.10.0",
      "∅",
    ]);
    expect(groupIssues(list, "none", domains)).toHaveLength(1);
    expect(groupIssues([], "none", domains)).toEqual([]);
  });

  it("répartit les états d'un groupe", () => {
    expect(statusShares(list).map((s) => [s.status, s.count])).toEqual([
      ["todo", 2],
      ["doing", 1],
      ["done", 1],
    ]);
  });
});

describe("personnalisation", () => {
  it("tire un identifiant libre d'un libellé", () => {
    expect(slugify("Développement mobile")).toBe("developpement-mobile");
    expect(slugify("  Comité d'architecture ! ")).toBe("comite-d-architecture");
    expect(uniqueId("dat", new Set(["dat", "dat-2"]))).toBe("dat-3");
    expect(uniqueId("", new Set())).toBe("categorie");
  });

  it("ajoute une catégorie à un domaine par défaut ou ajouté, puis la retire", () => {
    let config = addCategory({}, domains, "dev", "Scraping", "Collecte web");
    expect(config.categories).toEqual([
      { id: "scraping", label: "Scraping", description: "Collecte web", domain: "dev" },
    ]);
    config = addDomain(config, domains, "Marketing", "#112233", ["Idée", " Publié "]);
    expect(config.domains?.[0]).toMatchObject({
      id: "marketing",
      pipeline: [
        { id: "idee", label: "Idée" },
        { id: "publie", label: "Publié" },
      ],
    });
    config = addCategory(config, domains, "marketing", "SEO");
    expect(config.domains?.[0]?.categories.map((c) => c.id)).toEqual(["seo"]);
    // Identifiant déjà pris par une catégorie par défaut : suffixé.
    expect(addCategory({}, domains, "dev", "DAT").categories?.[0]?.id).toBe("dat-2");

    config = removeCustom(config, "marketing");
    expect(config.domains).toEqual([]);
    expect(removeCustom(config, "scraping").categories).toEqual([]);
  });

  it("masque et réaffiche un élément par défaut", () => {
    const hidden = toggleHidden({}, "mobile", true);
    expect(hidden.hidden).toEqual(["mobile"]);
    expect(toggleHidden(hidden, "mobile", false).hidden).toEqual([]);
  });
});
