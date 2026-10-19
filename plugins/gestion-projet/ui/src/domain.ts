/** Données rendues par le serveur `cadence-gestion-projet` et leur vocabulaire d'affichage. */
import type { BadgeTone, DotTone, IconName } from "@cadence/ui";

export type IssueType = "feat" | "fix" | "chore" | "perf" | "docs";
export type IssueStatus = "todo" | "doing" | "review" | "done";

/** Issue telle que rendue par `list_issues` / `get_issue`. */
export interface Issue {
  /** Dépôt `owner/name` (renseigné aussi dans les listes agrégées sur tous les dépôts). */
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  status: IssueStatus;
  type: IssueType | null;
  /** Ancienne estimation en tailles (`estimate/S|M|L|XL`), lue seulement. */
  estimate: string | null;
  /** Story points (`sp/<n>`, suite de Fibonacci). */
  points: number | null;
  /** Priorité (`priority/<n>`) : 0 = socle, puis 1 (la plus urgente) à 5. */
  priority: number | null;
  labels: string[];
  milestone: string | null;
  assignees: string[];
  author: string | null;
  comments: number;
  url: string;
  updated_at: string | null;
  closed_at?: string | null;
  body?: string;
}

/** Réponse de `list_issues` : un dépôt (`repo`) ou tous les dépôts suivis (`repo: null`). */
export interface IssueList {
  repo: string | null;
  repos: string[];
  issues: Issue[];
  page: number;
  has_more: boolean;
  /** Dépôts illisibles dans une liste agrégée (les autres sont rendus). */
  errors?: { repo: string; message: string }[];
}

/** Compte GitHub connecté dans Cadence (`get_account`, réservé à l'UI). */
export interface Account {
  login: string;
  name: string | null;
  avatar_url: string | null;
  repos: string[];
}

/** Dépôt accessible au compte (`list_account_repos`, réservé à l'UI). */
export interface AccountRepo {
  full_name: string;
  private: boolean;
  description: string | null;
  updated_at: string | null;
  followed: boolean;
}

/** Clé unique d'une issue, même quand plusieurs dépôts sont affichés. */
export function issueKey(issue: Pick<Issue, "repo" | "number">): string {
  return `${issue.repo}#${issue.number}`;
}

/** Contexte des actions liées à une issue : le dépôt de l'issue et son numéro. */
export function issueContext(issue: Pick<Issue, "repo" | "number">): {
  repo: string;
  issue: number;
} {
  return { repo: issue.repo, issue: issue.number };
}

/** Nom court d'un dépôt (`owner/name` → `name`) pour la colonne dépôt. */
export function repoShortName(fullName: string): string {
  return fullName.split("/")[1] ?? fullName;
}

/** Mêmes tons que l'app (src/lib/domain/issues.ts de Cadence). */
export const issueTypeTone: Record<IssueType, BadgeTone> = {
  feat: "blue",
  fix: "amber",
  perf: "purple",
  chore: "neutral",
  docs: "muted",
};

export const issueStatuses: Record<IssueStatus, { label: string; dot: DotTone }> = {
  todo: { label: "À faire", dot: "neutral" },
  doing: { label: "En cours", dot: "clay" },
  review: { label: "En revue", dot: "blue" },
  done: { label: "Fait", dot: "green" },
};

export const statusOrder: IssueStatus[] = ["todo", "doing", "review", "done"];

