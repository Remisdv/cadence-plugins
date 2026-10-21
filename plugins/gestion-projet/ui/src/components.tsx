/**
 * Composants partagés des vues du plugin, repris des composants de domaine de Cadence 1
 * (src/components/domain : Stats, Burndown, IssueCard, Inline, Badges) avec le kit `@cadence/ui`.
 */
import type { ReactNode } from "react";
import { cadence } from "@cadence/plugin-sdk";
import {
  Badge,
  Button,
  Callout,
  Card,
  Icon,
  ProgressBar,
  Spinner,
  StatusDot,
  cn,
  type BadgeTone,
  type IconName,
  type ProgressTone,
} from "@cadence/ui";
import {
  estimateLabel,
  issueStatuses,
  issueTypeTone,
  priorityInfo,
  repoShortName,
  type Issue,
  type PrState,
  type PullRequest,
} from "./domain";
import { issueRoute } from "./issues";
import {
  ciLabel,
  ciMeta,
  formatDay,
  prStateMeta,
  versionStageMeta,
  type BoardColumn,
  type VersionStage,
} from "./planning";

/* ---------- Mise en page ---------- */

/** En-tête de vue : icône clay, titre, sous-titre (dépôt, période), actions à droite. */
export function PageHeader({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: IconName;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
      <Icon name={icon} size={17} className="text-clay" />
      <h1 className="truncate font-display text-title">{title}</h1>
      {subtitle && <span className="truncate text-caption text-tx3">{subtitle}</span>}
      <div className="grow" />
      {children}
    </header>
  );
}

/** Sous-titre de la sélection : `owner/name` ou « Tous les dépôts · 3 ». */
export function SelectionLabel({ repo, count }: { repo: string | null; count: number }) {
  return repo ? <span className="mono">{repo}</span> : <>Tous les dépôts · {count}</>;
}

