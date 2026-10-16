/**
 * Hôte simulé pour `pnpm dev` hors de Cadence : quelques issues d'exemple, sans réseau.
 * Dans Cadence (iframe), ce module n'est pas utilisé.
 */
import type { MockHostOptions } from "@cadence/plugin-sdk";
import type { Issue } from "./domain";

const issue = (n: number, title: string, extra: Partial<Issue>): Issue => ({
  number: n,
  title,
  state: "open",
  status: "todo",
  type: "feat",
  estimate: null,
  labels: [],
  milestone: "0.1.2",
  assignees: [],
  author: "RemiSDV",
  comments: 0,
  url: `https://github.com/RemiSDV/cadence/issues/${n}`,
  updated_at: "2026-10-14T09:00:00Z",
  ...extra,
});

const issues: Issue[] = [
  issue(156, "Message d'erreur quand le quota de l'API est épuisé", {
    type: "fix",
    status: "doing",
    estimate: "M",
    labels: ["type/fix", "status/doing", "estimate/M", "area/api"],
    assignees: ["RemiSDV"],
  }),
  issue(149, "Connexion GitHub par device flow", {
    status: "review",
    estimate: "L",
    labels: ["type/feat", "status/review", "area/auth"],
  }),
  issue(159, "Changelog généré depuis les issues fermées", {
    type: "docs",
    milestone: null,
    labels: ["type/docs"],
  }),
  issue(161, "Accélérer le chargement du tableau de sprint", {
    type: "perf",
    labels: ["type/perf", "area/ui"],
  }),
];

export const devHost: MockHostOptions = {
  plugin: { id: "gestion-projet", version: "0.1.0" },
  workspace: { name: "Cadence", path: "C:/projets/cadence", ai: "claude-code" },
  route: { view: new URLSearchParams(location.search).get("view") ?? "issues", params: {} },
  settings: { repository: "RemiSDV/cadence", tag_prefix: "v", sprint_length_days: 14 },
  tools: {
    list_issues: ({ state }) => ({
      repository: "RemiSDV/cadence",
      issues: issues.filter((i) => state === "all" || i.state === (state ?? "open")),
      page: 1,
      has_more: false,
    }),
    get_account: () => ({ login: "RemiSDV", name: "Rémi Lhuillier", avatar_url: null, repository: "RemiSDV/cadence" }),
  },
};
