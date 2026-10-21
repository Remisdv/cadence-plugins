/**
 * Vue « Issues » : issues du dépôt choisi dans le sélecteur de Cadence, ou de tous les dépôts
 * suivis (« Tous les dépôts », avec une colonne dépôt), via l'outil `list_issues`. Tri par
 * priorité (comme le remplissage des sprints), ordre de la roadmap, numéro ou activité ; un clic
 * ouvre le détail (vue `issue`). « Nouvelle issue » crée une issue à la main (`create_issue`),
 * « Depuis un document » demande le document avant de lancer l'IA. Une issue créée apparaît tout
 * de suite dans la liste (même si GitHub la renvoie avec retard) avec une confirmation qui mène
 * à son détail.
 */
import { useEffect, useState } from "react";
import { cadence, isCadenceError, type RunUpdate } from "@cadence/plugin-sdk";
import {
  Badge,
  Button,
  Callout,
  Card,
  SectionLabel,
  Select,
  Spinner,
  StatusDot,
} from "@cadence/ui";
import {
  displayLabels,
  estimateLabel,
  issueContext,
  issueGroup,
  issueKey,
  issueStatuses,
  issueTypeTone,
  priorityInfo,
  repoShortName,
  statusOrder,
  withGroup,
  type Issue,
  type IssueList,
  type RoadmapPlan,
} from "../domain";
import {
  NoRepos,
  PageHeader,
  SegmentedTabs,
  SelectionLabel,
  Toast,
  ToolError,
  type ToastMessage,
} from "../components";
import {
  isIssueSort,
  issueRoute,
  issueSorts,
  sortIssues,
  stillMissing,
  withCreated,
  type IssueSort,
} from "../issues";
import { useRepos } from "../useRepos";
import { useTool } from "../useTool";
import { DocumentDialog } from "./DocumentDialog";
import { IssueCreateDialog } from "./IssueCreateDialog";

type StateFilter = "open" | "closed" | "all";

const filters: { id: StateFilter; label: string }[] = [
  { id: "open", label: "Ouvertes" },
  { id: "closed", label: "Fermées" },
  { id: "all", label: "Toutes" },
];

const SORT_KEY = "gestion-projet.issues.sort";

function savedSort(): IssueSort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return isIssueSort(v) ? v : "priority";
  } catch {
    return "priority";
  }
}

/**
 * Position du jalon de chaque issue (`owner/name#n` → index dans la Roadmap) pour le tri
 * « Roadmap » ; lue seulement quand ce tri est choisi.
 */
function useJalonOrder(repos: string[], enabled: boolean): Map<string, number> | null {
  const [order, setOrder] = useState<Map<string, number> | null>(null);
  const key = repos.join(",");
  useEffect(() => {
    if (!enabled || !key) return;
    let alive = true;
    void Promise.all(
      key
        .split(",")
        .map((repo) => cadence.call<RoadmapPlan>("roadmap", { repo }).catch(() => null)),
    ).then((plans) => {
      if (!alive) return;
      const map = new Map<string, number>();
      for (const plan of plans) {
        plan?.jalons.forEach((j, index) => {
          for (const i of j.issues) map.set(issueKey({ repo: plan.repo, number: i.number }), index);
        });
      }
      setOrder(map);
    });
    return () => {
      alive = false;
    };
  }, [key, enabled]);
  return enabled ? order : null;
}

