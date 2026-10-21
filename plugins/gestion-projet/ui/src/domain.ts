/** Données rendues par le serveur `cadence-gestion-projet` et leur vocabulaire d'affichage. */
import type { ActionGroup, ConversationInfo, ConversationState } from "@cadence/plugin-sdk";
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
  /** Numéro du milestone quand c'est un sprint (milestone daté) : clé du groupe de conversations. */
  sprint?: number | null;
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

/**
 * Contexte des actions liées à une issue. Cadence exige `type` égal au type de contexte déclaré
 * par l'action dans le manifeste (`context = "issue"`).
 */
export function issueContext(issue: Pick<Issue, "repo" | "number">): {
  type: "issue";
  repo: string;
  issue: number;
} {
  return { type: "issue", repo: issue.repo, issue: issue.number };
}

/* ---------- Conversations du sprint et revue groupée ---------- */

/**
 * Groupe des conversations d'un sprint (champ réservé `group` du contexte d'action) : Cadence les
 * masque du chat global, l'écran « Sprint en cours » les liste. La clé est le numéro du
 * milestone, stable même si la version est renommée ; le libellé reprend le titre du sprint.
 */
export function sprintGroup(repo: string, sprint: { number: number; title: string }): ActionGroup {
  return { id: `sprint:${repo}:${sprint.number}`, label: `Sprint ${sprint.title} · ${repo}` };
}

/** Groupe d'une issue rattachée à un sprint ; `null` sans sprint (conversation normale). */
export function issueGroup(
  issue: Pick<Issue, "repo" | "sprint" | "milestone">,
): ActionGroup | null {
  if (issue.sprint === null || issue.sprint === undefined || !issue.milestone) return null;
  return sprintGroup(issue.repo, { number: issue.sprint, title: issue.milestone });
}

/** `{ group }` à étaler dans un contexte d'action, ou rien. */
export function withGroup(group: ActionGroup | null | undefined): { group?: ActionGroup } {
  return group ? { group } : {};
}

/** Tâche à relire : l'issue et sa PR (`null` si l'écran ne l'a pas trouvée, le skill la cherche). */
export interface ReviewItem {
  issue: number;
  pr: number | null;
}

/** Contexte de l'action `relire-valider` (`context = "review"` dans le manifeste). */
export function reviewContext(
  repo: string,
  items: ReviewItem[],
  group?: ActionGroup | null,
): { type: "review"; repo: string; items: ReviewItem[]; group?: ActionGroup } {
  return { type: "review", repo, items, ...withGroup(group) };
}

/* ---------- Contextes des actions lancées depuis les vues ---------- */

/*
 * Toute action déclare un `context` dans le manifeste : Cadence ne montre dans la barre du plugin
 * que les actions sans contexte, qui partiraient d'un clic, sans dépôt ni choix. Chacune part donc
 * de sa vue avec le contexte ci-dessous (`type` = le `context` déclaré, exigé par Cadence) ;
 * « Développer le sprint » (`context = "sprint"`) part de l'écran Sprint, `{ type, repo, group? }`.
 */

/** `relire-pr` (`context = "pulls"`) : les PR choisies, jamais « toutes » implicitement. */
export function pullsContext(
  repo: string,
  pulls: readonly number[],
): { type: "pulls"; repo: string; pulls: number[] } {
  return { type: "pulls", repo, pulls: [...new Set(pulls)].sort((a, b) => a - b) };
}

/** `adapter-architecture` (`context = "architecture"`) : tout le dépôt, ou un service. */
export function architectureContext(
  repo: string,
  service?: string | null,
): { type: "architecture"; repo: string; service?: string } {
  return { type: "architecture", repo, ...(service ? { service } : {}) };
}

/** `planifier` (`context = "planning"`). */
export function planningContext(repo: string): { type: "planning"; repo: string } {
  return { type: "planning", repo };
}

/**
 * `creer-design` (`context = "demande-design"`) : la demande écrite dans la boîte, et le design
 * à modifier s'il y en a un. `null` sans demande : rien n'est lancé.
 */
