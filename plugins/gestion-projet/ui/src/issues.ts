/**
 * Issues côté écran : tri des listes (même rang que le serveur pour remplir les sprints), lien
 * issue ↔ PR et version d'une PR, formulaire « Nouvelle issue », contexte de « Créer des issues
 * depuis un document ». Fonctions pures, testées dans `issues.test.ts`.
 */
import type { Issue, IssueType, PullRequest } from "./domain";
import { isOpenPr } from "./planning";

/* ---------- Tri ---------- */

export type IssueSort = "priority" | "roadmap" | "number" | "updated";

export const issueSorts: { id: IssueSort; label: string; title: string }[] = [
  {
    id: "priority",
    label: "Priorité",
    title: "P0 (socle), puis P1 à P5, puis sans priorité ; à égalité, par numéro",
  },
  {
    id: "roadmap",
    label: "Roadmap",
    title: "Ordre des jalons de la Roadmap, puis priorité et numéro",
  },
  { id: "number", label: "Numéro", title: "Par numéro croissant" },
  { id: "updated", label: "Activité", title: "Dernière mise à jour d'abord" },
];

export function isIssueSort(value: unknown): value is IssueSort {
  return issueSorts.some((s) => s.id === value);
}

/** Tri des issues d'un jalon (Roadmap). */
export type JalonSort = "priority" | "number" | "sprint";

export const jalonSorts: { id: JalonSort; label: string }[] = [
  { id: "priority", label: "Priorité" },
  { id: "sprint", label: "Sprint" },
  { id: "number", label: "Numéro" },
];

/** Rang de priorité comme `projet::rank` du serveur : 0 (socle) → 5, sans priorité en dernier. */
export function priorityRank(priority: number | null | undefined): number {
  return priority === null || priority === undefined ? 6 : priority;
}

interface Sortable {
  number: number;
  priority: number | null;
  repo?: string;
  updated_at?: string | null;
}

const byNumber = (a: Sortable, b: Sortable) =>
  (a.repo ?? "").localeCompare(b.repo ?? "") || a.number - b.number;

const byPriority = (a: Sortable, b: Sortable) =>
  priorityRank(a.priority) - priorityRank(b.priority) || byNumber(a, b);

/**
 * Trie une copie de `list`. `roadmap` : position du jalon de l'issue (`jalonIndex`, `null` sans
 * jalon : après les autres), puis priorité et numéro ; sans `jalonIndex`, comme `priority`.
 */
