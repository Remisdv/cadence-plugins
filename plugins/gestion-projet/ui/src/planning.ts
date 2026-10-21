/**
 * Logique d'affichage du sprint, de la roadmap, des versions et des pull requests, reprise de
 * Cadence 1 (src/lib/domain/{sprint,roadmap,versions,prs,format}.ts). Fonctions pures, testées.
 */
import type { BadgeTone, DotTone, IconName, ProgressTone } from "@cadence/ui";
import {
  issueStatuses,
  statusOrder,
  type CiState,
  type Issue,
  type IssueStatus,
  type IssueType,
  type PrState,
  type PullRequest,
  type JalonStatus,
  type JalonView,
  type RoadmapSprint,
  type SprintRecord,
  type Version,
} from "./domain";

/* ---------- Formats ---------- */

const dayMonth = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const decimal = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

/* ---------- Roadmap par jalons ---------- */

const dayMonthYear = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** « 16 nov. », avec l'année si elle diffère de celle de `today` (« 25 janv. 2027 »). */
export function formatDate(iso: string, today: string): string {
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return iso.slice(0, 4) === today.slice(0, 4) ? dayMonth.format(date) : dayMonthYear.format(date);
}

/** Fin estimée : « 16 nov. », et la fourchette si elle n'est pas réduite à ce jour-là. */
export function estimateRange(
  on: string | null,
  early: string | null,
  late: string | null,
  today: string,
): { date: string | null; range: string | null } {
  if (!on) return { date: null, range: null };
  const date = formatDate(on, today);
  if (!early || !late || (early === on && late === on)) return { date, range: null };
  return { date, range: `entre le ${formatDate(early, today)} et le ${formatDate(late, today)}` };
}

export const jalonStatusMeta: Record<
  JalonStatus,
  { label: string; tone: BadgeTone; bar: string; progress: ProgressTone }
> = {
  done: {
    label: "Atteint",
    tone: "green",
    bar: "bg-green-d border-green-line text-green",
    progress: "green",
  },
  in_progress: {
    label: "En cours",
    tone: "clay",
    bar: "bg-clay-d border-clay-line text-clay",
    progress: "clay",
  },
  planned: {
    label: "Prévu",
    tone: "blue",
    bar: "bg-blue-d border-blue-line text-blue",
    progress: "blue",
  },
  empty: {
    label: "Sans issue",
    tone: "neutral",
    bar: "bg-p3 border-line text-tx3",
    progress: "neutral",
  },
};

/** Colonnes (indices de sprints) couvertes par un jalon dans la frise ; `null` sans sprint. */
export function jalonSpan(
  jalon: Pick<JalonView, "sprints">,
  sprints: Pick<RoadmapSprint, "version">[],
): { from: number; to: number } | null {
  const idx = jalon.sprints
    .map((v) => sprints.findIndex((s) => s.version === v))
    .filter((i) => i >= 0);
  if (idx.length === 0) return null;
  return { from: Math.min(...idx), to: Math.max(...idx) };
}

/** Durées de sprint proposées, en jours : sprints courts (dès un jour), puis semaines entières. */
export const sprintDurations = [1, 2, 3, 4, 5, 7, 10, 14, 21, 28];

/** `14` → « 2 semaines », `10` → « 10 jours », `1` → « 1 jour ». */
export function durationLabel(days: number): string {
  return days % 7 === 0 ? plural(days / 7, "semaine") : plural(days, "jour");
}

/** Durées du sélecteur : les durées proposées, plus la durée actuelle si elle est différente. */
export function durationOptions(current: number): number[] {
  return [...new Set([...sprintDurations, current])].sort((a, b) => a - b);
}

/** Poids d'une issue sans story points, dans la capacité et l'avancement (comme le serveur). */
export const DEFAULT_POINTS = 3;

/** Story points d'une issue : `sp/<n>`, 3 sans estimation. */
export function issueWeight(issue: Pick<Issue, "points">): number {
  return issue.points ?? DEFAULT_POINTS;
}

/** Capacité d'un sprint (règle du serveur) : rythme × jours, arrondie, jamais sous 1 SP. */
export function capacityFor(pointsPerDay: number, days: number): number {
  return Math.max(1, Math.round(pointsPerDay * days));
}

/**
 * Échéance (dernier jour inclus) d'un sprint de `days` jours commencé le `start`, pauses comprises,
 * jamais avant `today` — même règle que le serveur (`projet::due_for`).
 */