export function designRequestContext(
  repo: string,
  request: string,
  design?: string | null,
): { type: "demande-design"; repo: string; request: string; design?: string } | null {
  const text = request.trim();
  if (!text) return null;
  return { type: "demande-design", repo, request: text, ...(design ? { design } : {}) };
}

export const conversationStates: Record<
  ConversationState,
  { label: string; dot: DotTone; tone: BadgeTone }
> = {
  running: { label: "En cours", dot: "clay", tone: "clay" },
  "waiting-approval": { label: "Attend votre accord", dot: "amber", tone: "amber" },
  idle: { label: "Terminée", dot: "green", tone: "green" },
  failed: { label: "Échec", dot: "red", tone: "red" },
  interrupted: { label: "Interrompue", dot: "neutral", tone: "muted" },
};

const aiNames: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** « Claude Code », « Codex », « OpenCode » ; un identifiant inconnu est rendu tel quel. */
export function aiLabel(ai: string): string {
  return aiNames[ai] ?? ai;
}

/** Libellés des actions qui ouvrent une conversation de sprint. */
const actionLabels: Record<string, string> = {
  "developper-sprint": "Développer le sprint",
  "implementer-issue": "Implémenter",
  "relire-valider": "Relire et valider",
};

export function actionLabel(action: string | undefined): string | null {
  return action ? (actionLabels[action] ?? action) : null;
}

