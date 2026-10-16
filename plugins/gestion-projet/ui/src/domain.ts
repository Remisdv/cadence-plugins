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
  estimate: string | null;
  labels: string[];
  milestone: string | null;
  assignees: string[];
  author: string | null;
  comments: number;
  url: string;
  updated_at: string | null;
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
export function issueContext(issue: Pick<Issue, "repo" | "number">): { repo: string; issue: number } {
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

/** Labels affichés à côté du titre : ni type, ni état, ni estimation (montrés à part). */
export function displayLabels(labels: string[]): string[] {
  return labels.filter((l) => !/^(type|status|estimate)\//.test(l));
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
