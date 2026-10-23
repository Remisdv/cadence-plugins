/**
 * Hôte simulé pour `pnpm dev` hors de Cadence : deux dépôts suivis (service `repos` simulé) et
 * des issues, versions, pull requests et releases d'exemple, sans réseau. `?view=sprint`,
 * `roadmap`, `versions`, `pull-requests` ou `setup-depots` ouvre une vue (`&version=0.1.2` : détail
 * d'une version ; `?view=issue&number=156` : détail d'une issue) ; `?repo=all` démarre sur « Tous
 * les dépôts ». Dans Cadence (iframe), ce module
 * n'est pas utilisé.
 */
import type { MockHostOptions } from "@cadence/plugin-sdk";
import type {
  AccountRepo,
  ArchiTemplate,
  Architecture,
  Issue,
  Design,
  JalonView,
  Planning,
  ProjectView,
  PullRequest,
  Release,
  RoadmapPlan,
  Version,
} from "./domain";
import { issueWeight, pointsByStatus, sprintStart } from "./planning";
// Bibliothèque de modèles du serveur, la même qu'en vrai.
import archiTemplates from "../../server/src/templates.json";

const params = new URLSearchParams(location.search);

/** Sprint 0.1.2 de RemiSDV/cadence : milestone n° 3 (clé du groupe de ses conversations). */
const SPRINT = { number: 3, title: "0.1.2" };
const SPRINT_GROUP = {
  id: `sprint:RemiSDV/cadence:${SPRINT.number}`,
  label: "Sprint 0.1.2 · RemiSDV/cadence",
};

