/**
 * Hôte simulé pour `pnpm dev` hors de Cadence : deux dépôts suivis (service `repos` simulé) et
 * des issues, versions, pull requests et releases d'exemple, sans réseau. `?view=sprint`,
 * `roadmap`, `versions`, `pull-requests` ou `setup-depots` ouvre une vue (`&version=0.1.2` : détail
 * d'une version) ; `?repo=all` démarre sur « Tous les dépôts ». Dans Cadence (iframe), ce module
 * n'est pas utilisé.
 */
import type { MockHostOptions } from "@cadence/plugin-sdk";
import type {
  AccountRepo,
  Issue,
  JalonView,
  ProjectView,
  PullRequest,
  Release,
  RoadmapPlan,
  Version,
} from "./domain";
import { sprintStart } from "./planning";

const params = new URLSearchParams(location.search);

const issue = (repo: string, n: number, title: string, extra: Partial<Issue>): Issue => ({
  repo,
  number: n,
  title,
  state: "open",
  status: "todo",
  type: "feat",
  estimate: null,
  points: null,
  priority: null,
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
    points: 3,
    priority: 1,
    labels: ["type/fix", "status/doing", "sp/3", "priority/1", "area/api"],
    assignees: ["RemiSDV"],
    updated_at: "2026-10-15T16:00:00Z",
  }),
  issue("RemiSDV/cadence", 149, "Connexion GitHub par device flow", {
    status: "review",
    points: 8,
    priority: 0,
    labels: ["type/feat", "status/review", "sp/8", "priority/0", "area/auth"],
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
  {
    full_name: "RemiSDV/cadence-plugins",
    private: false,
    description: "Plugins",
    updated_at: null,
  },
  {
    full_name: "RemiSDV/notes",
    private: true,
    description: "Notes personnelles",
    updated_at: null,
  },
];

/* ---------- Versions, sprint, PR, releases ---------- */

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const version = (title: string, extra: Partial<Version>): Version => ({
  title,
  number: 1,
  kind: "sprint",
  state: "open",
  due_on: null,
  name: null,
  themes: [],
  description: null,
  open_issues: 0,
  closed_issues: 0,
  closed_at: null,
  url: "https://github.com/RemiSDV/cadence/milestones",
  ...extra,
});

const versions: Version[] = [
  version("0.1.0", {
    number: 1,
    state: "closed",
    due_on: `${day(-30)}T07:00:00Z`,
    closed_at: `${day(-30)}T18:00:00Z`,
    name: "Lecture du projet",
    closed_issues: 9,
  }),
  version("0.1.1", {
    number: 2,
    state: "closed",
    due_on: `${day(-16)}T07:00:00Z`,
    closed_at: `${day(-15)}T18:00:00Z`,
    name: "Cockpit Tauri",
    closed_issues: 12,
  }),
  version("0.1.2", {
    number: 3,
    due_on: `${day(6)}T07:00:00Z`,
    name: "Connexion GitHub",
    open_issues: 3,
    closed_issues: 5,
  }),
  version("0.1.3", { number: 4, due_on: `${day(20)}T07:00:00Z`, open_issues: 3 }),
  version("0.2.0", {
    number: 5,
    kind: "palier",
    name: "Travail à plusieurs",
    themes: ["Rôles et permissions", "Revue assistée", "Multi-dépôts", "Notifications"],
    description:
      "# Travail à plusieurs\n- Rôles et permissions\n- Revue assistée\n- Multi-dépôts\n- Notifications",
  }),
  version("1.0.0", {
    number: 6,
    kind: "palier",
    name: "Version stable",
    themes: ["Plugins publics"],
  }),
];

const closedIssue = (n: number, title: string, daysAgo: number, extra: Partial<Issue> = {}) =>
  issue("RemiSDV/cadence", n, title, {
    status: "done",
    state: "closed",
    closed_at: `${day(-daysAgo)}T10:00:00Z`,
    updated_at: `${day(-daysAgo)}T10:00:00Z`,
    ...extra,
  });

const sprintIssues: Issue[] = [
  closedIssue(141, "Écran de connexion GitHub", 7),
  closedIssue(142, "Device flow GitHub", 5, {
    points: 5,
    priority: 0,
    labels: ["sp/5", "priority/0"],
  }),
  closedIssue(143, "Jeton au trousseau", 5, { type: "chore" }),
  closedIssue(145, "Code d'appairage", 2),
  closedIssue(147, "Jeton personnel en repli", 1, { type: "fix" }),
  ...issues.filter((i) => i.repo === "RemiSDV/cadence" && i.milestone === "0.1.2"),
  issue("RemiSDV/cadence", 158, "Déconnexion depuis les réglages", {
    estimate: "S",
    assignees: ["RemiSDV"],
  }),
];

const count = (list: Issue[], status: Issue["status"]) =>
  list.filter((i) => i.status === status).length;

/** Sprints automatiques simulés : démarrés sur RemiSDV/cadence, à démarrer sur l'autre dépôt. */
const projects: Record<string, ProjectView | null> = {
  "RemiSDV/cadence": {
    issue: 160,
    url: "https://github.com/RemiSDV/cadence/issues/160",
    status: "running",
    paused_since: null,
    duration_days: 14,
    points_per_day: 1.6,
    capacity: 22,
    next_capacity: 22,
    current: "0.1.2",
    release_branch: "release/0.1.2",
    carried: [148],
    sprints: [
      {
        version: "0.1.2",
        branch: "release/0.1.2",
        start_on: day(-6),
        due_on: day(8),
        paused_days: 0,
        capacity: 22,
        filled: true,
        carried: [148],
      },
      {
        version: "0.1.1",
        branch: "release/0.1.1",
        start_on: day(-20),
        due_on: day(-6),
        paused_days: 0,
        capacity: 20,
        filled: true,
        done_points: 18,
        ended_on: day(-6),
        release: { status: "pending", pull_request: 158, message: "CI en cours sur la PR #158." },
      },
      {
        version: "0.1.0",
        branch: "release/0.1.0",
        start_on: day(-34),
        due_on: day(-20),
        paused_days: 2,
        capacity: 21,
        filled: true,
        done_points: 26,
        ended_on: day(-20),
        release: { status: "merged", pull_request: 140, tag: "v0.1.0" },
      },
    ],
  },
  "RemiSDV/cadence-plugins": null,
};

/** Roadmap simulée : trois jalons sur RemiSDV/cadence, sprints terminés, en cours et prévus. */
const jalonIssue = (
  number: number,
  title: string,
  state: "open" | "closed",
  points: number | null,
  priority: number | null,
  sprint: string | null,
) => ({
  number,
  title,
  state,
  status: state === "closed" ? ("done" as const) : ("todo" as const),
  points,
  priority,
  sprint,
});

const jalons: JalonView[] = [
  {
    id: "connexion-github",
    name: "Connexion GitHub",
    description:
      "Se connecter à GitHub sans quitter Cadence : device flow, code d'appairage, jeton au trousseau.",
    status: "in_progress",
    issues: [
      jalonIssue(141, "Écran de connexion GitHub", "closed", 3, 0, "0.1.0"),
      jalonIssue(142, "Device flow GitHub", "closed", 5, 0, "0.1.1"),
      jalonIssue(149, "Connexion GitHub par device flow", "open", 8, 0, "0.1.2"),
      jalonIssue(156, "Message d'erreur quand le quota de l'API est épuisé", "open", 3, 1, "0.1.2"),
    ],
    total: 4,
    closed: 2,
    points_total: 19,
    points_done: 8,
    unestimated: 0,
    unplanned: 0,
    sprints: ["0.1.0", "0.1.1", "0.1.2"],
    start_on: day(-34),
    end_on: day(8),
    end_early: day(8),
    end_late: day(8),
  },
  {
    id: "mvp-prive",
    name: "MVP privé",
    description: "Une première version utilisable par l'équipe : kanban, sprints et notifications.",
    status: "planned",
    issues: [
      jalonIssue(158, "Déconnexion depuis les réglages", "open", 2, 2, "0.1.3"),
      jalonIssue(160, "Notifications de fin de sprint", "open", 5, 2, "0.1.3"),
      jalonIssue(161, "Kanban glisser-déposer", "open", 8, 3, "0.1.4"),
      jalonIssue(162, "Recherche dans les issues", "open", null, 3, "0.1.4"),
    ],
    total: 4,
    closed: 0,
    points_total: 18,
    points_done: 0,
    unestimated: 1,
    unplanned: 0,
    sprints: ["0.1.3", "0.1.4"],
    start_on: day(8),
    end_on: day(36),
    end_early: day(22),
    end_late: day(50),
  },
  {
    id: "beta-publique",
    name: "Bêta publique",
    description: "",
    status: "empty",
    issues: [],
    total: 0,
    closed: 0,
    points_total: 0,
    points_done: 0,
    unestimated: 0,
    unplanned: 0,
    sprints: [],
    start_on: null,
    end_on: null,
    end_early: null,
    end_late: null,
  },
];

function roadmap(repo: string): RoadmapPlan {
  if (repo !== "RemiSDV/cadence") {
    return {
      repo,
      today: day(0),
      started: false,
      sprints: [],
      jalons: [],
      unassigned: [],
      end: null,
    };
  }
  return {
    repo,
    today: day(0),
    started: true,
    issue: 160,
    url: "https://github.com/RemiSDV/cadence/issues/160",
    duration_days: 14,
    rates: { low: 1.3, avg: 1.6, high: 1.9 },
    sprints: [
      { version: "0.1.0", start_on: day(-34), due_on: day(-20), state: "done", points: 26 },
      { version: "0.1.1", start_on: day(-20), due_on: day(-6), state: "done", points: 18 },
      { version: "0.1.2", start_on: day(-6), due_on: day(8), state: "current", points: 22 },
      { version: "0.1.3", start_on: day(8), due_on: day(22), state: "planned", points: 21 },
      { version: "0.1.4", start_on: day(22), due_on: day(36), state: "planned", points: 19 },
      { version: "0.1.5", start_on: day(36), due_on: day(50), state: "planned", points: 12 },
    ],
    jalons,
    unassigned: [
      { number: 163, title: "Export CSV des sprints", points: 3, priority: 4, milestone: null },
      { number: 164, title: "Thème clair", points: 5, priority: 5, milestone: null },
    ],
    end: { on: day(50), early: day(36), late: day(64), unplanned: 0 },
  };
}

const startDefaults = { duration_days: 14, capacity: 20, first_version: "0.4.0" };

function sprintSummary(repo: string, title?: string) {
  const v = versions.find((x) => x.title === (title ?? "0.1.2"));
  const project = projects[repo] ?? null;
  if (!v || repo !== "RemiSDV/cadence") {
    return {
      repo,
      today: day(0),
      sprint_length_days: 14,
      sprint: null,
      project,
      ...(project ? {} : { start_defaults: startDefaults }),
      message:
        "Aucun sprint en cours : démarrez le projet pour que Cadence crée les sprints, ou datez une version.",
    };
  }
  const list = v.title === "0.1.2" ? sprintIssues : [];
  const closed = count(list, "done");
  const start = v.kind === "sprint" && v.due_on ? sprintStart(v.due_on, 14) : null;
  const elapsed = start
    ? Math.min(14, Math.max(0, Math.round((Date.parse(day(0)) - Date.parse(start)) / 86_400_000)))
    : 0;
  const burndown = start
    ? Array.from({ length: elapsed + 1 }, (_, i) => {
        const date = new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10);
        return {
          date,
          remaining: list.filter((x) => !x.closed_at || x.closed_at.slice(0, 10) > date).length,
        };
      })
    : [];
  return {
    repo,
    today: day(0),
    sprint_length_days: 14,
    sprint: v,
    project,
    issues: list,
    pace: {
      start_on: start,
      due_on: v.due_on?.slice(0, 10) ?? null,
      days_left: v.due_on
        ? Math.round((Date.parse(v.due_on.slice(0, 10)) - Date.parse(day(0))) / 86_400_000)
        : null,
      length_days: start ? 14 : null,
      total: list.length,
      closed,
      progress: list.length ? Math.round((closed / list.length) * 100) : 0,
      counts: {
        todo: count(list, "todo"),
        doing: count(list, "doing"),
        review: count(list, "review"),
        done: closed,
      },
      points_total: list.reduce((sum, i) => sum + (i.points ?? 0), 0),
      points_done: list
        .filter((i) => i.state === "closed")
        .reduce((sum, i) => sum + (i.points ?? 0), 0),
      unestimated: list.filter((i) => i.points === null).length,
      velocity: 0.6,
      delay_days: 1.4,
      burndown,
    },
  };
}