export function sortIssues<T extends Sortable>(
  list: readonly T[],
  mode: IssueSort,
  jalonIndex?: (issue: T) => number | null,
): T[] {
  const out = [...list];
  switch (mode) {
    case "priority":
      return out.sort(byPriority);
    case "number":
      return out.sort(byNumber);
    case "updated":
      return out.sort(
        (a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || byNumber(a, b),
      );
    case "roadmap": {
      const at = (i: T) => jalonIndex?.(i) ?? Number.MAX_SAFE_INTEGER;
      return out.sort((a, b) => at(a) - at(b) || byPriority(a, b));
    }
  }
}

/** Issues d'un jalon : par priorité, par sprint (prévu, livré ; sans sprint en dernier) ou par numéro. */
export function sortJalonIssues<T extends Sortable & { sprint: string | null }>(
  list: readonly T[],
  mode: JalonSort,
  compareVersions: (a: string, b: string) => number,
): T[] {
  if (mode !== "sprint") return sortIssues(list, mode);
  return [...list].sort((a, b) => {
    if (a.sprint !== b.sprint) {
      if (a.sprint === null) return 1;
      if (b.sprint === null) return -1;
      const c = compareVersions(a.sprint, b.sprint);
      if (c !== 0) return c;
    }
    return byPriority(a, b);
  });
}

/* ---------- Pull requests ---------- */

/** Version d'une branche de release de sprint : `release/0.2.0` → `0.2.0`. */
export function releaseVersion(branch: string): string | null {
  const m = /^release\/(.+)$/.exec(branch.trim());
  return m ? m[1]! : null;
}

/** Version d'une PR : son milestone, sinon celle de sa branche cible `release/<version>`. */
export function prVersion(pr: Pick<PullRequest, "milestone" | "base">): string | null {
  return pr.milestone ?? releaseVersion(pr.base);
}

const prOrder: Record<PullRequest["state"], number> = { open: 0, draft: 0, merged: 1, closed: 2 };

/**
 * PR liées à une issue, d'après les champs du serveur : `issues` (« Closes #n », même vers une
 * branche `release/x`, liens manuels, plus l'issue que nomme la branche `feat/<n>-…`). Ouvertes
 * (brouillons compris) d'abord, puis fusionnées, puis fermées ; à état égal, celles qui déclarent
 * fermer l'issue (`closes`) avant celles liées par leur seule branche, puis la plus récente.
 * Source unique du lien : détail d'issue, PR d'une tâche « En revue ».
 */
export function pullsForIssue(
  pulls: readonly PullRequest[],
  issue: Pick<Issue, "repo" | "number">,
): PullRequest[] {
  const closing = (p: PullRequest) => (p.closes.includes(issue.number) ? 0 : 1);
  return pulls
    .filter((p) => p.repo === issue.repo && p.issues.includes(issue.number))
    .sort(
      (a, b) =>
        prOrder[a.state] - prOrder[b.state] ||
        closing(a) - closing(b) ||
        (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
    );
}

/** PR ouverte (brouillon compris) de l'issue : la première de `pullsForIssue`, `null` sans. */
export function pullRequestFor(
  pulls: readonly PullRequest[],
  issue: Pick<Issue, "repo" | "number">,
): PullRequest | null {
  return pullsForIssue(pulls, issue).find(isOpenPr) ?? null;
}

/**
 * Issues d'une PR à afficher : celles qu'elle déclare fermer (`closes`), puis celles liées par la
 * seule branche (`issues` moins `closes`).
 */
export function prIssueLinks(pr: Pick<PullRequest, "closes" | "issues">): {
  closes: number[];
  branch: number[];
} {
  return { closes: pr.closes, branch: pr.issues.filter((n) => !pr.closes.includes(n)) };
}

/* ---------- Détail d'une issue (`get_issue`) ---------- */

export interface IssueComment {
  author: string | null;
  created_at: string | null;
  body: string;
}

export interface IssueDetail extends Issue {
  created_at?: string | null;
  /** Absent quand l'issue n'a pas de commentaire. */
  comment_list?: IssueComment[];
}

/** Paramètres de route de la vue `issue` : `{ repo, number }`, et la vue d'où l'on vient. */
export function issueRoute(
  issue: Pick<Issue, "repo" | "number">,
  from?: string,
): Record<string, string> {
  return { repo: issue.repo, number: String(issue.number), ...(from ? { from } : {}) };
}

/** Lit `{ repo, number }` d'une route ; `null` si l'un manque ou est invalide. */
export function parseIssueRoute(
  params: Record<string, string>,
): { repo: string; number: number; from: string | null } | null {
  const repo = params.repo?.trim() ?? "";
  const number = Number(params.number);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo, number, from: params.from?.trim() || null };
}

/* ---------- Nouvelle issue (`create_issue`) ---------- */

export const issueTypes: IssueType[] = ["feat", "fix", "chore", "perf", "docs"];

/** Story points acceptés par le serveur (suite de Fibonacci). */
export const storyPoints = [1, 2, 3, 5, 8, 13] as const;

export interface IssueForm {
  repo: string;
  title: string;
  body: string;
  type: IssueType | "";
  /** Story points ; `null` : non estimée. */
  points: number | null;
  /** 0 (socle) à 5 ; `null` : sans priorité. */
  priority: number | null;
  /** Titre du milestone ; vide : sans version. */
  milestone: string;
}

/** Arguments de `create_issue`, ou le message d'erreur à afficher. */
export function createIssueArgs(
  form: IssueForm,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const title = form.title.trim();
  if (!form.repo) return { ok: false, error: "Choisissez le dépôt de l'issue." };
  if (!title) return { ok: false, error: "Une issue doit avoir un titre." };
  if (form.points !== null && !(storyPoints as readonly number[]).includes(form.points))
    return { ok: false, error: "Story points : 1, 2, 3, 5, 8 ou 13." };
  if (
    form.priority !== null &&
    (!Number.isInteger(form.priority) || form.priority < 0 || form.priority > 5)
  )
    return { ok: false, error: "Priorité : 0 (socle) à 5." };
  const args: Record<string, unknown> = { repo: form.repo, title };
  if (form.body.trim()) args.body = form.body.trim();
  if (form.type) args.type = form.type;
  if (form.points !== null) args.points = form.points;
  if (form.priority !== null) args.priority = form.priority;
  if (form.milestone.trim()) args.milestone = form.milestone.trim();
  return { ok: true, args };
}

/* ---------- « Créer des issues depuis un document » ---------- */

/** Le document fourni à l'action `extraire-issues` : texte collé et/ou fichiers choisis. */
export interface DocumentSource {
  text?: string;
  /** Chemins absolus choisis avec `cadence.pickFiles`. */
  files?: string[];
}

/**
 * Contexte de l'action `extraire-issues` (`context = "document"` dans le manifeste) ; `null` sans
 * document : l'action ne doit pas être lancée pour rien.
 */
export function documentContext(
  repo: string,
  source: DocumentSource,
  extra: { design?: string } = {},
): { type: "document"; repo: string; document: DocumentSource; design?: string } | null {
  const text = source.text?.trim() ?? "";
  const files = (source.files ?? []).filter((f) => f.trim() !== "");
  if (!text && files.length === 0 && !extra.design) return null;
  const document: DocumentSource = {};
  if (text) document.text = text;
  if (files.length) document.files = files;
  return {
    type: "document",
    repo,
    document,
    ...(extra.design ? { design: extra.design } : {}),
  };
}

/** Nom affiché d'un fichier choisi (dernier segment du chemin, Windows compris). */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