const issue = (repo: string, n: number, title: string, extra: Partial<Issue>): Issue => {
  const i: Issue = {
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
  };
  const inSprint = i.repo === "RemiSDV/cadence" && i.milestone === SPRINT.title;
  return { ...i, sprint: inSprint ? SPRINT.number : null };
};

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
  issue("RemiSDV/cadence", 157, "Pagination des issues au-delà de 100", {
    type: "fix",
    status: "review",
    points: 2,
    priority: 2,
    labels: ["type/fix", "status/review", "sp/2", "priority/2", "area/api"],
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

let sprintIssues: Issue[] = [
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

/** Issues du carnet (sans version) en plus de celles de la liste « Issues ». */
const backlogExtra: Issue[] = [
  issue("RemiSDV/cadence", 163, "Export CSV des sprints", {
    milestone: null,
    points: 3,
    priority: 4,
    labels: ["type/feat", "sp/3", "priority/4"],
  }),
  issue("RemiSDV/cadence", 164, "Thème clair", { milestone: null, priority: 5 }),
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
        scope_points: 21,
        milestone: 2,
        ended_on: day(-6),
        release: {
          status: "pending",
          pull_request: 158,
          message: "PR #158 ouverte : aucune vérification encore, en attente de la CI.",
          no_ci: true,
        },
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
        scope_points: 26,
        milestone: 1,
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

/** Planning simulé : étude, conception, développement, recette, lancement, trois personnes. */
const ptask = (
  id: string,
  name: string,
  phase: string,
  start: number,
  end: number,
  extra: Partial<Planning["tasks"][number]> = {},
): Planning["tasks"][number] => ({
  id,
  name,
  phase,
  start: day(start),
  end: day(end),
  people: [],
  depends: [],
  progress: 0,
  milestone: false,
  ...extra,
});

let planning: Planning = {
  revision: 4,
  people: [
    { id: "remi", name: "Rémi Lhuillier" },
    { id: "marc", name: "Marc Durand" },
    { id: "lea", name: "Léa Martin" },
  ],
  phases: ["Étude", "Conception", "Développement", "Recette", "Lancement"],
  tasks: [
    ptask("entretiens", "Entretiens utilisateurs", "Étude", -14, -8, {
      people: ["lea"],
      progress: 100,
    }),
    ptask("marche", "Étude de marché", "Étude", -10, -3, { people: ["remi"], progress: 100 }),
    ptask("synthese", "Synthèse et périmètre", "Étude", -2, 1, {
      people: ["remi", "lea"],
      depends: ["entretiens", "marche"],
      progress: 60,
    }),
    ptask("maquettes", "Maquettes Claude Design", "Conception", 2, 9, {
      people: ["lea"],
      depends: ["synthese"],
    }),
    ptask("archi", "Architecture technique", "Conception", 2, 6, {
      people: ["remi"],
      depends: ["synthese"],
    }),
    ptask("socle", "Socle de l'application", "Développement", 7, 13, {
      people: ["marc"],
      depends: ["archi"],
      issue: 1,
    }),
    ptask("liste", "Liste partagée en temps réel", "Développement", 14, 34, {
      people: ["marc", "remi"],
      depends: ["socle", "maquettes"],
    }),
    ptask("recette", "Recette avec deux familles", "Recette", 35, 44, {
      people: ["lea"],
      depends: ["liste"],
    }),
    ptask("demo", "Démo aux familles", "Recette", 45, 45, {
      milestone: true,
      depends: ["recette"],
    }),
    ptask("lancement", "Mise en ligne", "Lancement", 52, 52, {
      milestone: true,
      depends: ["demo"],
    }),
  ],
};

const designs: Design[] = [
  {
    id: "ecrans-de-l-app",
    name: "Écrans de l'app",
    url: "https://claude.ai/design/exemple",
    status: "imported",
    description: "Liste partagée, réglages et invitations.",
    path: "design/ecrans-de-l-app",
    ref: "design/ecrans-de-l-app",
    entry: "index.html",
    added_on: day(-3),
    imported_on: day(-3),
  },
  {
    id: "page-d-accueil",
    name: "Page d'accueil",
    url: "https://claude.ai/design/accueil",
    status: "pending",
    added_on: day(0),
  },
];

const designPage = (
  title: string,
) => `<!doctype html><html><body style="margin:0;font-family:system-ui;background:#faf7f2;color:#1d1b18">
<header style="padding:18px 24px;background:#c96442;color:white;font-weight:600">${title}</header>
<main style="padding:24px;display:grid;gap:12px;max-width:420px">
<div style="padding:14px;border-radius:12px;background:white;box-shadow:0 1px 3px #0002">🥕 Carottes · 1 kg <span style="float:right">✓</span></div>
<div style="padding:14px;border-radius:12px;background:white;box-shadow:0 1px 3px #0002">🧀 Comté · 300 g</div>
<div style="padding:14px;border-radius:12px;background:white;box-shadow:0 1px 3px #0002">🧻 Essuie-tout · 2</div>
</main></body></html>`;

/** Architecture simulée : web classique, l'API en couches (modèle REST). */
const templates = archiTemplates as unknown as ArchiTemplate[];
const webSystem = templates.find((t) => t.id === "systeme-web-classique")!;
const rest = templates.find((t) => t.id === "rest-couches")!;
let architecture: Architecture | null = {
  version: 1,
  services: webSystem.services.map((s) =>
    s.id === "api"
      ? {
          ...s,
          tech: "NestJS",
          template: rest.id,
          layers: rest.layers,
          rules: rest.rules,
          conventions: rest.conventions,
        }
      : { ...s, layers: s.layers ?? [], rules: s.rules ?? [], conventions: s.conventions ?? [] },
  ),
  links: webSystem.links,
  rules: webSystem.rules,
};

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
  const pointsTotal = list.reduce((sum, i) => sum + issueWeight(i), 0);
  const pointsDone = list
    .filter((i) => i.state === "closed")
    .reduce((sum, i) => sum + issueWeight(i), 0);
  const start = v.kind === "sprint" && v.due_on ? sprintStart(v.due_on, 14) : null;
  const elapsed = start
    ? Math.min(13, Math.max(0, Math.round((Date.parse(day(0)) - Date.parse(start)) / 86_400_000)))
    : 0;
  // Comme le serveur : l'origine (fin de la veille), puis un point par jour écoulé, en SP.
  const burndown = start
    ? Array.from({ length: elapsed + 2 }, (_, i) => {
        const date = new Date(Date.parse(start) + (i - 1) * 86_400_000).toISOString().slice(0, 10);
        return {
          date,
          remaining: list
            .filter((x) => !x.closed_at || x.closed_at.slice(0, 10) > date)
            .reduce((sum, x) => sum + issueWeight(x), 0),
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
      progress: pointsTotal ? Math.round((pointsDone / pointsTotal) * 100) : 0,
      counts: {
        todo: count(list, "todo"),
        doing: count(list, "doing"),
        review: count(list, "review"),
        done: closed,
      },
      points_by_status: pointsByStatus(list),
      points_total: pointsTotal,
      points_done: pointsDone,
      points_remaining: pointsTotal - pointsDone,
      unestimated: list.filter((i) => i.points === null).length,
      velocity: 1.9,
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
  issues: [],
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
    issues: [156],
    ci: { state: "failure", passed: 3, total: 4 },
    review: "pending",
    reviewers: ["marc"],
    review_requested_at: `${day(-2)}T08:00:00Z`,
  }),
  pr("RemiSDV/cadence", 161, "feat(auth) : device flow GitHub", {
    state: "draft",
    head: "feat/149-device-flow",
    closes: [149],
    issues: [149],
    ci: { state: "pending", passed: 1, total: 3 },
  }),
  // Vers la branche de release : GitHub ne relie pas « Closes #n », la branche suffit.
  pr("RemiSDV/cadence", 162, "fix(api) : pagination des issues au-delà de 100", {
    head: "fix/157-pagination",
    base: "release/0.1.2",
    closes: [],
    issues: [157],
    review: "pending",
  }),
  pr("RemiSDV/cadence-plugins", 14, "feat(gestion-projet) : vue Roadmap", {
    head: "feat/12-roadmap",
    issues: [12],
    milestone: "0.3.0",
    review: "approved",
    approvals: 1,
  }),
  pr("RemiSDV/cadence", 152, "feat(auth) : code d'appairage", {
    state: "merged",
    head: "feat/145-appairage",
    closes: [145],
    issues: [145],
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
  architecture_get: ({ repo }) => ({
    repo,
    architecture: repo === "RemiSDV/cadence" ? architecture : null,
    source: { branch: "main", pull_request: null, url: null },
  }),
  architecture_templates: () => ({ templates }),
  architecture_save: ({ repo, architecture: next }) => {
    architecture = next as Architecture;
    return {
      repo,
      architecture,
      source: {
        branch: "archi/2026-10-19",
        pull_request: 14,
        url: "https://github.com/RemiSDV/cadence/pull/14",
      },
    };
  },
  planning_get: ({ repo }) => ({ repo, revision: planning.revision, planning, today: day(0) }),
  planning_save: ({ repo, planning: next, base_revision }) => {
    if (base_revision !== planning.revision)
      throw new Error("Le planning a été modifié par quelqu'un d'autre : rechargez-le.");
    planning = { ...(next as Planning), revision: planning.revision + 1 };
    return { repo, revision: planning.revision, planning };
  },
  list_designs: ({ repo }) => ({ repo, designs: repo === "RemiSDV/cadence" ? designs : [] }),
  get_design: ({ repo, id, file }) => {
    const d = designs.find((x) => x.id === id)!;
    if (d.status !== "imported")
      return {
        repo,
        design: d,
        files: [],
        branch: null,
        path: `design/${d.id}`,
        message: "Fichiers pas encore dans le dépôt : lancez « Importer ».",
      };
    const page = (file as string | undefined) ?? "index.html";
    return {
      repo,
      design: d,
      branch: d.ref,
      path: d.path,
      files: [
        { path: "index.html", size: 1200 },
        { path: "reglages.html", size: 900 },
        { path: "README.md", size: 300 },
      ],
      file: page,
      content: designPage(page === "index.html" ? "Liste de la maison" : "Réglages"),
    };
  },
  design_add: ({ repo, name, url }) => {
    const id = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    designs.push({ id, name: String(name), url: String(url), status: "pending", added_on: day(0) });
    return { repo, id, designs };
  },
  design_delete: ({ repo, id }) => {
    designs.splice(
      designs.findIndex((d) => d.id === id),
      1,
    );
    return { repo, designs };
  },
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
          // Échéance = dernier jour du sprint : le jour même pour un sprint d'un jour.
          due_on: day(Number(duration_days) - 1),
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
  project_set_duration: ({ repo, duration_days, apply }) => {
    const p = projects[repo as string]!;
    p.duration_days = Number(duration_days);
    p.next_capacity = Math.max(1, Math.round(p.points_per_day * p.duration_days));
    const cur = p.sprints[0];
    if (apply === "current" && cur) {
      p.capacity = p.next_capacity;
      cur.capacity = p.next_capacity;
      const due = new Date(`${cur.start_on}T12:00:00Z`);
      due.setUTCDate(due.getUTCDate() + p.duration_days - 1 + cur.paused_days);
      cur.due_on =
        due.toISOString().slice(0, 10) < day(0) ? day(0) : due.toISOString().slice(0, 10);
    }
    return { repo, project: p };
  },
  project_close_sprint: ({ repo, version: closing, to_backlog }) => {
    const p = projects[repo as string]!;
    const cur = p.sprints[0]!;
    if (closing && closing !== cur.version)
      throw new Error(`Le sprint en cours est ${cur.version} : rafraîchissez l'écran.`);
    // Comme le serveur : l'excédent choisi repart au carnet au lieu d'être reporté.
    const back = (to_backlog as number[] | undefined) ?? [];
    const scope = sprintIssues.reduce((sum, i) => sum + issueWeight(i), 0);
    for (const i of sprintIssues) if (back.includes(i.number)) i.milestone = null;
    const carried = sprintIssues
      .filter((i) => i.state === "open" && !back.includes(i.number))
      .map((i) => i.number);
    sprintIssues = sprintIssues.filter((i) => !back.includes(i.number));
    Object.assign(cur, {
      ended_on: day(0),
      done_points: sprintIssues
        .filter((i) => i.state === "closed")
        .reduce((sum, i) => sum + issueWeight(i), 0),
      scope_points: scope,
      milestone: SPRINT.number,
      release: {
        status: "pending",
        pull_request: 170,
        message: "PR #170 ouverte : aucune vérification encore, en attente de la CI.",
        no_ci: true,
      },
    });
    const next = "0.1.3";
    p.sprints.unshift({
      version: next,
      branch: `release/${next}`,
      start_on: day(0),
      due_on: day(p.duration_days - 1),
      paused_days: 0,
      capacity: p.next_capacity,
      filled: true,
      carried,
    });
    Object.assign(p, { current: next, release_branch: `release/${next}`, carried });
    return { repo, closed: closing, project: p };
  },
  project_ship_release: ({ repo, version }) => {
    const p = projects[repo as string]!;
    const s = p.sprints.find((x) => x.version === version && x.ended_on);
    if (!s) throw new Error(`Aucun sprint terminé ${String(version)} dans ${String(repo)}.`);
    s.release = { status: "merged", pull_request: s.release?.pull_request, tag: `v${s.version}` };
    return { repo, release: s.release, project: p };
  },
  sprint_backlog: ({ repo }) => ({
    repo,
    issues: [...issues, ...backlogExtra]
      .filter((i) => i.repo === repo && i.state === "open" && !i.milestone)
      .map((i) => ({
        ...i,
        jalon: i.number === 163 ? { id: "mvp-prive", name: "MVP privé" } : null,
        weight: issueWeight(i),
      }))
      .sort((a, b) => (a.jalon ? 0 : 1) - (b.jalon ? 0 : 1)),
  }),
  sprint_issues: ({ repo, add, remove }) => {
    const added: number[] = [];
    const removed: number[] = [];
    // Comme le serveur : une issue inconnue, fermée ou déjà à sa place est signalée, pas bloquante.
    const skipped: { issue: number; reason: string }[] = [];
    for (const n of (add as number[] | undefined) ?? []) {
      const i = [...issues, ...backlogExtra].find((x) => x.repo === repo && x.number === n);
      if (!i) skipped.push({ issue: n, reason: "issue introuvable" });
      else if (i.state !== "open") skipped.push({ issue: n, reason: "issue fermée" });
      else if (i.milestone === SPRINT.title)
        skipped.push({ issue: n, reason: "déjà dans le sprint" });
      else {
        i.milestone = SPRINT.title;
        if (!sprintIssues.includes(i)) sprintIssues.push(i);
        added.push(n);
      }
    }
    for (const n of (remove as number[] | undefined) ?? []) {
      const i = sprintIssues.find((x) => x.number === n);
      if (!i) {
        skipped.push({ issue: n, reason: "pas dans le sprint" });
        continue;
      }
      i.milestone = null;
      sprintIssues = sprintIssues.filter((x) => x !== i);
      removed.push(n);
    }
    return { repo, version: SPRINT.title, added, removed, skipped };
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

/** Conversations simulées du sprint 0.1.2 (masquées du chat global) et une conversation libre. */
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const sprintConversations: NonNullable<MockHostOptions["conversations"]>["conversations"] = [
  {
    title: "Développer le sprint 0.1.2",
    action: "developper-sprint",
    state: "idle",
    group: SPRINT_GROUP,
    context: { type: "sprint", repo: "RemiSDV/cadence" },
    createdAt: at(30),
    updatedAt: at(26),
    turns: 14,
  },
  {
    title: "Implémenter #156 — quota de l'API",
    action: "implementer-issue",
    mode: "background",
    state: "running",
    group: SPRINT_GROUP,
    context: { type: "issue", repo: "RemiSDV/cadence", issue: 156 },
    createdAt: at(2),
    updatedAt: at(0.2),
    turns: 3,
  },
  {
    title: "Relire et valider #149",
    action: "relire-valider",
    state: "waiting-approval",
    waiting: "reply",
    ai: "codex",
    model: "gpt-5-codex",
    group: SPRINT_GROUP,
    context: { type: "review", repo: "RemiSDV/cadence", items: [{ issue: 149, pr: 161 }] },
    createdAt: at(5),
    updatedAt: at(4),
    turns: 4,
  },
  {
    title: "Question sur les labels",
    state: "idle",
    createdAt: at(50),
    updatedAt: at(48),
    turns: 2,
  },
];

export const devHost: MockHostOptions = {
  plugin: { id: "gestion-projet", version: "0.3.0" },
  route: {
    view: params.get("view") ?? "issues",
    params: params.get("version")
      ? { repo: "RemiSDV/cadence", version: params.get("version")! }
      : params.get("number")
        ? { repo: "RemiSDV/cadence", number: params.get("number")! }
        : {},
  },
  // « Créer des issues depuis un document » : un fichier choisi.
  pickFiles: () => ["C:/Users/moi/Documents/cahier-des-charges.pdf"],
  settings: { tag_prefix: "v", sprint_length_days: 14, merge_method: "squash" },
  conversations: {
    modes: { "implementer-issue": "background", "preparer-release": "background" },
    conversations: sprintConversations,
  },
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
    get_issue: ({ repo, number }) => {
      const found = issues.find((i) => i.repo === repo && i.number === number);
      if (!found) throw new Error(`Issue #${String(number)} introuvable dans ${String(repo)}.`);
      return {
        ...found,
        created_at: "2026-10-10T09:00:00Z",
        body: [
          "## Contexte",
          "Quand le quota de l'API GitHub est épuisé, l'écran affiche une **erreur réseau** au lieu",
          "d'un message clair (voir `src/lib/github/errors.ts`).",
          "",
          "## Critères d'acceptation",
          "- [x] Détecter la réponse 403 `rate limit`",
          "- [ ] Afficher l'heure de remise à zéro",
          "- [ ] Tests unitaires",
          "",
          "Dépend de #149. [Doc GitHub](https://docs.github.com/rest/rate-limit)",
        ].join("\n"),
        comments: 1,
        comment_list: [
          {
            author: "marc",
            created_at: `${day(-1)}T10:00:00Z`,
            body: "Penser au mode **hors ligne** : `offline` ne doit pas masquer le quota.",
          },
        ],
      };
    },
    create_issue: ({ repo, title, type, points, priority, milestone }) => {
      const created = issue(String(repo), 170 + issues.length, String(title), {
        type: (type as Issue["type"]) ?? null,
        points: (points as number | undefined) ?? null,
        priority: (priority as number | undefined) ?? null,
        milestone: (milestone as string | undefined) ?? null,
        updated_at: new Date().toISOString(),
      });
      issues.unshift(created);
      return created;
    },
    get_account: () => ({ login: "RemiSDV", name: "Rémi Lhuillier", avatar_url: null, repos: [] }),
    list_account_repos: () => ({ repos: accountRepos.map((r) => ({ ...r, followed: false })) }),
    ...planningTools,
  },
};