/** Labels affichés à côté du titre : ni type, ni état, ni estimation, ni priorité (montrés à part). */
export function displayLabels(labels: string[]): string[] {
  return labels.filter((l) => !/^(type|status|estimate|sp|priority)\//.test(l));
}

/** Priorité d'une issue : 0 = socle, 1 la plus urgente → 5 la moins urgente. */
export function priorityInfo(priority: number): { label: string; title: string; tone: BadgeTone } {
  if (priority === 0)
    return {
      label: "P0 · socle",
      title: "Socle : à faire avant tout, d'autres issues en dépendent",
      tone: "purple",
    };
  const tone: BadgeTone = priority === 1 ? "red" : priority === 2 ? "amber" : "muted";
  return { label: `P${priority}`, title: `Priorité ${priority} sur 5 (1 = la plus urgente)`, tone };
}

/** Estimation affichée : story points, sinon l'ancienne taille. */
export function estimateLabel(issue: Pick<Issue, "points" | "estimate">): string | null {
  if (issue.points !== null && issue.points !== undefined) return `${issue.points} SP`;
  return issue.estimate;
}

/** Vues du plugin : celles de la barre du plugin (plugin.toml) et l'étape de setup. */
export interface ViewMeta {
  title: string;
  icon: IconName;
}

export const views = {
  sprint: { title: "Sprint en cours", icon: "sprint" },
  issues: { title: "Issues", icon: "issue" },
  roadmap: { title: "Roadmap", icon: "roadmap" },
  versions: { title: "Versions", icon: "tag" },
  "pull-requests": { title: "Pull requests", icon: "pullRequest" },
  "setup-depots": { title: "Dépôts suivis", icon: "github" },
} satisfies Record<string, ViewMeta>;

export type ViewId = keyof typeof views;

export function isViewId(value: string): value is ViewId {
  return value in views;
}

/* ---------- Versions, sprint, pull requests, releases (réponses du serveur) ---------- */

/** Version (milestone) telle que rendue par `list_milestones`, `create_milestone`, `sprint_summary`. */
export interface Version {
  title: string;
  number: number;
  /** `sprint` : milestone daté ; `palier` : sans date. */
  kind: "sprint" | "palier";
  state: "open" | "closed";
  due_on: string | null;
  /** Premier titre `# Nom` de la description. */
  name: string | null;
  /** Éléments de liste de la description (thèmes d'un palier). */
  themes: string[];
  description: string | null;
  open_issues: number;
  closed_issues: number;
  closed_at?: string | null;
  url: string;
}

export interface VersionList {
  repo: string;
  versions: Version[];
}

export interface BurndownPoint {
  date: string;
  remaining: number;
}

/** Rythme d'une version (`sprint_summary.pace`). */
export interface Pace {
  start_on: string | null;
  due_on: string | null;
  days_left: number | null;
  length_days: number | null;
  total: number;
  closed: number;
  /** 0 → 100 */
  progress: number;
  counts: Record<IssueStatus, number>;
  /** Story points des issues estimées, et des issues fermées. */
  points_total: number;
  points_done: number;
  /** Issues sans story points. */
  unestimated: number;
  velocity: number;
  /** Retard (positif) ou avance (négatif) sur la droite idéale, en jours. */
  delay_days: number;
  burndown: BurndownPoint[];
}

export type ReleaseStatus = "pending" | "merged" | "empty" | "blocked";

/** Sprint automatique (issue d'état `cadence/sprints`). */
export interface SprintRecord {
  version: string;
  /** Branche de release : `release/<version>`. */
  branch: string;
  start_on: string;
  due_on: string;
  paused_days: number;
  /** Capacité visée, en story points. */
  capacity: number;
  filled: boolean;
  /** Issues reportées depuis le sprint précédent. */
  carried?: number[];
  done_points?: number | null;
  ended_on?: string | null;
  /** Fusion de la branche de release dans la branche par défaut, à la fin du sprint. */
  release?: {
    status: ReleaseStatus;
    pull_request?: number;
    tag?: string;
    message?: string;
  } | null;
}

/** Sprints automatiques d'un dépôt (`sprint_summary.project`, `project_*`). */
export interface ProjectView {
  /** Issue d'état partagée par l'équipe. */
  issue: number;
  url: string;
  status: "running" | "paused";
  paused_since: string | null;
  duration_days: number;
  /** Rythme : story points fermés par jour. */
  points_per_day: number;
  capacity: number | null;
  next_capacity: number;
  current: string | null;
  release_branch: string | null;
  carried: number[];
  /** Du plus récent au plus ancien (six au plus). */
  sprints: SprintRecord[];
}

/** Valeurs proposées par « Démarrer le projet ». */
export interface StartDefaults {
  duration_days: number;
  capacity: number;
  first_version: string;
}

/** Réponse de `sprint_summary` : `sprint` absent quand aucun milestone daté n'est ouvert. */
export interface SprintSummary {
  repo: string;
  today: string;
  sprint_length_days: number;
  sprint: Version | null;
  pace?: Pace;
  issues?: Issue[];
  message?: string;
  /** Sprints automatiques ; `null` tant que le projet n'est pas démarré. */
  project?: ProjectView | null;
  project_error?: string;
  start_defaults?: StartDefaults;
}

export type PrState = "draft" | "open" | "merged" | "closed";
export type CiState = "none" | "pending" | "success" | "failure";
export type ReviewState = "approved" | "changes_requested" | "pending";

/** Pull request telle que rendue par `list_pull_requests` / `get_pull_request`. */
export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  state: PrState;
  head: string;
  base: string;
  author: string | null;
  url: string;
  milestone: string | null;
  labels: string[];
  closes: number[];
  ci: { state: CiState; passed: number; total: number };
  review: ReviewState | null;
  approvals: number;
  changes_requested: number;
  reviewers: string[];
  review_requested_at: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  comments: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface PullRequestList {
  repo: string | null;
  repos: string[];
  pull_requests: PullRequest[];
  errors?: { repo: string; message: string }[];
}

export interface PullRequestDetail extends PullRequest {
  body: string;
  mergeable: "mergeable" | "conflicting" | "unknown" | null;
  reviews: {
    author: string | null;
    state: string;
    submitted_at: string | null;
    body: string | null;
  }[];
  checks: {
    name: string;
    state: "success" | "failure" | "pending" | "skipped";
    url: string | null;
  }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
}

export interface Release {
  tag: string;
  version: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  url: string;
  created_at: string | null;
  published_at: string | null;
  author: string | null;
}

export interface ReleaseList {
  repo: string;
  tag_prefix: string;
  releases: Release[];
}
