/**
 * Vue « Issues » : table groupée façon Monday / Jira des issues du dépôt choisi dans le
 * sélecteur de Cadence, ou de tous les dépôts suivis (`list_issues`).
 *
 * - À gauche, l'arbre des catégories (domaine › catégorie, `list_categories`) filtre la table,
 *   avec un compteur par nœud ; « Gérer les catégories » ouvre la vue `categories`.
 * - La table est groupée (domaine par défaut, ou catégorie, état, version, priorité) : en-tête
 *   repliable à la couleur du groupe, nombre d'issues, story points, barre de répartition des
 *   états ; « + » au pied d'un groupe crée une issue déjà rangée dedans.
 * - Catégorie, état, étape (domaines à pipeline : échanges client, documents) et priorité se
 *   changent dans la cellule (`update_issue`) ; un changement d'étape demande une note, historisée
 *   en commentaire de l'issue.
 * - Un clic sur le titre ouvre le détail (vue `issue`). Au survol : « Compléter », « Implémenter ».
 *
 * Regroupement, tri, colonnes, groupes repliés et largeur de l'arbre sont gardés dans le
 * stockage local de l'iframe.
 */
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { cadence, isCadenceError, type RunUpdate } from "@cadence/plugin-sdk";
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  Textarea,
  cn,
  initialsOf,
} from "@cadence/ui";
import {
  displayLabels,
  issueContext,
  issueGroup,
  issueKey,
  issueStatuses,
  priorityInfo,
  repoShortName,
  statusOrder,
  withGroup,
  type Issue,
  type IssueList,
  type IssueStatus,
  type RoadmapPlan,
} from "../domain";
import {
  NO_CATEGORY_COLOR,
  countByCategory,
  groupIssues,
  groupings,
  indexCategories,
  isGroupBy,
  matchesFilter,
  matchesSearch,
  pickable,
  pipelineOf,
  pointsOf,
  statusColorOf,
  statusShares,
  type CategoryFilter,
  type CategoryRef,
  type DomainView,
  type GroupBy,
  type IssueGroup,
  type Stage,
} from "../categories";
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
import { compareVersions } from "../planning";
import { useCategories } from "../useCategories";
import { useLiveRefresh } from "../useLiveRefresh";
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

/* ---------- Préférences gardées dans l'iframe ---------- */

const PREFS_KEY = "gestion-projet.issues.prefs";

type Column = "category" | "status" | "stage" | "priority" | "points" | "milestone" | "assignees";

/** `min` : largeur minimale de la colonne, pour la largeur minimale de la table. */
const columns: { id: Column; label: string; width: string; min: number }[] = [
  { id: "category", label: "Catégorie", width: "minmax(140px,170px)", min: 140 },
  { id: "status", label: "État", width: "112px", min: 112 },
  { id: "stage", label: "Étape", width: "140px", min: 140 },
  { id: "priority", label: "Priorité", width: "72px", min: 72 },
  { id: "points", label: "SP", width: "46px", min: 46 },
  { id: "milestone", label: "Version", width: "72px", min: 72 },
  { id: "assignees", label: "Assignés", width: "70px", min: 70 },
];

interface Prefs {
  sort: IssueSort;
  groupBy: GroupBy;
  hidden: Column[];
  collapsed: string[];
  tree: boolean;
}

const defaultPrefs: Prefs = {
  sort: "priority",
  groupBy: "domain",
  hidden: [],
  collapsed: [],
  tree: true,
};

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    // Ancien réglage de tri, gardé à part avant la table groupée.
    const legacySort = localStorage.getItem("gestion-projet.issues.sort");
    return {
      sort: isIssueSort(raw.sort) ? raw.sort : isIssueSort(legacySort) ? legacySort : "priority",
      groupBy: isGroupBy(raw.groupBy) ? raw.groupBy : "domain",
      hidden: Array.isArray(raw.hidden)
        ? raw.hidden.filter((c) => columns.some((k) => k.id === c))
        : [],
      collapsed: Array.isArray(raw.collapsed)
        ? raw.collapsed.filter((c) => typeof c === "string")
        : [],
      tree: raw.tree !== false,
    };
  } catch {
    return defaultPrefs;
  }
}

function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const update = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // Stockage indisponible dans l'iframe : les préférences valent pour cette visite.
      }
      return next;
    });
  return [prefs, update];
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