/** Issues concernées par une conversation, lues dans le contexte de son action. */
export function conversationIssues(c: Pick<ConversationInfo, "context">): number[] {
  const ctx = c.context ?? {};
  const out: number[] = [];
  const add = (n: unknown) => {
    if (typeof n === "number" && Number.isInteger(n) && !out.includes(n)) out.push(n);
  };
  add(ctx.issue);
  if (Array.isArray(ctx.issues)) ctx.issues.forEach(add);
  if (Array.isArray(ctx.items)) {
    for (const item of ctx.items) add((item as { issue?: unknown } | null)?.issue);
  }
  return out;
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

/** Vues du plugin : celles de la barre du plugin (plugin.toml) et les routes ouvertes par lien. */
export interface ViewMeta {
  title: string;
  icon: IconName;
}

export const views = {
  sprint: { title: "Sprint en cours", icon: "sprint" },
  issues: { title: "Issues", icon: "issue" },
  /** Détail d'une issue (`{ repo, number }`), hors de la barre du plugin. */
  issue: { title: "Issue", icon: "issue" },
  roadmap: { title: "Roadmap", icon: "roadmap" },
  versions: { title: "Versions", icon: "tag" },
  planning: { title: "Planning", icon: "calendar" },
  architecture: { title: "Architecture", icon: "folder" },
  designs: { title: "Designs", icon: "layers" },
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
  /** Issues de la portée et issues fermées (compteurs seulement). */
  total: number;
  closed: number;
  /** Avancement en story points (`points_done` sur `points_total`), 0 → 100. */
  progress: number;
  /** Issues par état. */
  counts: Record<IssueStatus, number>;
  /** Story points par état. */
  points_by_status?: Record<IssueStatus, number>;
  /** Portée en story points (une issue sans estimation compte 3 SP), et SP fermés. */
  points_total: number;
  points_done: number;
  /** Story points encore ouverts. */
  points_remaining?: number;
  /** Issues sans story points (comptées 3 SP chacune). */
  unestimated: number;
  /** Story points fermés par jour écoulé. */
  velocity: number;
  /** Retard (positif) ou avance (négatif) sur la droite idéale des SP, en jours. */
  delay_days: number;
  /** Story points restants, jour par jour. */
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
  /** Portée (story points de toutes ses issues) relevée à la clôture. */
  scope_points?: number | null;
  /** Numéro du milestone du sprint (groupe de ses conversations), s'il est connu. */
  milestone?: number | null;
  ended_on?: string | null;
  /** Fusion de la branche de release dans la branche par défaut, à la fin du sprint. */
  release?: {
    status: ReleaseStatus;
    pull_request?: number;
    tag?: string;
    message?: string;
    /** Aucune vérification sur la PR de release : « Fusionner maintenant » est proposé. */
    no_ci?: boolean;
  } | null;
}

/** Sprints automatiques d'un dépôt (`sprint_summary.project`, `project_*`). */
export interface ProjectView {
  /** Issue d'état partagée par l'équipe. */
  issue: number;
  url: string;
  /** `idle` : issue d'état créée par les jalons de la roadmap, sprints pas encore démarrés. */
  status: "idle" | "running" | "paused";
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

/**
 * Sprints automatiques démarrés : une issue d'état « idle » (jalons de la roadmap seulement) ne
 * l'est pas, l'écran Sprint doit encore proposer « Démarrer le projet ».
 */
export function isStarted(project: ProjectView | null | undefined): project is ProjectView {
  return !!project && project.status !== "idle" && project.sprints.length > 0;
}

/* ---------- Roadmap par jalons (`roadmap`) ---------- */

/** Colonne de la roadmap : sprint terminé, en cours ou prévu au rythme moyen. */
export interface RoadmapSprint {
  version: string;
  start_on: string;
  due_on: string;
  state: "done" | "current" | "planned";
  /** Story points livrés (terminé) ou prévus. */
  points: number;
}

export interface JalonIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  status: IssueStatus;
  points: number | null;
  priority: number | null;
  /** Sprint qui l'a livrée, la porte ou devrait la prendre. */
  sprint: string | null;
}

export type JalonStatus = "empty" | "planned" | "in_progress" | "done";

/** Jalon : objectif nommé, réalisé en un ou plusieurs sprints (affichage seulement). */
export interface JalonView {
  id: string;
  name: string;
  description: string;
  status: JalonStatus;
  issues: JalonIssue[];
  total: number;
  closed: number;
  points_total: number;
  points_done: number;
  /** Issues ouvertes sans story points (comptées 3 SP). */
  unestimated: number;
  /** Issues ouvertes qu'aucun sprint prévu ne prend (dépendance hors plan, sprints pas démarrés). */
  unplanned: number;
  /** Versions des sprints concernés, dans l'ordre. */
  sprints: string[];
  start_on: string | null;
  /** Fin estimée au rythme moyen (ou date de fin réelle d'un jalon terminé). */
  end_on: string | null;
  /** Au plus tôt (meilleur rythme récent) et au plus tard (moins bon). */
  end_early: string | null;
  end_late: string | null;
}

/** Réponse de `roadmap`. */
export interface RoadmapPlan {
  repo: string;
  today: string;
  /** Sprints automatiques démarrés (sinon : pas de dates). */
  started: boolean;
  issue?: number;
  url?: string;
  duration_days?: number;
  /** Rythmes en SP par jour : bas, moyen, haut. */
  rates?: { low: number; avg: number; high: number };
  sprints: RoadmapSprint[];
  jalons: JalonView[];
  /** Issues ouvertes sans jalon. */
  unassigned: {
    number: number;
    title: string;
    points: number | null;
    priority: number | null;
    milestone: string | null;
  }[];
  /** Fin de tout le travail ouvert. */
  end: { on: string | null; early: string | null; late: string | null; unplanned: number } | null;
}

/* ---------- Designs (Claude Design) ---------- */

/** Design du projet (`list_designs`) : lien claude.ai et, une fois importé, ses fichiers. */
export interface Design {
  id: string;
  name: string;
  url: string;
  status: "pending" | "imported";
  description?: string;
  /** Dossier des fichiers dans le dépôt (`design/<id>`). */
  path?: string;
  /** Branche d'import (`design/<id>`), avant fusion. */
  ref?: string;
  entry?: string;
  added_on: string;
  imported_on?: string;
}

export interface DesignList {
  repo: string;
  designs: Design[];
}

/** `get_design` : fichiers du design et contenu d'une page. */
export interface DesignDetail {
  repo: string;
  design: Design;
  branch: string | null;
  path: string;
  files: { path: string; size: number }[];
  file?: string | null;
  content?: string;
  message?: string;
}

/* ---------- Architecture ---------- */

export interface ArchiLayer {
  id: string;
  name: string;
  /** Emplacement du code de la couche. */
  path: string;
  role: string;
  /** Couches qu'elle peut utiliser (identifiants). */
  uses: string[];
}

export interface ArchiService {
  id: string;
  name: string;
  /** proxy, frontend, backend, worker, database, cache, queue, external, autre. */
  kind: string;
  tech: string;
  path: string;
  description: string;
  template?: string | null;
  layers: ArchiLayer[];
  rules: string[];
  conventions: string[];
}

export interface ArchiLink {
  from: string;
  to: string;
  label: string;
}

export interface Architecture {
  version: number;
  services: ArchiService[];
  links: ArchiLink[];
  rules: string[];
}

export interface ArchitectureSource {
  branch: string;
  pull_request: number | null;
  url: string | null;
}

/** `architecture_get` : `architecture` nulle tant que le dépôt n'en a pas. */
export interface ArchitectureResponse {
  repo: string;
  architecture: Architecture | null;
  source: ArchitectureSource;
  markdown?: string | null;
}

/** Modèle prêt : système complet ou intérieur d'un service. */
export interface ArchiTemplate {
  id: string;
  name: string;
  scope: "system" | "service";
  description: string;
  kind: string;
  tech: string;
  layers: ArchiLayer[];
  rules: string[];
  conventions: string[];
  services: ArchiService[];
  links: ArchiLink[];
}

/* ---------- Planning (Gantt) ---------- */

export interface PlanningPerson {
  id: string;
  name: string;
}

export interface PlanningTask {
  id: string;
  name: string;
  phase: string;
  start: string;
  /** Dernier jour, inclus. */
  end: string;
  people: string[];
  depends: string[];
  progress: number;
  milestone: boolean;
  issue?: number | null;
  notes?: string;
}

export interface Planning {
  revision: number;
  people: PlanningPerson[];
  phases: string[];
  tasks: PlanningTask[];
}

/** `planning_get` / `planning_save`. */
export interface PlanningResponse {
  repo: string;
  revision: number;
  planning: Planning;
  url?: string | null;
  today?: string;
}

/** Issue du carnet (`sprint_backlog`) : sans version, dans l'ordre de remplissage des sprints. */
export interface BacklogIssue extends Issue {
  /** Jalon de la roadmap qui la porte (son rang ordonne le carnet). */
  jalon: { id: string; name: string } | null;
  /** Poids dans la capacité : story points, 3 sans estimation. */
  weight: number;
}

export interface BacklogList {
  repo: string;
  issues: BacklogIssue[];
}

/** Réponse de `sprint_issues` (ajout / retrait d'issues du sprint en cours). */
export interface SprintIssuesResult {
  repo: string;
  version: string;
  added: number[];
  removed: number[];
  skipped: { issue: number; reason: string }[];
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
  /** Sprints automatiques démarrés (`project` renseigné). */
  started?: boolean;
  /** Sprints automatiques ; `null` tant que le projet n'est pas démarré. */
  project?: ProjectView | null;
  project_error?: string;
  /** Tant que le projet n'est pas démarré : valeurs proposées par « Démarrer le projet ». */
  start_defaults?: StartDefaults;
  /** Issue d'état déjà créée par les jalons (reprise au démarrage). */
  state_issue?: { number: number; url: string };
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
  /** Issues que la PR déclare fermer (« Closes #n », même vers `release/x`, liens manuels). */
  closes: number[];
  /** Issues liées : `closes` plus l'issue de la branche (`feat/42-…`). Source du lien PR ↔ issue
   * (`pullsForIssue` dans `issues.ts`). */
  issues: number[];
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