const pr = (
  repo: string,
  number: number,
  title: string,
  extra: Partial<PullRequest>,
): PullRequest => ({
  repo,
  number,
  title,
  state: "open",
  head: `feat/${number}-branche`,
  base: "main",
  author: "RemiSDV",
  url: `https://github.com/${repo}/pull/${number}`,
  milestone: "0.1.2",
  labels: [],
  closes: [],
  ci: { state: "success", passed: 4, total: 4 },
  review: null,
  approvals: 0,
  changes_requested: 0,
  reviewers: [],
  review_requested_at: null,
  additions: 120,
  deletions: 14,
  changed_files: 6,
  comments: 1,
  created_at: `${day(-3)}T09:00:00Z`,
  updated_at: `${day(-1)}T09:00:00Z`,
  ...extra,
});

const pulls: PullRequest[] = [
  pr("RemiSDV/cadence", 160, "fix(api) : message clair quand le quota est épuisé", {
    head: "fix/156-quota",
    closes: [156],
    ci: { state: "failure", passed: 3, total: 4 },
    review: "pending",
    reviewers: ["marc"],
    review_requested_at: `${day(-2)}T08:00:00Z`,
  }),
  pr("RemiSDV/cadence", 161, "feat(auth) : device flow GitHub", {
    state: "draft",
    head: "feat/149-device-flow",
    closes: [149],
    ci: { state: "pending", passed: 1, total: 3 },
  }),
  pr("RemiSDV/cadence-plugins", 14, "feat(gestion-projet) : vue Roadmap", {
    head: "feat/12-roadmap",
    milestone: "0.3.0",
    review: "approved",
    approvals: 1,
  }),
  pr("RemiSDV/cadence", 152, "feat(auth) : code d'appairage", {
    state: "merged",
    head: "feat/145-appairage",
    closes: [145],
    review: "approved",
    approvals: 2,
    updated_at: `${day(-2)}T09:00:00Z`,
  }),
];