/** Changement d'étape en attente de sa note (boîte « Passer à … »). */
interface StageChange {
  issue: Issue;
  stage: Stage;
  from: Stage | null;
}

export function IssuesView() {
  const [state, setState] = useState<StateFilter>("open");
  const [prefs, setPrefs] = usePrefs();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CategoryFilter>({ kind: "all" });
  const [dialog, setDialog] = useState<
    { kind: "create"; category: string | null } | { kind: "document" } | null
  >(null);
  const [stageChange, setStageChange] = useState<StageChange | null>(null);
  const { repos, selection, error: reposError } = useRepos();
  const repo = selection?.kind === "one" ? selection.repo : null;
  const all = selection?.kind === "all";
  const ready = selection !== null && (repos?.length ?? 0) > 0;
  const followed = (repos ?? []).map((r) => r.fullName);
  const shown = repo ? [repo] : followed;
  const { data, error, loading, reload } = useTool<IssueList>(
    "list_issues",
    repo ? { repo, state, per_page: 100 } : { state, per_page: 100 },
    "",
    ready,
  );
  const categories = useCategories(shown, ready);
  useLiveRefresh(shown, () => {
    reload();
    categories.reload();
  });
  const [runs, setRuns] = useState<Record<string, RunUpdate>>({});
  // Issues créées dans cette visite, gardées tant que la liste lue sur GitHub ne les a pas.
  const [created, setCreated] = useState<Issue[]>([]);
  // Issues modifiées dans la table : réponse d'`update_issue`, en attendant la relecture.
  const [edited, setEdited] = useState<Record<string, Issue>>({});
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
  const jalonOrder = useJalonOrder(shown, ready && prefs.sort === "roadmap");

  // Une réponse d'une autre sélection (le temps du rechargement) n'est pas affichée.
  const current = data && (repo ? data.repo === repo : data.repo === null) ? data : null;
  useEffect(() => {
    if (current) setCreated((c) => (c.length ? stillMissing(c, current.issues) : c));
    setEdited({});
  }, [current]);
  const listed = current
    ? withCreated(current.issues, created, { repo, state }).map((i) => edited[issueKey(i)] ?? i)
    : [];
  const domains = categories.domains;
  const index = useMemo(() => indexCategories(domains ?? []), [domains]);
  const searched = listed.filter((i) => matchesSearch(i, search));
  const counts = countByCategory(searched, index);
  const visible = sortIssues(
    searched.filter((i) => matchesFilter(i, filter, index)),
    prefs.sort,
    (i) => jalonOrder?.get(issueKey(i)) ?? null,
  );
  const groups = groupIssues(visible, prefs.groupBy, domains ?? [], compareVersions);
  const shownColumns = columns.filter(
    (c) =>
      !prefs.hidden.includes(c.id) &&
      // Pas de colonne « Étape » si aucun domaine n'a de pipeline.
      (c.id !== "stage" || (domains ?? []).some((d) => d.pipeline)),
  );

  const save = async (issue: Issue, args: Record<string, unknown>, done?: string) => {
    try {
      const updated = await cadence.call<Issue>("update_issue", {
        repo: issue.repo,
        number: issue.number,
        ...args,
      });
      setEdited((e) => ({ ...e, [issueKey(issue)]: { ...issue, ...updated, repo: issue.repo } }));
      if (done) setToast({ id: Date.now(), text: done });
    } catch (e) {
      await cadence.notify(isCadenceError(e) ? e.message : String(e), "error");
    }
  };
  const setStatus = (issue: Issue, status: IssueStatus) => {
    if (status === issue.status) return;
    void save(
      issue,
      status === "done"
        ? { state: "closed", state_reason: "completed" }
        : issue.state === "closed"
          ? { state: "open", state_reason: "reopened", status }
          : { status },
    );
  };

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
  const toggleGroup = (key: string) => {
    const id = `${prefs.groupBy}:${key}`;
    setPrefs({
      collapsed: prefs.collapsed.includes(id)
        ? prefs.collapsed.filter((c) => c !== id)
        : [...prefs.collapsed, id],
    });
  };
  const categoryOfGroup = (group: IssueGroup<Issue>): string | null =>
    prefs.groupBy === "category" && index.has(group.key)
      ? group.key
      : filter.kind === "category"
        ? filter.id
        : null;

  const template = ["56px", "minmax(240px,1fr)", ...shownColumns.map((c) => c.width), "56px"].join(
    " ",
  );
  // Numéro, titre (240 px au moins), colonnes, actions, bordures : en deçà, la table défile.
  const minWidth = 56 + 240 + shownColumns.reduce((w, c) => w + c.min, 0) + 56 + 2;

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
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-2.5 flex -translate-y-1/2 text-tx3">
            <Icon name="search" size={13} />
          </span>
          <Input
            size="sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher…"
            aria-label="Rechercher une issue"
            className="w-[180px] pl-8"
          />
        </div>
        <DisplayMenu prefs={prefs} setPrefs={setPrefs} />
        <Button
          size="sm"
          icon="file"
          onClick={() => setDialog({ kind: "document" })}
          disabled={!ready}
          title="Choisir un document (fichier ou texte collé) : l'IA vérifie le code et les issues existantes, puis crée les issues chiffrées en story points"
        >
          Depuis un document
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          onClick={() =>
            setDialog({ kind: "create", category: filter.kind === "category" ? filter.id : null })
          }
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
          onClick={() => {
            reload();
            categories.reload();
          }}
          disabled={!ready}
        />
      </PageHeader>

      <div className="flex min-h-0 grow">
        {ready && prefs.tree && (
          <CategoryTree
            domains={domains}
            counts={counts}
            total={searched.length}
            filter={filter}
            onFilter={setFilter}
            onHide={() => setPrefs({ tree: false })}
          />
        )}

        <main className="min-w-0 grow overflow-auto p-5">
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
          {categories.error && (
            <Callout tone="warning" className="mb-4">
              Catégories illisibles : {categories.error.message}
            </Callout>
          )}
          {current?.errors?.length ? (
            <Callout tone="warning" className="mb-4">
              Dépôts illisibles :{" "}
              {current.errors.map((e) => `${e.repo} (${e.message})`).join(" ; ")}
            </Callout>
          ) : null}

          {ready && !prefs.tree && (
            <div className="mb-3">
              <Button
                size="xs"
                variant="ghost"
                icon="layers"
                onClick={() => setPrefs({ tree: true })}
              >
                Afficher les catégories
              </Button>
            </div>
          )}

          {current && visible.length === 0 && !error && (
            <Card className="p-6 text-center text-body-sm text-tx3">
              {search || filter.kind !== "all"
                ? "Aucune issue ne correspond à ce filtre."
                : "Aucune issue dans ce filtre."}
            </Card>
          )}

          <div className="flex flex-col gap-6" style={{ minWidth }}>
            {groups.map((group) => {
              const collapsed = prefs.collapsed.includes(`${prefs.groupBy}:${group.key}`);
              return (
                <IssueGroupTable
                  key={group.key}
                  group={group}
                  collapsed={collapsed}
                  onToggle={() => toggleGroup(group.key)}
                  template={template}
                  columns={shownColumns.map((c) => c.id)}
                  onAdd={() => setDialog({ kind: "create", category: categoryOfGroup(group) })}
                  showRepo={!repo}
                  renderRow={(issue) => (
                    <IssueRow
                      key={issueKey(issue)}
                      issue={issue}
                      color={group.color}
                      template={template}
                      columns={shownColumns.map((c) => c.id)}
                      showRepo={!repo}
                      domains={domains}
                      index={index}
                      run={runs[issueKey(issue)]}
                      onOpen={() => void cadence.navigate("issue", issueRoute(issue, "issues"))}
                      onComplete={() => void complete(issue)}
                      onImplement={() => void implement(issue)}
                      onStatus={(s) => setStatus(issue, s)}
                      onPriority={(p) => void save(issue, { priority: p })}
                      onCategory={(c) => void save(issue, { category: c ?? "" })}
                      onStage={(stage, from) => setStageChange({ issue, stage, from })}
                    />
                  )}
                />
              );
            })}
          </div>
        </main>
      </div>

      {dialog?.kind === "create" && (
        <IssueCreateDialog
          repos={followed}
          initialRepo={repo}
          domains={domains}
          initialCategory={dialog.category}
          onClose={() => setDialog(null)}
          onCreated={onCreated}
        />
      )}
      {dialog?.kind === "document" && (
        <DocumentDialog repos={followed} initialRepo={repo} onClose={() => setDialog(null)} />
      )}
      {stageChange && (
        <StageDialog
          change={stageChange}
          onClose={() => setStageChange(null)}
          onConfirm={async (note) => {
            const { issue, stage } = stageChange;
            await save(
              issue,
              { stage: stage.id, ...(note ? { stage_note: note } : {}) },
              `#${issue.number} passée à « ${stage.label} » (historisé en commentaire).`,
            );
            setStageChange(null);
          }}
        />
      )}
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

/* ---------- Menu « Affichage » (à la Linear) ---------- */

function DisplayMenu({ prefs, setPrefs }: { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" icon="settings" title="Regroupement, tri et colonnes">
          Affichage
        </Button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-[70vh] w-[230px] overflow-y-auto">
        <MenuLabel>Grouper par</MenuLabel>
        <MenuRadioGroup
          value={prefs.groupBy}
          onValueChange={(v) => setPrefs({ groupBy: v as GroupBy })}
        >
          {groupings.map((g) => (
            <MenuRadioItem key={g.id} value={g.id}>
              {g.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>Trier par</MenuLabel>
        <MenuRadioGroup
          value={prefs.sort}
          onValueChange={(v) => setPrefs({ sort: v as IssueSort })}
        >
          {issueSorts.map((s) => (
            <MenuRadioItem key={s.id} value={s.id}>
              <span title={s.title}>{s.label}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>Colonnes</MenuLabel>
        {columns.map((c) => (
          <MenuCheckboxItem
            key={c.id}
            checked={!prefs.hidden.includes(c.id)}
            onCheckedChange={(on) =>
              setPrefs({
                hidden: on ? prefs.hidden.filter((h) => h !== c.id) : [...prefs.hidden, c.id],
              })
            }
          >
            {c.label}
          </MenuCheckboxItem>
        ))}
        <MenuSeparator />
        <MenuCheckboxItem checked={prefs.tree} onCheckedChange={(tree) => setPrefs({ tree })}>
          Arbre des catégories
        </MenuCheckboxItem>
        <MenuItem onSelect={() => setPrefs({ collapsed: [] })}>
          <Icon name="chevronDown" size={13} /> Déplier tous les groupes
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/* ---------- Arbre des catégories ---------- */

function CategoryTree({
  domains,
  counts,
  total,
  filter,
  onFilter,
  onHide,
}: {
  domains: DomainView[] | null;
  counts: ReturnType<typeof countByCategory>;
  total: number;
  filter: CategoryFilter;
  onFilter: (f: CategoryFilter) => void;
  onHide: () => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const active = (f: CategoryFilter) =>
    f.kind === filter.kind && ("id" in f ? "id" in filter && f.id === filter.id : true);
  const node = (
    f: CategoryFilter,
    label: ReactNode,
    count: number,
    extra: { color?: string; indent?: boolean; muted?: boolean; title?: string } = {},
  ) => (
    <button
      type="button"
      onClick={() => onFilter(active(f) && f.kind !== "all" ? { kind: "all" } : f)}
      title={extra.title}
      aria-pressed={active(f)}
      className={cn(
        "flex h-[28px] w-full min-w-0 items-center gap-2 rounded-control pr-2 text-left text-body-sm",
        extra.indent ? "pl-[30px]" : "pl-2",
        active(f) ? "bg-p3 font-medium text-tx" : "text-tx2 hover:bg-p2 hover:text-tx",
        extra.muted && !active(f) && "text-tx3",
      )}
    >
      {extra.color && (
        <span
          className={cn("shrink-0 rounded-full", extra.indent ? "size-1.5" : "size-2")}
          style={{ background: extra.color }}
        />
      )}
      <span className="min-w-0 grow truncate">{label}</span>
      <span className="mono shrink-0 text-tiny text-tx3">{count || ""}</span>
    </button>
  );

  return (
    <aside className="flex w-[244px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-10 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-micro font-semibold tracking-[0.09em] text-tx3 uppercase">
          Catégories
        </span>
        <Button
          size="xs"
          variant="quiet"
          icon="close"
          iconOnly
          aria-label="Masquer l'arbre"
          onClick={onHide}
        />
      </div>
      <nav className="min-h-0 grow overflow-y-auto px-2 pb-3">
        {node({ kind: "all" }, "Toutes les issues", total)}
        <div className="my-1.5 h-px bg-line" />
        {!domains && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-caption text-tx3">
            <Spinner size={11} /> Lecture des catégories…
          </div>
        )}
        {domains
          ?.filter((d) => !d.hidden || (counts.domains.get(d.id) ?? 0) > 0)
          .map((d) => {
            const used = d.categories.filter((c) => (counts.categories.get(c.id) ?? 0) > 0);
            const expanded = open[d.id] ?? (filter.kind !== "all" && filterTouches(filter, d));
            return (
              <div key={d.id} className="flex flex-col">
                <div className="flex items-center">
                  <button
                    type="button"
                    aria-label={expanded ? `Replier ${d.label}` : `Déplier ${d.label}`}
                    aria-expanded={expanded}
                    onClick={() => setOpen((o) => ({ ...o, [d.id]: !expanded }))}
                    disabled={used.length === 0}
                    className="flex size-[22px] shrink-0 items-center justify-center rounded-control text-tx3 hover:bg-p2 hover:text-tx disabled:opacity-0"
                  >
                    <span className={cn("flex transition-transform", !expanded && "-rotate-90")}>
                      <Icon name="chevronDown" size={12} />
                    </span>
                  </button>
                  <div className="min-w-0 grow">
                    {node({ kind: "domain", id: d.id }, d.label, counts.domains.get(d.id) ?? 0, {
                      color: d.color,
                      muted: (counts.domains.get(d.id) ?? 0) === 0,
                      title: d.description,
                    })}
                  </div>
                </div>
                {expanded &&
                  used.map((c) => (
                    <div key={c.id}>
                      {node(
                        { kind: "category", id: c.id },
                        c.label,
                        counts.categories.get(c.id) ?? 0,
                        {
                          color: d.color,
                          indent: true,
                          title: c.description,
                        },
                      )}
                    </div>
                  ))}
              </div>
            );
          })}
        <div className="my-1.5 h-px bg-line" />
        {node({ kind: "none" }, "Sans catégorie", counts.none, {
          color: NO_CATEGORY_COLOR,
          muted: counts.none === 0,
        })}
      </nav>
      <div className="shrink-0 border-t border-line p-2">
        <Button
          size="sm"
          variant="ghost"
          icon="settings"
          className="w-full justify-start"
          onClick={() => void cadence.navigate("categories", { from: "issues" })}
        >
          Gérer les catégories
        </Button>
      </div>
    </aside>
  );
}

function filterTouches(filter: CategoryFilter, domain: DomainView): boolean {
  if (filter.kind === "domain") return filter.id === domain.id;
  if (filter.kind === "category") return domain.categories.some((c) => c.id === filter.id);
  return false;
}

/* ---------- Table groupée ---------- */

function IssueGroupTable({
  group,
  collapsed,
  onToggle,
  template,
  columns: cols,
  onAdd,
  showRepo,
  renderRow,
}: {
  group: IssueGroup<Issue>;
  collapsed: boolean;
  onToggle: () => void;
  template: string;
  columns: Column[];
  onAdd: () => void;
  showRepo: boolean;
  renderRow: (issue: Issue) => ReactNode;
}) {
  const points = pointsOf(group.items);
  return (
    <section className="flex flex-col">
      <div className="sticky left-0 flex h-8 w-fit max-w-full items-center gap-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 rounded-control pr-1.5 hover:bg-p2"
          style={{ color: group.color }}
        >
          <span className={cn("flex transition-transform", collapsed && "-rotate-90")}>
            <Icon name="chevronDown" size={14} />
          </span>
          <span className="font-display text-title-sm font-semibold">{group.label}</span>
        </button>
        {group.hint && <span className="text-caption text-tx3">{group.hint}</span>}
        <span className="text-caption text-tx3">
          {group.items.length} issue{group.items.length > 1 ? "s" : ""}
          {points > 0 && <> · {points} SP</>}
        </span>
        <StatusBattery issues={group.items} />
      </div>
      {!collapsed && (
        <div
          className="mt-1.5 overflow-hidden rounded-card border border-line bg-panel"
          style={{ "--group": group.color } as CSSProperties}
        >
          <div
            className="grid h-8 items-center border-b border-line bg-p2 text-micro font-semibold tracking-[0.06em] text-tx3 uppercase"
            style={{ gridTemplateColumns: template, boxShadow: `inset 4px 0 0 ${group.color}` }}
          >
            <span className="pl-4">#</span>
            <span className="px-2">{showRepo ? "Dépôt · titre" : "Titre"}</span>
            {cols.map((c) => (
              <span key={c} className="truncate px-2">
                {columns.find((k) => k.id === c)?.label}
              </span>
            ))}
            <span />
          </div>
          <div className="divide-y divide-line">{group.items.map(renderRow)}</div>
          <button
            type="button"
            onClick={onAdd}
            className="flex h-8 w-full items-center gap-2 border-t border-line pl-4 text-left text-caption text-tx3 hover:bg-p2 hover:text-tx"
            style={{
              boxShadow: `inset 4px 0 0 color-mix(in srgb, ${group.color} 45%, transparent)`,
            }}
          >
            <Icon name="plus" size={12} /> Ajouter une issue
          </button>
        </div>
      )}
    </section>
  );
}

/** Barre de répartition des états d'un groupe (la « batterie » de Monday). */
function StatusBattery({ issues }: { issues: Issue[] }) {
  const shares = statusShares(issues);
  const total = issues.length;
  if (!total) return null;
  return (
    <span
      className="flex h-2 w-[120px] overflow-hidden rounded-full bg-p3"
      title={shares.map((s) => `${issueStatuses[s.status].label} : ${s.count}`).join(" · ")}
    >
      {shares.map((s) => (
        <span
          key={s.status}
          style={{ width: `${(s.count / total) * 100}%`, background: s.color }}
        />
      ))}
    </span>
  );
}

/* ---------- Ligne ---------- */

function IssueRow({
  issue,
  color,
  template,
  columns: cols,
  showRepo,
  domains,
  index,
  run,
  onOpen,
  onComplete,
  onImplement,
  onStatus,
  onPriority,
  onCategory,
  onStage,
}: {
  issue: Issue;
  color: string;
  template: string;
  columns: Column[];
  showRepo: boolean;
  domains: DomainView[] | null;
  index: Map<string, CategoryRef>;
  run?: RunUpdate;
  onOpen: () => void;
  onComplete: () => void;
  onImplement: () => void;
  onStatus: (status: IssueStatus) => void;
  onPriority: (priority: number | null) => void;
  onCategory: (category: string | null) => void;
  onStage: (stage: Stage, from: Stage | null) => void;
}) {
  const running = run && (run.status === "queued" || run.status === "running");
  const labels = displayLabels(issue.labels);
  const cell = (c: Column): ReactNode => {
    switch (c) {
      case "category":
        return <CategoryCell issue={issue} domains={domains} index={index} onChange={onCategory} />;
      case "status":
        return <StatusCell status={issue.status} onChange={onStatus} />;
      case "stage":
        return <StageCell issue={issue} index={index} onChange={onStage} />;
      case "priority":
        return <PriorityCell priority={issue.priority} onChange={onPriority} />;
      case "points":
        return (
          <span className="mono px-2 text-caption text-tx2">
            {issue.points ?? issue.estimate ?? <span className="text-tx3">–</span>}
          </span>
        );
      case "milestone":
        return issue.milestone ? (
          <span className="px-2">
            <Badge mono tone="clay">
              {issue.milestone}
            </Badge>
          </span>
        ) : (
          <span className="px-2 text-caption text-tx3">–</span>
        );
      case "assignees":
        return (
          <span className="flex px-2">
            {issue.assignees.length === 0 && <span className="text-caption text-tx3">–</span>}
            {issue.assignees.slice(0, 3).map((a, i) => (
              <Avatar
                key={a}
                initials={initialsOf(a)}
                size={20}
                tone="neutral"
                title={a}
                className={cn("ring-2 ring-panel", i > 0 && "-ml-1.5")}
              />
            ))}
          </span>
        );
    }
  };
  return (
    <div
      className="group grid min-h-[40px] items-center hover:bg-p2/60"
      style={{ gridTemplateColumns: template, boxShadow: `inset 4px 0 0 ${color}` }}
    >
      <span className="mono pl-4 text-tiny text-tx3">#{issue.number}</span>
      <div className="min-w-0 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {showRepo && (
            <span className="mono shrink-0 text-caption text-tx3" title={issue.repo}>
              {repoShortName(issue.repo)}
            </span>
          )}
          <button
            className="min-w-0 truncate text-left text-body text-tx hover:text-clay"
            onClick={onOpen}
            title={issue.title}
          >
            {issue.title}
          </button>
          {issue.type && (
            <span className="mono shrink-0 text-tiny text-tx3" title="Type (label type/*)">
              {issue.type}
            </span>
          )}
          {labels.slice(0, 2).map((l) => (
            <Badge key={l} tone="neutral" className="hidden xl:inline-flex">
              {l}
            </Badge>
          ))}
          {issue.comments > 0 && (
            <span
              className="flex shrink-0 items-center gap-1 text-tiny text-tx3"
              title="Commentaires"
            >
              <Icon name="review" size={11} />
              {issue.comments}
            </span>
          )}
        </div>
        {run && (
          <div className="mt-0.5 flex items-center gap-1.5 text-caption text-tx3">
            {running && <Spinner size={11} />}
            Implémentation : {run.message ?? run.status}
          </div>
        )}
      </div>
      {cols.map((c) => (
        <div key={c} className="min-w-0">
          {cell(c)}
        </div>
      ))}
      <div className="flex justify-end gap-0.5 pr-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {issue.state === "open" && (
          <>
            <Button
              size="xs"
              variant="quiet"
              icon="sparkle"
              iconOnly
              aria-label="Compléter avec l'IA"
              title="Compléter avec l'IA"
              onClick={onComplete}
            />
            <Button
              size="xs"
              variant="quiet"
              icon="play"
              iconOnly
              aria-label="Implémenter"
              title="Implémenter"
              onClick={onImplement}
              disabled={running}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** Déclencheur de cellule éditable : prend toute la cellule, comme dans Monday. */
function CellTrigger({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <MenuTrigger asChild>
      <button
        type="button"
        title={title}
        className="flex h-[40px] w-full min-w-0 items-center px-2 text-left outline-none hover:bg-p3/60 focus-visible:bg-p3"
      >
        {children}
      </button>
    </MenuTrigger>
  );
}

function CategoryCell({
  issue,
  domains,
  index,
  onChange,
}: {
  issue: Issue;
  domains: DomainView[] | null;
  index: Map<string, CategoryRef>;
  onChange: (category: string | null) => void;
}) {
  const ref = issue.category ? index.get(issue.category) : undefined;
  return (
    <Menu>
      <CellTrigger
        title={ref ? `${ref.domain.label} › ${ref.category.label}` : "Choisir une catégorie"}
      >
        {ref ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: ref.domain.color }}
            />
            <span className="truncate text-body-sm text-tx">{ref.category.label}</span>
          </span>
        ) : issue.category ? (
          <span className="mono truncate text-caption text-tx3">{issue.category}</span>
        ) : (
          <span className="text-caption text-tx3 opacity-0 group-hover:opacity-100">
            + Catégorie
          </span>
        )}
      </CellTrigger>
      <MenuContent className="max-h-[380px] w-[260px] overflow-y-auto">
        <MenuRadioGroup
          value={issue.category ?? ""}
          onValueChange={(v) => v !== (issue.category ?? "") && onChange(v || null)}
        >
          <MenuRadioItem value="">
            <span className="text-tx3">Sans catégorie</span>
          </MenuRadioItem>
          {pickable(domains ?? [], issue.category).map((d) => (
            <div key={d.id}>
              <MenuSeparator />
              <MenuLabel>
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full" style={{ background: d.color }} />
                  {d.label}
                </span>
              </MenuLabel>
              {d.categories.map((c) => (
                <MenuRadioItem key={c.id} value={c.id}>
                  <span title={c.description}>{c.label}</span>
                </MenuRadioItem>
              ))}
            </div>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function StatusCell({
  status,
  onChange,
}: {
  status: IssueStatus;
  onChange: (s: IssueStatus) => void;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          title="Changer l'état"
          className="flex h-[40px] w-full items-center justify-center text-caption font-semibold text-ink outline-none hover:brightness-110 focus-visible:brightness-125"
          style={{ background: statusColorOf(status) }}
        >
          {issueStatuses[status].label}
        </button>
      </MenuTrigger>
      <MenuContent className="w-[180px]">
        {statusOrder.map((s) => (
          <MenuItem key={s} onSelect={() => onChange(s)}>
            <span className="size-2.5 rounded-[3px]" style={{ background: statusColorOf(s) }} />
            {issueStatuses[s].label}
            {s === status && (
              <span className="ml-auto flex text-clay">
                <Icon name="check" size={13} />
              </span>
            )}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function StageCell({
  issue,
  index,
  onChange,
}: {
  issue: Issue;
  index: Map<string, CategoryRef>;
  onChange: (stage: Stage, from: Stage | null) => void;
}) {
  const pipeline = pipelineOf(index, issue.category);
  if (!pipeline) return <span className="px-2 text-caption text-tx3">–</span>;
  const at = pipeline.findIndex((s) => s.id === issue.stage);
  const current = at >= 0 ? pipeline[at]! : null;
  const color = (issue.category && index.get(issue.category)?.domain.color) || NO_CATEGORY_COLOR;
  return (
    <Menu>
      <CellTrigger title="Changer d'étape (historisé en commentaire)">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-body-sm text-tx">{current?.label ?? "—"}</span>
          <span className="flex gap-[3px]">
            {pipeline.map((s, i) => (
              <span
                key={s.id}
                className="h-[3px] w-3 rounded-full"
                style={{ background: i <= at ? color : "var(--color-p4)" }}
              />
            ))}
          </span>
        </span>
      </CellTrigger>
      <MenuContent className="w-[220px]">
        <MenuLabel>Étape</MenuLabel>
        {pipeline.map((s, i) => (
          <MenuItem key={s.id} onSelect={() => s.id !== issue.stage && onChange(s, current)}>
            <span className="mono w-4 text-tiny text-tx3">{i + 1}</span>
            {s.label}
            {s.id === issue.stage && (
              <span className="ml-auto flex text-clay">
                <Icon name="check" size={13} />
              </span>
            )}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function PriorityCell({
  priority,
  onChange,
}: {
  priority: number | null;
  onChange: (p: number | null) => void;
}) {
  const info = priority !== null && priority !== undefined ? priorityInfo(priority) : null;
  return (
    <Menu>
      <CellTrigger title={info?.title ?? "Choisir une priorité"}>
        {info ? (
          <Badge tone={info.tone}>{priority === 0 ? "P0" : info.label}</Badge>
        ) : (
          <span className="text-caption text-tx3">–</span>
        )}
      </CellTrigger>
      <MenuContent className="w-[200px]">
        <MenuRadioGroup
          value={priority === null || priority === undefined ? "" : String(priority)}
          onValueChange={(v) => onChange(v === "" ? null : Number(v))}
        >
          {[0, 1, 2, 3, 4, 5].map((p) => (
            <MenuRadioItem key={p} value={String(p)}>
              {priorityInfo(p).label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/* ---------- Changement d'étape ---------- */

function StageDialog({
  change,
  onClose,
  onConfirm,
}: {
  change: StageChange;
  onClose: () => void;
  onConfirm: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const { issue, stage, from } = change;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onConfirm(note.trim()).finally(() => setBusy(false));
        }}
      >
        <DialogHeader
          title={`Passer à « ${stage.label} »`}
          icon="arrowRight"
          meta={`#${issue.number}`}
        />
        <DialogBody className="flex flex-col gap-3">
          <p className="text-body-sm text-tx2">
            {from ? (
              <>
                {from.label} → <span className="text-tx">{stage.label}</span>
              </>
            ) : (
              stage.label
            )}{" "}
            — {issue.title}
          </p>
          <Field
            label="Note pour l'historique"
            htmlFor={noteId}
            aside="facultative"
            hint="Ajoutée au commentaire qui trace le changement : date d'envoi, destinataire, réponse reçue, suite à donner…"
          >
            <Textarea
              id={noteId}
              rows={4}
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={"Envoyé à Paul (DSI) le 29/10.\nRéponse : …"}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <div className="grow" />
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" variant="primary" disabled={busy} icon={busy ? undefined : "check"}>
            {busy && <Spinner />}
            Valider l'étape
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