export function dueFor(start: string, days: number, pausedDays: number, today: string): string {
  const d = new Date(`${start.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(1, days) - 1 + pausedDays);
  const due = d.toISOString().slice(0, 10);
  return due < today.slice(0, 10) ? today.slice(0, 10) : due;
}

/** Libellé et ton de la livraison d'un sprint terminé. */
export function releaseInfo(release: SprintRecord["release"]): {
  label: string;
  tone: "green" | "amber" | "red" | "muted";
  detail: string | null;
} {
  switch (release?.status) {
    case "merged":
      return {
        label: release.tag ? `${release.tag} publiée` : "Fusionnée",
        tone: "green",
        detail: null,
      };
    case "blocked":
      return { label: "Livraison bloquée", tone: "red", detail: release.message ?? null };
    case "empty":
      return { label: "Rien à livrer", tone: "muted", detail: release.message ?? null };
    case "pending":
      return { label: "Fusion en attente", tone: "amber", detail: release.message ?? null };
    default:
      return { label: "En cours", tone: "muted", detail: null };
  }
}

/** « 9 sept. » (jour civil, sans décalage horaire). */
export function formatDay(iso: string): string {
  return dayMonth.format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
}

/** « 9 sept. → 23 sept. » */
export function formatRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return start ? formatDay(start) : end ? formatDay(end) : "";
  return `${formatDay(start)} → ${formatDay(end)}`;
}

/** « 2,4 » */
export function formatDecimal(n: number): string {
  return decimal.format(n);
}

/** « 61 % » */
export function formatPercent(n: number): string {
  return `${Math.round(n)} %`;
}

/** « il y a 3 h », « il y a 2 j », « à l'instant ». */
export function formatAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const minutes = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${Math.floor(minutes)} min`;
  if (minutes < 60 * 24) return `il y a ${Math.floor(minutes / 60)} h`;
  if (minutes < 60 * 24 * 30) return `il y a ${Math.floor(minutes / 1440)} j`;
  return formatDay(iso);
}

/* ---------- Sprint ---------- */

export interface BoardColumn {
  status: IssueStatus;
  issues: Issue[];
  /** Nombre total (la colonne « Fait » est tronquée). */
  total: number;
}

/** Colonnes du kanban dans l'ordre des états ; « Fait » ne garde que les plus récentes. */
export function sprintBoard(issues: Issue[], doneLimit = 5): BoardColumn[] {
  return statusOrder.map((status) => {
    const all = issues.filter((i) => i.status === status);
    const shown =
      status === "done"
        ? [...all]
            .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
            .slice(0, doneLimit)
        : [...all].sort((a, b) => a.number - b.number);
    return { status, issues: shown, total: all.length };
  });
}

/** Story points par état d'une liste d'issues (3 SP sans estimation). */
export function pointsByStatus(
  issues: Pick<Issue, "status" | "points">[],
): Record<IssueStatus, number> {
  const out: Record<IssueStatus, number> = { todo: 0, doing: 0, review: 0, done: 0 };
  for (const i of issues) out[i.status] += issueWeight(i);
  return out;
}

/** Jauges « Progression » : fermées, en revue, en cours, à faire (`unit` : « SP » après la valeur). */
export function statusMeters(counts: Record<IssueStatus, number>, unit?: string) {
  const total = Math.max(
    1,
    statusOrder.reduce((n, s) => n + (counts[s] ?? 0), 0),
  );
  const tones: Record<IssueStatus, ProgressTone> = {
    done: "green",
    review: "blue",
    doing: "clay",
    todo: "neutral",
  };
  return (["done", "review", "doing", "todo"] as const).map((status) => ({
    label: status === "done" ? "Fermées" : issueStatuses[status].label,
    value: unit ? `${counts[status] ?? 0} ${unit}` : (counts[status] ?? 0),
    percent: ((counts[status] ?? 0) / total) * 100,
    tone: tones[status],
  }));
}

/** Retard sur la droite idéale : « 1,5 j de retard » (ambre), « 2 j d'avance » (vert). */
export function delayLabel(delayDays: number): { text: string; tone: "amber" | "green" | "tx3" } {
  if (delayDays >= 0.5) return { text: `${formatDecimal(delayDays)} j de retard`, tone: "amber" };
  if (delayDays <= -0.5) return { text: `${formatDecimal(-delayDays)} j d'avance`, tone: "green" };
  return { text: "dans les temps", tone: "tx3" };
}

/** « 6 jours restants », « dernier jour », « échéance dépassée de 2 j ». */
export function daysLeftLabel(days: number | null): string {
  if (days === null) return "sans échéance";
  if (days < 0) return `échéance dépassée de ${-days} j`;
  if (days === 0) return "dernier jour";
  return `${plural(days, "jour")} restant${days > 1 ? "s" : ""}`;
}

/**
 * Issues à fermer par jour pour finir à l'échéance, aujourd'hui compris (l'échéance est le dernier
 * jour du sprint : `daysLeft` = 0 le dernier jour) ; `null` sans échéance ou une fois dépassée.
 */
export function requiredPace(remaining: number, daysLeft: number | null): number | null {
  if (daysLeft === null || daysLeft < 0) return null;
  return Math.round((remaining / (daysLeft + 1)) * 10) / 10;
}

/** Points de pourcentage gagnés depuis la veille (« +3 aujourd'hui »), dans l'unité du burndown. */
export function gainedToday(burndown: { remaining: number }[], scope: number): number {
  const [prev, last] = burndown.slice(-2);
  if (!prev || !last || scope === 0) return 0;
  return Math.round((Math.max(0, prev.remaining - last.remaining) / scope) * 100);
}

/* ---------- Notes de version ---------- */

const noteSections: { title: string; types: (IssueType | null)[] }[] = [
  { title: "Nouveautés", types: ["feat"] },
  { title: "Corrections", types: ["fix"] },
  { title: "Performances", types: ["perf"] },
  { title: "Documentation", types: ["docs"] },
  { title: "Maintenance", types: ["chore", null] },
];

/** Aperçu des notes de version : issues fermées groupées par type. */
export function releaseNotes(issues: Issue[]) {
  const closed = issues.filter((i) => i.status === "done");
  return noteSections
    .map(({ title, types }) => ({
      title,
      items: closed.filter((i) => types.includes(i.type)).map((i) => `${i.title} (#${i.number})`),
    }))
    .filter((s) => s.items.length > 0);
}

/* ---------- Versions et roadmap ---------- */

type Semver = [number, number, number];

export function parseSemver(title: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(title.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Tri semver (jamais lexical : 0.11.0 vient après 0.2.0). Non-semver en dernier. */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? -1 : y ? 1 : a.localeCompare(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Statut d'affichage d'une version. */
export type VersionStage = "shipped" | "current" | "planned" | "milestone" | "vision";

export const versionStageMeta: Record<
  VersionStage,
  { label: string; tone: BadgeTone; text: string; progress: ProgressTone; icon: IconName }
> = {
  shipped: { label: "livrée", tone: "green", text: "text-green", progress: "green", icon: "check" },
  current: { label: "en cours", tone: "clay", text: "text-clay", progress: "clay", icon: "clock" },
  planned: {
    label: "planifiée",
    tone: "muted",
    text: "text-tx2",
    progress: "tx2",
    icon: "calendar",
  },
  milestone: {
    label: "palier",
    tone: "blue",
    text: "text-blue",
    progress: "blue",
    icon: "calendar",
  },
  vision: {
    label: "vision",
    tone: "purple",
    text: "text-purple",
    progress: "purple",
    icon: "calendar",
  },
};

/**
 * Version en cours : le sprint ouvert dont l'échéance à venir est la plus proche (à défaut, le
 * plus récent en retard) — même règle que `sprint_summary` côté serveur.
 */
export function currentVersion(
  versions: Version[],
  today: string = new Date().toISOString().slice(0, 10),
): string | null {
  const dated = versions.filter((v) => v.state === "open" && v.due_on);
  const upcoming = dated
    .filter((v) => v.due_on!.slice(0, 10) >= today)
    .sort((a, b) => a.due_on!.localeCompare(b.due_on!));
  if (upcoming[0]) return upcoming[0].title;
  return [...dated].sort((a, b) => b.due_on!.localeCompare(a.due_on!))[0]?.title ?? null;
}

export function versionStage(version: Version, current: string | null): VersionStage {
  if (version.state === "closed") return "shipped";
  if (version.title === current) return "current";
  if (version.kind === "sprint") return "planned";
  const v = parseSemver(version.title);
  return v && v[1] === 0 && v[2] === 0 && v[0] >= 1 ? "vision" : "milestone";
}

export function versionProgress(v: Pick<Version, "open_issues" | "closed_issues">): number {
  const total = v.open_issues + v.closed_issues;
  return total === 0 ? 0 : (v.closed_issues / total) * 100;
}

/**
 * Début d'un sprint de `days` jours qui finit à `due` (dernier jour inclus, même règle que le
 * serveur) : un sprint d'un jour commence le jour de son échéance.
 */
export function sprintStart(due: string, days: number): string {
  const d = new Date(`${due.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.max(1, days) + 1);
  return d.toISOString().slice(0, 10);
}

export interface Roadmap {
  /** Versions livrées (les plus récentes). */
  shipped: Version[];
  /** Versions livrées masquées faute de place. */
  olderShipped: number;
  current: Version | null;
  /** Sprints planifiés, puis paliers. */
  planned: Version[];
}

export function buildRoadmap(versions: Version[], current: string | null, maxShipped = 3): Roadmap {
  const sorted = [...versions].sort((a, b) => compareVersions(a.title, b.title));
  const stage = (v: Version) => versionStage(v, current);
  const shipped = sorted.filter((v) => stage(v) === "shipped");
  return {
    shipped: shipped.slice(-maxShipped),
    olderShipped: Math.max(0, shipped.length - maxShipped),
    current: sorted.find((v) => stage(v) === "current") ?? null,
    planned: [
      ...sorted.filter((v) => stage(v) === "planned"),
      ...sorted.filter((v) => stage(v) === "milestone" || stage(v) === "vision"),
    ],
  };
}

/** Versions de la liste : ouvertes (en cours, sprints, paliers) puis livrées, plus récentes d'abord. */
export function sortVersions(versions: Version[], current: string | null): Version[] {
  const rank: Record<VersionStage, number> = {
    current: 0,
    planned: 1,
    milestone: 2,
    vision: 3,
    shipped: 4,
  };
  return [...versions].sort((a, b) => {
    const r = rank[versionStage(a, current)] - rank[versionStage(b, current)];
    if (r !== 0) return r;
    const c = compareVersions(a.title, b.title);
    return a.state === "closed" ? -c : c;
  });
}

/* ---------- Pull requests ---------- */

export const prStateMeta: Record<PrState, { label: string; tone: BadgeTone; iconClass: string }> = {
  draft: { label: "brouillon", tone: "neutral", iconClass: "text-tx3" },
  open: { label: "ouverte", tone: "green", iconClass: "text-green" },
  merged: { label: "fusionnée", tone: "purple", iconClass: "text-purple" },
  closed: { label: "fermée", tone: "red", iconClass: "text-red" },
};

export const ciMeta: Record<
  Exclude<CiState, "none">,
  { icon: IconName; cls: string; dot: DotTone }
> = {
  pending: { icon: "clock", cls: "text-amber", dot: "amber" },
  success: { icon: "check", cls: "text-green", dot: "green" },
  failure: { icon: "close", cls: "text-red", dot: "red" },
};

export const isOpenPr = (pr: Pick<PullRequest, "state">) =>
  pr.state === "open" || pr.state === "draft";

/** « en cours », « 4/4 », « 3/4 », « — ». */
export function ciLabel(ci: PullRequest["ci"]): string {
  if (ci.state === "none") return "—";
  if (ci.state === "pending") return "en cours";
  if (ci.total > 0) return `${ci.passed}/${ci.total}`;
  return ci.state === "success" ? "verte" : "en échec";
}

/** Durée d'attente : « 6 h », « 2 j » ; rouge au-delà d'un jour. */
export function waitingFor(iso: string, now: Date = new Date()) {
  const hours = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3_600_000);
  const label =
    hours < 1 ? "< 1 h" : hours < 24 ? `${Math.floor(hours)} h` : `${Math.floor(hours / 24)} j`;
  return { label, tone: hours >= 24 ? ("red" as const) : ("amber" as const) };
}

/** Colonne « Revues » : changements demandés, approbations, attente, ou rien. */
export function reviewSummary(
  pr: PullRequest,
  now: Date = new Date(),
): { text: string; tone: "tx2" | "amber" | "red" | "green" } | null {
  if (pr.changes_requested > 0) {
    const s = pr.changes_requested > 1 ? "s" : "";
    return { text: `${pr.changes_requested} changement${s} demandé${s}`, tone: "amber" };
  }
  if (pr.approvals > 0) return { text: plural(pr.approvals, "approbation"), tone: "green" };
  if (pr.review_requested_at && isOpenPr(pr)) {
    const wait = waitingFor(pr.review_requested_at, now);
    return { text: `en attente · ${wait.label}`, tone: wait.tone };
  }
  if (pr.review === "pending" && isOpenPr(pr)) return { text: "revue requise", tone: "tx2" };
  return null;
}

/* ---------- Clôture d'une version ---------- */

export interface CloseCheck {
  ok: boolean;
  text: string;
}

/** Conditions de clôture : issues fermées, PR fusionnées, CI des PR ouvertes. */
export function closeChecks(issues: Issue[], pulls: PullRequest[]): CloseCheck[] {
  const open = issues.filter((i) => i.status !== "done").length;
  const unmerged = pulls.filter(isOpenPr);
  const failing = unmerged.filter((p) => p.ci.state === "failure").length;
  const checks: CloseCheck[] = [
    open === 0
      ? { ok: true, text: "Toutes les issues sont fermées" }
      : { ok: false, text: `${plural(open, "issue")} encore ${open > 1 ? "ouvertes" : "ouverte"}` },
    unmerged.length === 0
      ? { ok: true, text: "Aucune PR en attente" }
      : {
          ok: false,
          text: `${plural(unmerged.length, "PR", "PR")} non ${unmerged.length > 1 ? "fusionnées" : "fusionnée"}`,
        },
  ];
  if (unmerged.length > 0) {
    checks.push(
      failing === 0
        ? { ok: true, text: "CI verte sur les PR ouvertes" }
        : { ok: false, text: `CI en échec sur ${plural(failing, "PR", "PR")}` },
    );
  }
  return checks;
}
