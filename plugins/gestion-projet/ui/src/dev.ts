/**
 * Hôte simulé pour `pnpm dev` hors de Cadence : deux dépôts suivis (service `repos` simulé) et
 * quelques issues d'exemple, sans réseau. `?view=setup-depots` ouvre l'étape de setup ;
 * `?repo=all` démarre sur « Tous les dépôts ». Dans Cadence (iframe), ce module n'est pas utilisé.
 */
import type { MockHostOptions } from "@cadence/plugin-sdk";
import type { AccountRepo, Issue } from "./domain";

const params = new URLSearchParams(location.search);

const issue = (repo: string, n: number, title: string, extra: Partial<Issue>): Issue => ({
  repo,
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
  url: `https://github.com/${repo}/issues/${n}`,
  updated_at: "2026-10-14T09:00:00Z",
  ...extra,
});

const issues: Issue[] = [
  issue("RemiSDV/cadence", 156, "Message d'erreur quand le quota de l'API est épuisé", {
    type: "fix",
    status: "doing",
    estimate: "M",
    labels: ["type/fix", "status/doing", "estimate/M", "area/api"],
    assignees: ["RemiSDV"],
    updated_at: "2026-10-15T16:00:00Z",
  }),
  issue("RemiSDV/cadence", 149, "Connexion GitHub par device flow", {
    status: "review",
    estimate: "L",
    labels: ["type/feat", "status/review", "area/auth"],
  }),
  issue("RemiSDV/cadence-plugins", 12, "Vue Roadmap du plugin Gestion de projet", {
    milestone: "0.3.0",
    labels: ["type/feat", "area/ui"],
    updated_at: "2026-10-16T08:00:00Z",
  }),
  issue("RemiSDV/cadence", 159, "Changelog généré depuis les issues fermées", {
    type: "docs",
    milestone: null,
    labels: ["type/docs"],
  }),
  issue("RemiSDV/cadence-plugins", 9, "Accélérer l'extraction des PDF volumineux", {
    type: "perf",
    milestone: null,
    labels: ["type/perf"],
  }),
];

const accountRepos: Omit<AccountRepo, "followed">[] = [
  { full_name: "RemiSDV/cadence", private: false, description: "Hôte de bureau", updated_at: null },
  { full_name: "RemiSDV/cadence-plugins", private: false, description: "Plugins", updated_at: null },
  { full_name: "RemiSDV/notes", private: true, description: "Notes personnelles", updated_at: null },
];

export const devHost: MockHostOptions = {
  plugin: { id: "gestion-projet", version: "0.2.0" },
  route: { view: params.get("view") ?? "issues", params: {} },
  settings: { tag_prefix: "v", sprint_length_days: 14 },
  repos: {
    repos: ["RemiSDV/cadence", "RemiSDV/cadence-plugins"],
    selection: params.get("repo") === "all" ? { kind: "all" } : { kind: "one", repo: "RemiSDV/cadence" },
  },
  tools: {
    list_issues: ({ repo, state }) => {
      const wanted = (state as string | undefined) ?? "open";
      return {
        repo: (repo as string | undefined) ?? null,
        repos: repo ? [repo] : ["RemiSDV/cadence", "RemiSDV/cadence-plugins"],
        issues: issues.filter((i) => (!repo || i.repo === repo) && (wanted === "all" || i.state === wanted)),
        page: 1,
        has_more: false,
      };
    },
    get_account: () => ({ login: "RemiSDV", name: "Rémi Lhuillier", avatar_url: null, repos: [] }),
    list_account_repos: () => ({ repos: accountRepos.map((r) => ({ ...r, followed: false })) }),
  },
};
