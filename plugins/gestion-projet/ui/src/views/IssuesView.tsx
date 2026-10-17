/**
 * Vue « Issues » : issues du dépôt choisi dans le sélecteur de Cadence, ou de tous les dépôts
 * suivis (« Tous les dépôts », avec une colonne dépôt), via l'outil `list_issues`.
 */
import { useState } from "react";
import { cadence, isCadenceError, type RunUpdate } from "@cadence/plugin-sdk";
import {
  Badge,
  Button,
  Callout,
  Card,
  Icon,
  SectionLabel,
  Spinner,
  StatusDot,
  cn,
} from "@cadence/ui";
import {
  displayLabels,
  issueContext,
  issueKey,
  issueStatuses,
  issueTypeTone,
  repoShortName,
  statusOrder,
  type Issue,
  type IssueList,
} from "../domain";
import { NoRepos, ToolError } from "../components";
import { useRepos } from "../useRepos";
import { useTool } from "../useTool";

type StateFilter = "open" | "closed" | "all";

const filters: { id: StateFilter; label: string }[] = [
  { id: "open", label: "Ouvertes" },
  { id: "closed", label: "Fermées" },
  { id: "all", label: "Toutes" },
];

export function IssuesView() {
  const [state, setState] = useState<StateFilter>("open");
  const { repos, selection, error: reposError } = useRepos();
  const repo = selection?.kind === "one" ? selection.repo : null;
  const all = selection?.kind === "all";
  const ready = selection !== null && (repos?.length ?? 0) > 0;
  const { data, error, loading, reload } = useTool<IssueList>(
    "list_issues",
    repo ? { repo, state, per_page: 100 } : { state, per_page: 100 },
    "",
    ready,
  );
  const [runs, setRuns] = useState<Record<string, RunUpdate>>({});

  const implement = async (issue: Issue) => {
    try {
      const runId = await cadence.runAction("implementer-issue", issueContext(issue));
      cadence.onRun(runId, (u) => setRuns((r) => ({ ...r, [issueKey(issue)]: u })));
    } catch (e) {
      await cadence.notify(isCadenceError(e) ? e.message : String(e), "error");
    }
  };
  const complete = (issue: Issue) =>
    cadence
      .runAction("completer-issue", issueContext(issue))
      .catch((e: unknown) => cadence.notify(isCadenceError(e) ? e.message : String(e), "error"));

  // Une réponse d'une autre sélection (le temps du rechargement) n'est pas affichée.
  const current = data && (repo ? data.repo === repo : data.repo === null) ? data : null;
  const issues = current?.issues ?? [];
  const byStatus = statusOrder
    .map((s) => ({ status: s, items: issues.filter((i) => i.status === s) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="issue" size={17} className="text-clay" />
        <h1 className="font-display text-title">Issues</h1>
        {repo && <span className="mono text-caption text-tx3">{repo}</span>}
        {all && repos && (
          <span className="text-caption text-tx3">Tous les dépôts · {repos.length}</span>
        )}
        <div className="grow" />
        <div role="tablist" aria-label="État" className="flex gap-1 rounded-control bg-p2 p-0.5">
          {filters.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={state === f.id}
              onClick={() => setState(f.id)}
              className={cn(
                "h-[26px] rounded-[6px] px-2.5 text-caption font-medium text-tx3",
                state === f.id && "bg-p4 text-tx",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={reload}
          disabled={!ready}
        />
      </header>

      <main className="min-h-0 grow overflow-y-auto p-5">
        {reposError && (
          <Callout tone="danger" className="mb-4">
            {reposError.message}
          </Callout>
        )}
        {repos && repos.length === 0 && <NoRepos />}
        {ready && loading && !current && (
          <div className="flex items-center gap-2 text-body-sm text-tx3">
            <Spinner /> Chargement des issues…
          </div>
        )}
        {ready && error && <ToolError message={error.message} />}
        {current?.errors?.length ? (
          <Callout tone="warning" className="mb-4">
            Dépôts illisibles : {current.errors.map((e) => `${e.repo} (${e.message})`).join(" ; ")}
          </Callout>
        ) : null}
        {current && issues.length === 0 && !error && (
          <Card className="p-6 text-center text-body-sm text-tx3">
            Aucune issue dans ce filtre.
          </Card>
        )}
        <div className="flex flex-col gap-5">
          {byStatus.map((group) => (
            <section key={group.status} className="flex flex-col gap-2">
              <SectionLabel className="flex items-center gap-2">
                <StatusDot tone={issueStatuses[group.status].dot} size={7} />
                {issueStatuses[group.status].label}
                <span className="text-tx3">· {group.items.length}</span>
              </SectionLabel>
              <Card className="divide-y divide-line">
                {group.items.map((issue) => (
                  <IssueRow
                    key={issueKey(issue)}
                    issue={issue}
                    showRepo={!repo}
                    run={runs[issueKey(issue)]}
                    onComplete={() => void complete(issue)}
                    onImplement={() => void implement(issue)}
                  />
                ))}
              </Card>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function IssueRow({
  issue,
  showRepo,
  run,
  onComplete,
  onImplement,
}: {
  issue: Issue;
  /** Colonne dépôt (mode « Tous les dépôts »). */
  showRepo: boolean;
  run?: RunUpdate;
  onComplete: () => void;
  onImplement: () => void;
}) {
  const running = run && (run.status === "queued" || run.status === "running");
  return (
    <div className="group flex min-h-[46px] items-center gap-3 px-3.5 py-2">
      {showRepo && (
        <span className="mono w-[120px] shrink-0 truncate text-caption text-tx3" title={issue.repo}>
          {repoShortName(issue.repo)}
        </span>
      )}
      <span className="mono w-[42px] shrink-0 text-tiny text-tx3">#{issue.number}</span>
      <div className="min-w-0 grow">
        <button
          className="block max-w-full truncate text-left text-body text-tx hover:text-clay"
          onClick={() => void cadence.openExternal(issue.url)}
          title="Ouvrir sur GitHub"
        >
          {issue.title}
        </button>
        {run && (
          <div className="mt-0.5 flex items-center gap-1.5 text-caption text-tx3">
            {running && <Spinner size={11} />}
            Implémentation : {run.message ?? run.status}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {issue.type && <Badge tone={issueTypeTone[issue.type]}>{issue.type}</Badge>}
        {displayLabels(issue.labels)
          .slice(0, 2)
          .map((l) => (
            <Badge key={l} tone="muted">
              {l}
            </Badge>
          ))}
        {issue.estimate && <Badge mono>{issue.estimate}</Badge>}
        {issue.milestone && (
          <Badge mono tone="clay" icon="tag">
            {issue.milestone}
          </Badge>
        )}
      </div>
      {issue.state === "open" && (
        <div className="flex shrink-0 gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button size="xs" variant="ghost" icon="sparkle" onClick={onComplete}>
            Compléter
          </Button>
          <Button
            size="xs"
            variant="secondary"
            icon="play"
            onClick={onImplement}
            disabled={running}
          >
            Implémenter
          </Button>
        </div>
      )}
    </div>
  );
}
