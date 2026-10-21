/**
 * Détail d'une issue dans Cadence (maquette Cadence 1 « Issue-Detail ») : description rendue,
 * commentaires, et à droite les propriétés (version, jalon, labels, estimation, priorité, assignés),
 * les PR liées et les actions « Implémenter », « Relire » (seulement avec une PR ouverte liée),
 * « Compléter » et « Ouvrir sur GitHub ».
 * Route : `issue` avec `{ repo, number }` (et `from`, la vue où revenir).
 * Outils : `get_issue` (commentaires compris), `list_pull_requests`, `roadmap`.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { cadence, isCadenceError, type RunUpdate } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card, Icon, SectionLabel, Spinner, cn } from "@cadence/ui";
import {
  displayLabels,
  estimateLabel,
  issueContext,
  issueGroup,
  issueStatuses,
  issueTypeTone,
  priorityInfo,
  reviewContext,
  withGroup,
  type PullRequestList,
  type RoadmapPlan,
} from "../domain";
import { CiStatus, Diffstat, Loading, PrStateIcon, ToolError, VersionBadge } from "../components";
import {
  parseIssueRoute,
  pullRequestFor,
  pullsForIssue,
  reviewBlockReason,
  type IssueDetail,
  type PullsLookup,
} from "../issues";
import { Markdown } from "../MarkdownText";
import { formatAgo, isOpenPr, plural, prStateMeta } from "../planning";
import { useTool } from "../useTool";

const notifyError = (e: unknown) =>
  void cadence.notify(isCadenceError(e) ? e.message : String(e), "error");

export function IssueView({ params }: { params: Record<string, string> }) {
  const route = parseIssueRoute(params);
  const back = () => void cadence.navigate(route?.from ?? "issues");
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Button
          size="sm"
          variant="quiet"
          icon="chevronDown"
          iconOnly
          className="rotate-90"
          aria-label="Retour"
          title="Retour"
          onClick={back}
        />
        <Icon name="issue" size={17} className="text-clay" />
        <h1 className="font-display text-title">Issue</h1>
        {route && (
          <span className="mono truncate text-caption text-tx3">
            {route.repo}#{route.number}
          </span>
        )}
      </header>
      {route ? (
        <IssueDetailPane
          key={`${route.repo}#${route.number}`}
          repo={route.repo}
          number={route.number}
        />
      ) : (
        <div className="p-5">
          <Callout tone="warning">
            Issue introuvable : le lien ne précise pas le dépôt et le numéro.
          </Callout>
        </div>
      )}
    </div>
  );
}

function IssueDetailPane({ repo, number }: { repo: string; number: number }) {
  const [tick, setTick] = useState(0);
  const { data, error, loading } = useTool<IssueDetail>(
    "get_issue",
    { repo, number },
    String(tick),
  );
  const pulls = useTool<PullRequestList>(
    "list_pull_requests",
    { repo, state: "all" },
    String(tick),
  );
  const plan = useTool<RoadmapPlan>("roadmap", { repo }, String(tick));
  const issue = data && data.repo === repo && data.number === number ? data : null;

  if (error && !issue) {
    return (
      <div className="p-5">
        <ToolError message={error.message} />
      </div>
    );
  }
  if (!issue) {
    return (
      <div className="p-5">
        {loading && <Loading label={`Lecture de #${number} sur GitHub…`} />}
      </div>
    );
  }

  const allPulls = pulls.data?.pull_requests ?? [];
  const linked = pullsForIssue(allPulls, issue);
  const jalon =
    plan.data?.jalons.find((j) => j.issues.some((i) => i.number === issue.number)) ?? null;
  const closed = issue.state === "closed";
  const comments = issue.comment_list ?? [];

  return (
    // Fenêtre étroite (moins de 640 px) : les propriétés et actions passent sous la description.
    <div className="flex min-h-0 grow max-[640px]:flex-col max-[640px]:overflow-y-auto">
      <div className="flex min-w-0 grow flex-col overflow-hidden max-[640px]:shrink-0 max-[640px]:grow-0 max-[640px]:overflow-visible">
        <div className="shrink-0 border-b border-line px-6 pt-5 pb-4">
          <div className="flex flex-wrap items-center gap-[9px]">
            <Badge tone={closed ? "purple" : "green"} icon={closed ? "check" : "issue"}>
              {closed ? "Fermée" : "Ouverte"}
            </Badge>
            <Badge tone="muted" dot>
              {issueStatuses[issue.status].label}
            </Badge>
            {issue.milestone && <VersionBadge version={issue.milestone} />}
            {issue.type && <Badge tone={issueTypeTone[issue.type]}>type/{issue.type}</Badge>}
            <span className="mono text-small text-tx3">#{issue.number}</span>
            <div className="grow" />
            <span className="text-caption text-tx3">
              ouverte {formatAgo(issue.created_at ?? null)}
              {issue.author && ` par ${issue.author}`}
            </span>
          </div>
          <h2 className="mt-[11px] font-display text-[21px] leading-[1.3] font-semibold">
            {issue.title}
          </h2>
        </div>

        <div className="min-h-0 grow overflow-y-auto px-6 py-[18px] max-[640px]:overflow-visible">
          {issue.body?.trim() ? (
            <Markdown source={issue.body} />
          ) : (
            <p className="text-body-sm text-tx3">
              Pas encore de description. « Compléter » demande à l'IA d'en rédiger une à partir du
              titre et du code.
            </p>
          )}

          <section className="mt-7 flex flex-col gap-2.5">
            <SectionLabel>Commentaires · {comments.length}</SectionLabel>
            {comments.length === 0 ? (
              <p className="text-body-sm text-tx3">Aucun commentaire.</p>
            ) : (
              comments.map((c, i) => (
                <Card key={i} className="px-4 py-3">
                  <div className="mb-1.5 flex items-center gap-2 text-caption text-tx3">
                    <Icon name="user" size={12} />
                    <span className="text-tx">{c.author ?? "?"}</span>
                    <span>{formatAgo(c.created_at)}</span>
                  </div>
                  <Markdown source={c.body ?? ""} className="text-body-sm" />
                </Card>
              ))
            )}
          </section>
        </div>
      </div>

      <aside className="flex w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-panel px-4 py-3 max-[640px]:w-full max-[640px]:overflow-visible max-[640px]:border-t max-[640px]:border-l-0">
        <dl className="flex flex-col">
          <Property label="Version">
            {issue.milestone ? <VersionBadge version={issue.milestone} /> : <Empty />}
          </Property>
          <Property label="Jalon">
            {jalon ? (
              <button
                type="button"
                className="truncate text-left text-body-sm text-tx2 hover:text-clay"
                onClick={() => void cadence.navigate("roadmap")}
                title="Voir la Roadmap"
              >
                {jalon.name}
              </button>
            ) : (
              <Empty />
            )}
          </Property>
          <Property label="Estimation">
            {estimateLabel(issue) ? (
              <Badge mono>{estimateLabel(issue)}</Badge>
            ) : (
              <Empty>non estimée</Empty>
            )}
          </Property>
          <Property label="Priorité">
            {issue.priority !== null && issue.priority !== undefined ? (
              <span title={priorityInfo(issue.priority).title}>
                <Badge tone={priorityInfo(issue.priority).tone}>
                  {priorityInfo(issue.priority).label}
                </Badge>
              </span>
            ) : (
              <Empty />
            )}
          </Property>
          <Property label="Labels">
            {displayLabels(issue.labels).length > 0 ? (
              displayLabels(issue.labels).map((l) => (
                <Badge key={l} tone="muted">
                  {l}
                </Badge>
              ))
            ) : (
              <Empty />
            )}
          </Property>
          <Property label="Assignés">
            {issue.assignees.length > 0 ? (
              <span className="text-body-sm text-tx2">{issue.assignees.join(", ")}</span>
            ) : (
              <Empty>personne</Empty>
            )}
          </Property>
        </dl>

        <section className="flex flex-col gap-2">
          <SectionLabel>Pull requests liées</SectionLabel>
          {pulls.loading && !pulls.data && <Spinner />}
          {pulls.data && linked.length === 0 && (
            <p className="text-body-sm text-tx3">
              Aucune PR ne ferme cette issue ni ne part d'une branche{" "}
              <span className="mono">…/{issue.number}-…</span>.
            </p>
          )}
          {linked.map((pr) => (
            <button
              key={pr.number}
              type="button"
              onClick={() => void cadence.openExternal(pr.url)}
              title={`Ouvrir #${pr.number} sur GitHub`}
              className="flex flex-col gap-1 rounded-field border border-line bg-p2 px-2.5 py-2 text-left hover:border-line2"
            >
              <span className="flex items-center gap-1.5">
                <PrStateIcon state={pr.state} size={14} />
                <span className="mono text-tiny text-tx3">#{pr.number}</span>
                <span className="min-w-0 grow truncate text-body-sm text-tx">{pr.title}</span>
              </span>
              <span className="flex items-center gap-2 text-tiny text-tx3">
                <Badge tone={prStateMeta[pr.state].tone}>{prStateMeta[pr.state].label}</Badge>
                <Diffstat additions={pr.additions} deletions={pr.deletions} plain />
                <div className="grow" />
                {isOpenPr(pr) && <CiStatus ci={pr.ci} />}
              </span>
            </button>
          ))}
        </section>

        <div className="grow" />
        <IssueActions
          issue={issue}
          openPr={pullRequestFor(allPulls, issue)?.number ?? null}
          pulls={pulls.data ? "loaded" : pulls.error ? "failed" : "loading"}
          linkedCount={linked.length}
          onChanged={() => setTick((t) => t + 1)}
        />
      </aside>
    </div>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line py-[9px]">
      <dt className="w-[78px] shrink-0 text-small text-tx3">{label}</dt>
      <dd className="flex min-w-0 grow flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  );
}

function Empty({ children = "—" }: { children?: ReactNode }) {
  return <span className="text-body-sm text-tx3">{children}</span>;
}

function IssueActions({
  issue,
  openPr,
  pulls,
  linkedCount,
  onChanged,
}: {
  issue: IssueDetail;
  openPr: number | null;
  /** Lecture des PR : tant qu'elle court, on ne sait pas s'il y a une PR à relire. */
  pulls: PullsLookup;
  /** PR liées, ouvertes ou non (pour le libellé de « Relire » indisponible). */
  linkedCount: number;
  onChanged: () => void;
}) {
  const [run, setRun] = useState<RunUpdate | null>(null);
  const running = run && (run.status === "queued" || run.status === "running");
  const group = issueGroup(issue);
  const open = issue.state === "open";

  const implement = async () => {
    try {
      // Issue d'un sprint : la conversation est rattachée au sprint (masquée du chat global).
      const runId = await cadence.runAction("implementer-issue", {
        ...issueContext(issue),
        ...withGroup(group),
      });
      cadence.onRun(runId, (u) => {
        setRun(u);
        if (u.status === "succeeded") onChanged();
      });
    } catch (e) {
      notifyError(e);
    }
  };
  // « Relire » demande une PR ouverte liée : sans elle, le tour d'IA ne servirait à rien.
  const reviewBlocked = reviewBlockReason(openPr, pulls, linkedCount);
  const review = () =>
    !reviewBlocked &&
    cadence
      .runAction(
        "relire-valider",
        reviewContext(issue.repo, [{ issue: issue.number, pr: openPr }], group),
      )
      .catch(notifyError);
  const complete = () =>
    cadence.runAction("completer-issue", issueContext(issue)).catch(notifyError);

  return (
    <div className="flex flex-col gap-2">
      {run && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-caption",
            running ? "text-tx2" : "text-tx3",
          )}
        >
          {running && <Spinner size={11} />}
          Implémentation : {run.message ?? run.status}
        </div>
      )}
      {open && (
        <>
          <Button
            variant="primary"
            size="tall"
            icon="play"
            disabled={!!running}
            onClick={() => void implement()}
            title="L'IA crée la branche, code, teste et ouvre une PR en brouillon (tâche de fond)"
          >
            Implémenter
          </Button>
          <div className="flex gap-2">
            {/* Le titre est porté par l'enveloppe : un bouton désactivé n'affiche pas d'infobulle. */}
            <span
              className="flex flex-1"
              title={
                reviewBlocked ??
                (openPr
                  ? `L'IA relit la PR #${openPr} (diff, CI, critères), puis, après votre accord, fusionne et ferme l'issue`
                  : "L'IA cherche la PR de l'issue, la relit, puis, après votre accord, fusionne et ferme l'issue")
              }
            >
              <Button
                className="flex-1"
                icon="review"
                disabled={!!reviewBlocked}
                aria-label={reviewBlocked ? `Relire — ${reviewBlocked}` : undefined}
                onClick={() => void review()}
              >
                Relire
              </Button>
            </span>
            <Button
              className="flex-1"
              variant="ghost"
              icon="sparkle"
              onClick={() => void complete()}
              title="L'IA complète la description (contexte, critères d'acceptation, estimation)"
            >
              Compléter
            </Button>
          </div>
        </>
      )}
      <Button variant="ghost" icon="github" onClick={() => void cadence.openExternal(issue.url)}>
        Ouvrir sur GitHub
      </Button>
      {!open && issue.closed_at && (
        <p className="text-center text-tiny text-tx3">Fermée {formatAgo(issue.closed_at)}.</p>
      )}
      {open && pulls === "loaded" && openPr === null && issue.status === "review" && (
        <p className="text-center text-tiny leading-[1.55] text-tx3">
          En revue, mais aucune PR ouverte ne ferme cette issue ni ne part de sa branche.
        </p>
      )}
      {issue.comments > 0 && !issue.comment_list && (
        <p className="text-center text-tiny text-tx3">{plural(issue.comments, "commentaire")}</p>
      )}
    </div>
  );
}