export function IssuesView() {
  const [state, setState] = useState<StateFilter>("open");
  const [sort, setSortState] = useState<IssueSort>(savedSort);
  const setSort = (next: IssueSort) => {
    setSortState(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // Stockage indisponible dans l'iframe : le tri vaut pour cette visite.
    }
  };
  const [dialog, setDialog] = useState<"create" | "document" | null>(null);
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
  // Issues créées dans cette visite, gardées tant que la liste lue sur GitHub ne les a pas.
  const [created, setCreated] = useState<Issue[]>([]);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const implement = async (issue: Issue) => {
    try {
      // Issue d'un sprint : la conversation est rattachée au sprint (masquée du chat global).
      const runId = await cadence.runAction("implementer-issue", {
        ...issueContext(issue),
        ...withGroup(issueGroup(issue)),
      });
      cadence.onRun(runId, (u) => setRuns((r) => ({ ...r, [issueKey(issue)]: u })));
    } catch (e) {
      await cadence.notify(isCadenceError(e) ? e.message : String(e), "error");
    }
  };
  const complete = (issue: Issue) =>
    cadence
      .runAction("completer-issue", issueContext(issue))
      .catch((e: unknown) => cadence.notify(isCadenceError(e) ? e.message : String(e), "error"));
  const followed = (repos ?? []).map((r) => r.fullName);
  const jalonOrder = useJalonOrder(repo ? [repo] : followed, ready && sort === "roadmap");

  // Une réponse d'une autre sélection (le temps du rechargement) n'est pas affichée.
  const current = data && (repo ? data.repo === repo : data.repo === null) ? data : null;
  useEffect(() => {
    if (current) setCreated((c) => (c.length ? stillMissing(c, current.issues) : c));
  }, [current]);
  const listed = current ? withCreated(current.issues, created, { repo, state }) : [];
  const issues = sortIssues(listed, sort, (i) => jalonOrder?.get(issueKey(i)) ?? null);

  const onCreated = (issue: Issue) => {
    setDialog(null);
    setCreated((c) => [issue, ...c.filter((i) => issueKey(i) !== issueKey(issue))]);
    setToast({
      id: Date.now(),
      text: (
        <>
          Issue <span className="mono">#{issue.number}</span> créée
          {!repo && ` sur ${repoShortName(issue.repo)}`}.
        </>
      ),
      action: {
        label: `Voir #${issue.number}`,
        onClick: () => void cadence.navigate("issue", issueRoute(issue, "issues")),
      },
    });
    reload();
  };
  const byStatus = statusOrder
    .map((s) => ({ status: s, items: issues.filter((i) => i.status === s) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="issue"
        title="Issues"
        subtitle={
          (repo || (all && repos)) && <SelectionLabel repo={repo} count={repos?.length ?? 0} />
        }
      >
        <SegmentedTabs items={filters} value={state} onChange={setState} label="État" />
        <Select
          size="sm"
          aria-label="Trier"
          title={issueSorts.find((s) => s.id === sort)?.title}
          value={sort}
          onChange={(e) => setSort(e.target.value as IssueSort)}
          className="w-auto"
        >
          {issueSorts.map((s) => (
            <option key={s.id} value={s.id}>
              Tri : {s.label}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          icon="file"
          onClick={() => setDialog("document")}
          disabled={!ready}
          title="Choisir un document (fichier ou texte collé) : l'IA vérifie le code et les issues existantes, puis crée les issues chiffrées en story points"
        >
          Depuis un document
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          onClick={() => setDialog("create")}
          disabled={!ready}
        >
          Nouvelle issue
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={reload}
          disabled={!ready}
        />
      </PageHeader>

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
                    onOpen={() => void cadence.navigate("issue", issueRoute(issue, "issues"))}
                    onComplete={() => void complete(issue)}
                    onImplement={() => void implement(issue)}
                  />
                ))}
              </Card>
            </section>
          ))}
        </div>
      </main>

      {dialog === "create" && (
        <IssueCreateDialog
          repos={followed}
          initialRepo={repo}
          onClose={() => setDialog(null)}
          onCreated={onCreated}
        />
      )}
      {dialog === "document" && (
        <DocumentDialog repos={followed} initialRepo={repo} onClose={() => setDialog(null)} />
      )}
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function IssueRow({
  issue,
  showRepo,
  run,
  onOpen,
  onComplete,
  onImplement,
}: {
  issue: Issue;
  /** Colonne dépôt (mode « Tous les dépôts »). */
  showRepo: boolean;
  run?: RunUpdate;
  onOpen: () => void;
  onComplete: () => void;
  onImplement: () => void;
}) {
  const running = run && (run.status === "queued" || run.status === "running");
  return (
    <div className="group relative flex min-h-[46px] items-center gap-3 px-3.5 py-2">
      {showRepo && (
        <span className="mono w-[120px] shrink-0 truncate text-caption text-tx3" title={issue.repo}>
          {repoShortName(issue.repo)}
        </span>
      )}
      <span className="mono w-[42px] shrink-0 text-tiny text-tx3">#{issue.number}</span>
      {/* Fenêtre étroite : les badges passent sous le titre plutôt que de l'écraser. */}
      <div className="flex min-w-0 grow flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-[min(100%,200px)] flex-1">
          <button
            className="block max-w-full truncate text-left text-body text-tx hover:text-clay"
            onClick={onOpen}
            title="Ouvrir le détail"
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
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.priority !== null && issue.priority !== undefined && (
            <span title={priorityInfo(issue.priority).title}>
              <Badge tone={priorityInfo(issue.priority).tone}>
                {priorityInfo(issue.priority).label}
              </Badge>
            </span>
          )}
          {issue.type && <Badge tone={issueTypeTone[issue.type]}>{issue.type}</Badge>}
          {displayLabels(issue.labels)
            .slice(0, 2)
            .map((l) => (
              <Badge key={l} tone="muted">
                {l}
              </Badge>
            ))}
          {estimateLabel(issue) && <Badge mono>{estimateLabel(issue)}</Badge>}
          {issue.milestone && (
            <Badge mono tone="clay" icon="tag">
              {issue.milestone}
            </Badge>
          )}
        </div>
      </div>
      {/* Par-dessus la fin de la ligne au survol : invisibles, elles ne prennent pas de place. */}
      {issue.state === "open" && (
        <div className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 gap-1.5 rounded-control bg-panel pl-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
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