/** Onglets compacts d'en-tête (filtre d'état). */
export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 rounded-control bg-p2 p-0.5">
      {items.map((f) => (
        <button
          key={f.id}
          role="tab"
          aria-selected={value === f.id}
          onClick={() => onChange(f.id)}
          className={cn(
            "h-[26px] rounded-[6px] px-2.5 text-caption font-medium text-tx3",
            value === f.id && "bg-p4 text-tx",
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-body-sm text-tx3">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyCard({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <Icon name={icon} size={20} className="text-tx3" />
      <div className="text-body font-medium text-tx">{title}</div>
      {children && <p className="max-w-[460px] text-body-sm leading-[1.6] text-tx3">{children}</p>}
    </Card>
  );
}

export function NoRepos() {
  return (
    <Card className="flex flex-col items-center gap-3 p-6 text-center">
      <span className="text-body-sm text-tx2">Aucun dépôt suivi par Gestion de projet.</span>
      <Button
        size="sm"
        variant="secondary"
        icon="github"
        onClick={() => void cadence.navigate("setup-depots")}
      >
        Choisir des dépôts
      </Button>
    </Card>
  );
}

export function ToolError({ message, className }: { message: string; className?: string }) {
  const needsRepos = /non suivi|Aucun dépôt suivi/.test(message);
  return (
    <Callout tone="danger" className={cn("mb-4", className)}>
      <div className="flex flex-col gap-2">
        <span>{message}</span>
        {needsRepos && (
          <span>
            <Button
              size="xs"
              variant="secondary"
              icon="github"
              onClick={() => void cadence.navigate("setup-depots")}
            >
              Dépôts suivis
            </Button>
          </span>
        )}
      </div>
    </Callout>
  );
}

/** Dépôts illisibles d'une liste agrégée. */
export function RepoErrors({ errors }: { errors?: { repo: string; message: string }[] }) {
  if (!errors?.length) return null;
  return (
    <Callout tone="warning" className="mb-4">
      Dépôts illisibles : {errors.map((e) => `${e.repo} (${e.message})`).join(" ; ")}
    </Callout>
  );
}

/** Lien texte clay (« Voir toutes les issues »). */
export function TextLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-small text-clay hover:text-clay-hover">
      {children}
    </button>
  );
}

/** Titre de section d'un dépôt (mode « Tous les dépôts »). */
export function RepoHeading({ repo, children }: { repo: string; children?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <Icon name="github" size={14} className="text-tx3" />
      <span className="mono text-body-sm text-tx">{repo}</span>
      <div className="grow" />
      {children}
    </div>
  );
}

/* ---------- Indicateurs ---------- */

const valueTones = {
  tx: "text-tx",
  clay: "text-clay",
  green: "text-green",
  amber: "text-amber",
  blue: "text-blue",
  purple: "text-purple",
} as const;

type ValueTone = keyof typeof valueTones;

/** Carte KPI : libellé 11.5px, valeur mono 24px colorée, précision 11.5px. */
export function StatCard({
  label,
  value,
  hint,
  tone = "tx",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: ValueTone;
}) {
  return (
    <div className="min-w-[150px] flex-1 rounded-[11px] border border-line bg-panel px-[15px] py-[13px]">
      <div className="text-caption text-tx3">{label}</div>
      <div className="mt-[5px] flex items-baseline gap-[7px]">
        <span
          className={cn(
            "mono shrink-0 text-kpi font-medium tracking-[-0.02em] whitespace-nowrap",
            valueTones[tone],
          )}
        >
          {value}
        </span>
        {hint && (
          <span
            className="truncate text-caption text-tx3"
            title={typeof hint === "string" ? hint : undefined}
          >
            {hint}
          </span>
        )}
      </div>
    </div>
  );
}

export interface StatStripItem {
  label: ReactNode;
  value: ReactNode;
  suffix?: ReactNode;
  tone?: ValueTone;
}

/** Bandeau de KPI compact (détail de version). */
export function StatStrip({ items }: { items: StatStripItem[] }) {
  return (
    <div className="flex overflow-hidden rounded-card border border-line bg-panel">
      {items.map((item, i) => (
        <div
          key={i}
          className={cn(
            "min-w-0 flex-1 px-3.5 py-3",
            i < items.length - 1 && "border-r border-line",
          )}
        >
          <div className="text-tiny text-tx3">{item.label}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span
              className={cn(
                "mono shrink-0 text-[20px] font-medium whitespace-nowrap",
                valueTones[item.tone ?? "tx"],
              )}
            >
              {item.value}
            </span>
            {item.suffix && <span className="truncate text-tiny text-tx3">{item.suffix}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Jauges libellées (progression d'une version par état). */
export function MeterList({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; percent: number; tone: ProgressTone }[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-[11px]", className)}>
      {items.map((item, i) => (
        <div key={i}>
          <div className="mb-[5px] flex justify-between text-small">
            <span className="text-tx2">{item.label}</span>
            <span className="mono text-tx3">{item.value}</span>
          </div>
          <ProgressBar value={item.percent} tone={item.tone} height={5} />
        </div>
      ))}
    </div>
  );
}

const W = 320;
const H = 76;
const TOP = 8;
const BOTTOM = 66;

/**
 * Burndown du sprint : droite idéale en tirets, réel en clay, projection atténuée du dernier
 * point jusqu'à zéro à l'échéance.
 */
export function Burndown({
  points,
  scope,
  start,
  end,
  days,
  label,
}: {
  points: { remaining: number }[];
  /** Nombre d'issues au départ (haut de l'axe). */
  scope: number;
  start: string;
  end: string;
  /** Points attendus sur l'axe x (jours du sprint + 1). */
  days: number;
  label?: string;
}) {
  const step = W / Math.max(1, days - 1);
  const y = (remaining: number) => BOTTOM - (remaining / Math.max(1, scope)) * (BOTTOM - TOP);
  const coords = points.map((p, i) => [i * step, y(p.remaining)] as const);
  const last = coords.at(-1);
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={label ?? "Burndown du sprint"}
        className="block"
      >
        <line
          x1="0"
          y1={TOP}
          x2={W}
          y2={BOTTOM}
          stroke="var(--color-line2)"
          strokeWidth="1.4"
          strokeDasharray="4 4"
        />
        <polyline
          points={coords.map((c) => c.join(",")).join(" ")}
          fill="none"
          stroke="var(--color-clay)"
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {last && (
          <>
            <polyline
              points={`${last.join(",")} ${W},${BOTTOM}`}
              fill="none"
              stroke="var(--color-clay)"
              strokeWidth="2"
              strokeDasharray="4 4"
              opacity=".45"
            />
            <circle cx={last[0]} cy={last[1]} r="3.4" fill="var(--color-clay)" />
          </>
        )}
      </svg>
      <div className="mt-1.5 flex justify-between">
        <span className="mono text-micro text-tx3">{formatDay(start)}</span>
        <span className="mono text-micro text-tx3">{formatDay(end)}</span>
      </div>
    </div>
  );
}

/* ---------- Issues ---------- */

/** Ouvre le détail d'une issue dans Cadence (vue `issue`) ; « Retour » ramène à la vue courante. */
export function openIssue(issue: Pick<Issue, "repo" | "number">) {
  void cadence.navigate("issue", issueRoute(issue, cadence.route?.view));
}

/** Carte du kanban : n°, type, titre, puis assignés et estimation. */
export function IssueCard({ issue, showRepo }: { issue: Issue; showRepo?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => openIssue(issue)}
      title="Ouvrir le détail"
      className="block w-full rounded-field border border-line bg-p2 px-[11px] py-2.5 text-left transition-colors hover:border-line2"
    >
      <div className="flex items-center gap-[7px]">
        <span className="mono text-tiny text-tx3">
          {showRepo ? `${repoShortName(issue.repo)}#${issue.number}` : `#${issue.number}`}
        </span>
        <div className="grow" />
        {issue.type && <Badge tone={issueTypeTone[issue.type]}>type/{issue.type}</Badge>}
      </div>
      <div className="mt-1.5 text-body-sm leading-[1.45] text-tx">{issue.title}</div>
      {(issue.assignees.length > 0 || estimateLabel(issue) || issue.priority !== null) && (
        <div className="mt-[9px] flex items-center gap-[7px] text-tiny text-tx3">
          {issue.priority !== null && issue.priority !== undefined && (
            <span title={priorityInfo(issue.priority).title}>
              <Badge tone={priorityInfo(issue.priority).tone}>
                {priorityInfo(issue.priority).label}
              </Badge>
            </span>
          )}
          {issue.assignees.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Icon name="user" size={12} />
              {issue.assignees.join(", ")}
            </span>
          )}
          {estimateLabel(issue) && <span className="mono">{estimateLabel(issue)}</span>}
        </div>
      )}
    </button>
  );
}

/** Colonne « En revue » sélectionnable : case par tâche, « Relire », PR liée et sa CI. */
export interface ReviewControls {
  selected: ReadonlySet<number>;
  onToggle: (issue: Issue) => void;
  /** Coche ou décoche toutes les tâches de la colonne. */
  onToggleAll: (issues: Issue[], select: boolean) => void;
  onReview: (issue: Issue) => void;
  pullRequestOf: (issue: Issue) => PullRequest | null;
  /** Liste des PR pas encore lue : ni PR ni « sans PR ». */
  pullsLoading?: boolean;
  disabled?: boolean;
}

/** Carte d'une tâche en revue : case à cocher, n°, titre, PR et CI, bouton « Relire ». */
export function ReviewCard({ issue, review }: { issue: Issue; review: ReviewControls }) {
  const pr = review.pullRequestOf(issue);
  const checked = review.selected.has(issue.number);
  return (
    <div
      className={cn(
        "rounded-field border bg-p2 px-[11px] py-2.5 transition-colors",
        checked ? "border-blue-line" : "border-line hover:border-line2",
      )}
    >
      <div className="flex items-center gap-[7px]">
        <input
          type="checkbox"
          checked={checked}
          disabled={review.disabled}
          onChange={() => review.onToggle(issue)}
          aria-label={`Sélectionner #${issue.number} pour la revue`}
        />
        <span className="mono text-tiny text-tx3">#{issue.number}</span>
        <div className="grow" />
        {issue.type && <Badge tone={issueTypeTone[issue.type]}>type/{issue.type}</Badge>}
      </div>
      <button
        type="button"
        onClick={() => openIssue(issue)}
        title="Ouvrir le détail"
        className="mt-1.5 block text-left text-body-sm leading-[1.45] text-tx hover:text-clay"
      >
        {issue.title}
      </button>
      <div className="mt-[9px] flex flex-wrap items-center gap-x-[7px] gap-y-1.5 text-tiny text-tx3">
        {pr ? (
          <button
            type="button"
            className="mono inline-flex items-center gap-1 hover:text-tx"
            onClick={() => void cadence.openExternal(pr.url)}
            title={`${pr.title} (${prStateMeta[pr.state].label})`}
          >
            <Icon name="pullRequest" size={12} />#{pr.number}
          </button>
        ) : review.pullsLoading ? (
          <span>PR…</span>
        ) : (
          <span title="Aucune PR ouverte liée à cette issue (« Closes #n » dans la PR, ou branche feat/<n>-…)">
            sans PR
          </span>
        )}
        {pr && <CiStatus ci={pr.ci} />}
        <div className="grow" />
        <Button
          size="xs"
          variant="ghost"
          icon="review"
          disabled={review.disabled}
          onClick={() => review.onReview(issue)}
          title="L'IA relit la PR (diff, CI, critères), puis, après votre accord, approuve, fusionne et ferme l'issue"
        >
          Relire
        </Button>
      </div>
    </div>
  );
}

export function KanbanColumn({
  column,
  review,
  onRemove,
  removeDisabled,
}: {
  column: BoardColumn;
  review?: ReviewControls;
  /** « Retirer du sprint » sur chaque carte (colonne « À faire » du sprint en cours). */
  onRemove?: (issue: Issue) => void;
  removeDisabled?: boolean;
}) {
  const meta = issueStatuses[column.status];
  const allSelected =
    !!review &&
    column.issues.length > 0 &&
    column.issues.every((i) => review.selected.has(i.number));
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-[9px]">
      <div className="flex items-center gap-[7px] px-0.5">
        <StatusDot tone={meta.dot} size={7} />
        <span className="text-small font-semibold">{meta.label}</span>
        <span className="mono text-tiny text-tx3">{column.total}</span>
        {review && column.issues.length > 1 && (
          <>
            <div className="grow" />
            <input
              type="checkbox"
              checked={allSelected}
              disabled={review.disabled}
              onChange={() => review.onToggleAll(column.issues, !allSelected)}
              aria-label="Sélectionner toutes les tâches en revue"
              title="Tout sélectionner"
            />
          </>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {column.issues.map((issue) =>
          review ? (
            <ReviewCard key={`${issue.repo}#${issue.number}`} issue={issue} review={review} />
          ) : onRemove ? (
            <div key={`${issue.repo}#${issue.number}`} className="group relative">
              <IssueCard issue={issue} />
              <button
                type="button"
                onClick={() => onRemove(issue)}
                disabled={removeDisabled}
                aria-label={`Retirer #${issue.number} du sprint`}
                title="Retirer du sprint (l'issue repart au carnet, sans version)"
                className="absolute right-1.5 bottom-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-control text-tx3 opacity-40 transition-opacity group-hover:opacity-100 hover:bg-p4 hover:text-tx focus-visible:opacity-100 disabled:opacity-50"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ) : (
            <IssueCard key={`${issue.repo}#${issue.number}`} issue={issue} />
          ),
        )}
        {column.total > column.issues.length && (
          <span className="px-0.5 text-tiny text-tx3">
            + {column.total - column.issues.length} autre
            {column.total - column.issues.length > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------- Versions et pull requests ---------- */

export function VersionBadge({
  version,
  stage,
  tone,
}: {
  version: string;
  stage?: VersionStage;
  tone?: BadgeTone;
}) {
  return (
    <Badge tone={tone ?? (stage ? versionStageMeta[stage].tone : "clay")} mono>
      {version}
    </Badge>
  );
}

export function PrStateIcon({ state, size = 16 }: { state: PrState; size?: number }) {
  return (
    <span
      className={cn("flex", prStateMeta[state].iconClass)}
      title={`PR ${prStateMeta[state].label}`}
    >
      <Icon name="pullRequest" size={size} />
    </span>
  );
}

/** Statut de CI : « en cours » (ambre), « 4/4 » (vert), « 3/4 » (rouge). */
export function CiStatus({ ci }: { ci: PullRequest["ci"] }) {
  if (ci.state === "none") return <span className="text-caption text-tx3">—</span>;
  const m = ciMeta[ci.state];
  return (
    <span className={cn("inline-flex items-center gap-1 text-caption", m.cls)}>
      <Icon name={m.icon} size={13} />
      {ciLabel(ci)}
    </span>
  );
}

/** « +412 −87 » */
export function Diffstat({
  additions,
  deletions,
  plain,
}: {
  additions: number;
  deletions: number;
  plain?: boolean;
}) {
  return (
    <span className={cn("mono text-tiny", plain && "text-tx3")}>
      <span className={plain ? undefined : "text-green"}>+{additions}</span>{" "}
      <span className={plain ? undefined : "text-red"}>−{deletions}</span>
    </span>
  );
}