const release = (v: string, daysAgo: number): Release => ({
  tag: `v${v}`,
  version: v,
  name: `v${v}`,
  draft: false,
  prerelease: false,
  url: `https://github.com/RemiSDV/cadence/releases/tag/v${v}`,
  created_at: `${day(-daysAgo)}T18:00:00Z`,
  published_at: `${day(-daysAgo)}T18:30:00Z`,
  author: "RemiSDV",
});

const releases: Release[] = [release("0.1.1", 15), release("0.1.0", 30)];

const isOpen = (p: PullRequest) => p.state === "open" || p.state === "draft";

const planningTools: MockHostOptions["tools"] = {
  list_milestones: ({ repo }) => ({
    repo,
    versions: repo === "RemiSDV/cadence" ? versions : [versions[4]!],
  }),
  sprint_summary: ({ repo, version }) =>
    sprintSummary(repo as string, version as string | undefined),
  roadmap: ({ repo }) => roadmap(repo as string),
  jalon_save: ({ repo, id, name, description, position }) => {
    let j = jalons.find((x) => x.id === id);
    if (!j) {
      j = {
        ...jalons[2]!,
        id: String(name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-"),
        issues: [],
        status: "empty",
      };
      jalons.push(j);
    }
    Object.assign(j, { name, ...(description !== undefined ? { description } : {}) });
    if (position !== undefined) {
      jalons.splice(jalons.indexOf(j), 1);
      jalons.splice(Number(position), 0, j);
    }
    return { repo, id: j.id, jalons };
  },
  jalon_delete: ({ repo, id }) => {
    jalons.splice(
      jalons.findIndex((x) => x.id === id),
      1,
    );
    return { repo, jalons };
  },
  jalon_issues: ({ repo }) => ({ repo, jalons }),
  project_start: ({ repo, duration_days, capacity, first_version }) => {
    const version = String(first_version);
    const project: ProjectView = {
      issue: 31,
      url: `https://github.com/${String(repo)}/issues/31`,
      status: "running",
      paused_since: null,
      duration_days: Number(duration_days),
      points_per_day: Number(capacity) / Number(duration_days),
      capacity: Number(capacity),
      next_capacity: Number(capacity),
      current: version,
      release_branch: `release/${version}`,
      carried: [],
      sprints: [
        {
          version,
          branch: `release/${version}`,
          start_on: day(0),
          due_on: day(Number(duration_days)),
          paused_days: 0,
          capacity: Number(capacity),
          filled: true,
        },
      ],
    };
    projects[repo as string] = project;
    return { repo, project };
  },
  project_pause: ({ repo }) => {
    const p = projects[repo as string]!;
    Object.assign(p, { status: "paused", paused_since: day(0) });
    return { repo, project: p };
  },
  project_resume: ({ repo }) => {
    const p = projects[repo as string]!;
    Object.assign(p, { status: "running", paused_since: null });
    return { repo, project: p };
  },
  project_set_duration: ({ repo, duration_days }) => {
    const p = projects[repo as string]!;
    p.duration_days = Number(duration_days);
    p.capacity = Math.round(p.points_per_day * p.duration_days);
    return { repo, project: p };
  },
  list_pull_requests: ({ repo, state }) => {
    const wanted = (state as string | undefined) ?? "open";
    return {
      repo: (repo as string | undefined) ?? null,
      repos: repo ? [repo] : ["RemiSDV/cadence", "RemiSDV/cadence-plugins"],
      pull_requests: pulls.filter(
        (p) =>
          (!repo || p.repo === repo) && (wanted === "all" || (wanted === "open") === isOpen(p)),
      ),
    };
  },
  get_pull_request: ({ repo, number }) => {
    const p = pulls.find((x) => x.repo === repo && x.number === number);
    if (!p) throw new Error(`Pull request #${String(number)} introuvable dans ${String(repo)}.`);
    return {
      ...p,
      body: "## Contexte\nLe quota de l'API était affiché comme une erreur réseau.\n\nCloses #156",
      mergeable: "mergeable",
      reviews: [
        {
          author: "marc",
          state: "commented",
          submitted_at: `${day(-1)}T10:00:00Z`,
          body: "Ajouter un test ?",
        },
      ],
      checks: [
        { name: "typecheck", state: "success", url: null },
        { name: "test", state: p.ci.state === "failure" ? "failure" : "success", url: null },
        { name: "build", state: "success", url: null },
      ],
      files: [
        { path: "src/lib/github/errors.ts", status: "modified", additions: 42, deletions: 6 },
        { path: "src/lib/github/errors.test.ts", status: "added", additions: 78, deletions: 0 },
      ],
    };
  },
  mark_pull_request_ready: ({ repo, number }) => {
    const p = pulls.find((x) => x.repo === repo && x.number === number);
    if (p) p.state = "open";
    return { repo, number, draft: false };
  },
  list_releases: ({ repo }) => ({
    repo,
    tag_prefix: "v",
    releases: repo === "RemiSDV/cadence" ? releases : [],
  }),
  update_milestone: ({ repo, title, state }) => {
    const v = versions.find((x) => x.title === title);
    if (!v) throw new Error(`Version « ${String(title)} » introuvable.`);
    if (state === "closed")
      Object.assign(v, { state: "closed", closed_at: new Date().toISOString() });
    return { repo, version: v };
  },
};

export const devHost: MockHostOptions = {
  plugin: { id: "gestion-projet", version: "0.3.0" },
  route: {
    view: params.get("view") ?? "issues",
    params: params.get("version")
      ? { repo: "RemiSDV/cadence", version: params.get("version")! }
      : {},
  },
  settings: { tag_prefix: "v", sprint_length_days: 14 },
  repos: {
    repos: ["RemiSDV/cadence", "RemiSDV/cadence-plugins"],
    selection:
      params.get("repo") === "all" ? { kind: "all" } : { kind: "one", repo: "RemiSDV/cadence" },
  },
  tools: {
    list_issues: ({ repo, state }) => {
      const wanted = (state as string | undefined) ?? "open";
      return {
        repo: (repo as string | undefined) ?? null,
        repos: repo ? [repo] : ["RemiSDV/cadence", "RemiSDV/cadence-plugins"],
        issues: issues.filter(
          (i) => (!repo || i.repo === repo) && (wanted === "all" || i.state === wanted),
        ),
        page: 1,
        has_more: false,
      };
    },
    get_account: () => ({ login: "RemiSDV", name: "Rémi Lhuillier", avatar_url: null, repos: [] }),
    list_account_repos: () => ({ repos: accountRepos.map((r) => ({ ...r, followed: false })) }),
    ...planningTools,
  },
};
