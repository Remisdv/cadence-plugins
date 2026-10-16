/** Vue « Issues » : liste des issues du dépôt via l'outil `list_issues`, actions des skills. */
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
import { displayLabels, issueStatuses, issueTypeTone, statusOrder, type Issue, type IssueList } from "../domain";
import { useTool } from "../useTool";

type StateFilter = "open" | "closed" | "all";

const filters: { id: StateFilter; label: string }[] = [
  { id: "open", label: "Ouvertes" },
  { id: "closed", label: "Fermées" },
  { id: "all", label: "Toutes" },
];

export function IssuesView() {
  const [state, setState] = useState<StateFilter>("open");
  const { data, error, loading, reload } = useTool<IssueList>("list_issues", { state, per_page: 100 });
  const [runs, setRuns] = useState<Record<number, RunUpdate>>({});

  const implement = async (issue: Issue) => {
    try {
      const runId = await cadence.runAction("implementer-issue", { issue: issue.number });
      cadence.onRun(runId, (u) => setRuns((r) => ({ ...r, [issue.number]: u })));
    } catch (e) {
      await cadence.notify(isCadenceError(e) ? e.message : String(e), "error");
    }
  };
  const complete = (issue: Issue) =>
    cadence.runAction("completer-issue", { issue: issue.number }).catch((e: unknown) =>
      cadence.notify(isCadenceError(e) ? e.message : String(e), "error"),
    );

  const issues = data?.issues ?? [];
  const byStatus = statusOrder
    .map((s) => ({ status: s, items: issues.filter((i) => i.status === s) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="issue" size={17} className="text-clay" />
        <h1 className="font-display text-title">Issues</h1>
        {data && <span className="mono text-caption text-tx3">{data.repository}</span>}
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
        <Button size="sm" variant="ghost" icon="refresh" iconOnly aria-label="Rafraîchir" onClick={reload} />
      </header>

      <main className="min-h-0 grow overflow-y-auto p-5">
        {loading && !data && (
          <div className="flex items-center gap-2 text-body-sm text-tx3">
            <Spinner /> Chargement des issues…
          </div>
        )}
        {error && <ToolError message={error.message} />}
        {data && issues.length === 0 && !error && (
          <Card className="p-6 text-center text-body-sm text-tx3">Aucune issue dans ce filtre.</Card>
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
                    key={issue.number}
                    issue={issue}
                    run={runs[issue.number]}
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
  run,
  onComplete,
  onImplement,
}: {
  issue: Issue;
  run?: RunUpdate;
  onComplete: () => void;
  onImplement: () => void;
}) {
  const running = run && (run.status === "queued" || run.status === "running");
  return (
    <div className="group flex min-h-[46px] items-center gap-3 px-3.5 py-2">
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
          <Button size="xs" variant="secondary" icon="play" onClick={onImplement} disabled={running}>
            Implémenter
          </Button>
        </div>
      )}
    </div>
  );
}

function ToolError({ message }: { message: string }) {
  const needsSetup = /Jeton GitHub|dépôt GitHub réglé/.test(message);
  return (
    <Callout tone="danger" className="mb-4">
      <div className="flex flex-col gap-2">
        <span>{message}</span>
        {needsSetup && (
          <span>
            <Button size="xs" variant="secondary" icon="github" onClick={() => void cadence.navigate("setup-github")}>
              Configurer GitHub
            </Button>
          </span>
        )}
      </div>
    </Callout>
  );
}
