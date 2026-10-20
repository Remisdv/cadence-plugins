/**
 * Sprint en cours (maquette Main.dc.html de Cadence 1) : KPI du sprint, kanban des issues par
 * état, burndown et retard sur la droite idéale. Tout vient de l'outil `sprint_summary`.
 *
 * Sprints automatiques : « Démarrer le projet » (durée, capacité, version) crée l'issue d'état
 * partagée et le premier sprint ; ensuite la barre du projet met en pause, reprend et change la
 * durée (`project_*`), et liste la livraison des sprints terminés (release/x → branche par
 * défaut). Sans sprints automatiques : milestone daté ouvert le plus proche. En mode « Tous les
 * dépôts », un sprint par dépôt suivi.
 *
 * Les conversations lancées depuis le sprint (« Développer le sprint », « Implémenter », « Relire »)
 * portent le groupe `sprint:<repo>:<n° du milestone>` : Cadence les masque du chat global, la
 * section « Conversations du sprint » les liste (`conversations.list`) et les ouvre. La colonne
 * « En revue » se sélectionne : « Relire » une tâche ou « Relire la sélection » ouvre une seule
 * conversation `relire-valider` (revue, accord de l'utilisateur, puis fusion et clôture).
 */
import { useCallback, useEffect, useState } from "react";
import {
  cadence,
  isCadenceError,
  type ActionGroup,
  type ConversationInfo,
} from "@cadence/plugin-sdk";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Field,
  Icon,
  Input,
  Select,
  Spinner,
  StatusDot,
  cn,
} from "@cadence/ui";
import {
  actionLabel,
  aiLabel,
  conversationIssues,
  conversationStates,
  isStarted,
  pullRequestFor,
  reviewContext,
  sprintGroup,
  withGroup,
  type Issue,
  type ProjectView,
  type PullRequestList,
  type SprintSummary,
  type StartDefaults,
  type Version,
} from "../domain";
import {
  Burndown,
  EmptyCard,
  KanbanColumn,
  Loading,
  MeterList,
  NoRepos,
  PageHeader,
  RepoHeading,
  SelectionLabel,
  StatCard,
  TextLink,
  ToolError,
} from "../components";
import {
  daysLeftLabel,
  delayLabel,
  durationLabel,
  durationOptions,
  formatAgo,
  formatDay,
  formatDecimal,
  formatPercent,
  formatRange,
  gainedToday,
  plural,
  releaseInfo,
  requiredPace,
  sprintBoard,
  statusMeters,
} from "../planning";
import { useConversations } from "../useConversations";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

const notifyError = (e: unknown) =>
  void cadence.notify(isCadenceError(e) ? e.message : String(e), "error");

export function SprintView() {
  const { repos, repo, shown, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  // Sprint affiché par dépôt : « Développer le sprint » rattache sa conversation à ce sprint.
  const [sprints, setSprints] = useState<Record<string, Pick<Version, "number" | "title"> | null>>(
    {},
  );
  const onSprint = useCallback((r: string, v: Pick<Version, "number" | "title"> | null) => {
    setSprints((all) =>
      all[r]?.number === v?.number && all[r]?.title === v?.title ? all : { ...all, [r]: v },
    );
  }, []);
  const sprint = repo ? sprints[repo] : null;
  const group = repo && sprint ? sprintGroup(repo, sprint) : null;
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="sprint"
        title="Sprint en cours"
        subtitle={repos && <SelectionLabel repo={repo} count={shown.length} />}
      >
        <Button
          size="sm"
          icon="play"
          disabled={!repo}
          title={
            repo
              ? "L'IA développe les issues à faire du sprint, par priorité : une PR par issue"
              : "Choisissez un dépôt"
          }
          onClick={() =>
            void cadence
              .runAction("developper-sprint", { repo, ...withGroup(group) })
              .catch(notifyError)
          }
        >
          Développer le sprint
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={() => setTick((t) => t + 1)}
          disabled={!ready}
        />
      </PageHeader>
      <main className="min-h-0 grow overflow-y-auto p-5">
        {error && <ToolError message={error.message} />}
        {repos && repos.length === 0 && <NoRepos />}
        <div className="flex flex-col gap-8">
          {shown.map((r) => (
            <SprintPanel
              key={r}
              repo={r}
              heading={!repo}
              refreshKey={String(tick)}
              onSprint={onSprint}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function SprintPanel({
  repo,
  heading,
  refreshKey,
  onSprint,
}: {
  repo: string;
  heading: boolean;
  refreshKey: string;
  onSprint: (repo: string, sprint: Pick<Version, "number" | "title"> | null) => void;
}) {
  const { data, error, loading, reload } = useTool<SprintSummary>(
    "sprint_summary",
    { repo },
    refreshKey,
  );
  const current = data?.repo === repo ? data : null;
  const shownSprint = current?.sprint && current.pace ? current.sprint : null;
  useEffect(() => {
    if (current) onSprint(repo, shownSprint);
  }, [repo, current, shownSprint?.number, shownSprint?.title, onSprint]);
  // Une issue d'état « idle » (créée par les jalons de la roadmap) n'est pas un projet démarré :
  // l'écran propose alors « Démarrer le projet », pas la barre des sprints.
  const project = isStarted(current?.project) ? current.project : null;

  let body;
  if (error) body = <ToolError message={error.message} className="mb-0" />;
  else if (!current) body = loading ? <Loading label="Lecture du sprint…" /> : null;
  else if (!current.sprint || !current.pace) {
    body = project ? (
      <EmptyCard icon="sprint" title="Sprint en préparation">
        {current.message}
      </EmptyCard>
    ) : null;
  } else body = <Sprint summary={current} refreshKey={refreshKey} />;

  return (
    <section className="flex flex-col gap-3.5">
      {heading && <RepoHeading repo={repo} />}
      {current?.project_error && (
        <Callout tone="warning">Sprints automatiques : {current.project_error}</Callout>
      )}
      {current && !project && (
        <StartProject
          repo={repo}
          defaults={current.start_defaults ?? startDefaults(current)}
          onDone={reload}
        />
      )}
      {project && <ProjectBar repo={repo} project={project} onDone={reload} />}
      {body}
      {project && project.sprints.length > 1 && <Deliveries project={project} />}
    </section>
  );
}

/** Valeurs de « Démarrer le projet » quand le serveur n'en donne pas : 10 SP par semaine. */
function startDefaults(summary: SprintSummary): StartDefaults {
  const days = summary.project?.duration_days ?? summary.sprint_length_days;
  return {
    duration_days: days,
    capacity: Math.max(1, Math.round((days * 10) / 7)),
    first_version: "0.1.0",
  };
}

/** Appelle un outil `project_*` ; l'erreur est rendue en français par le serveur. */
function useProjectAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (tool: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await cadence.call(tool, args);
      onDone();
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** « Démarrer le projet » : durée, capacité du premier sprint, version. */
function StartProject({
  repo,
  defaults,
  onDone,
}: {
  repo: string;
  defaults: StartDefaults;
  onDone: () => void;
}) {
  const [days, setDays] = useState(defaults.duration_days);
  const [capacity, setCapacity] = useState(String(defaults.capacity));
  const [version, setVersion] = useState(defaults.first_version);
  const { busy, error, run } = useProjectAction(onDone);
  const points = Number(capacity);
  const valid = Number.isInteger(points) && points > 0 && version.trim() !== "";

  return (
    <Card className="flex flex-col gap-4 px-5 py-[18px]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex text-clay">
          <Icon name="rocket" size={18} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-title-sm font-semibold">Démarrer le projet</h2>
          <p className="max-w-[640px] text-body-sm leading-[1.6] text-tx3">
            Cadence crée les sprints tout seul : chaque sprint est une version (branche{" "}
            <span className="mono">release/{version || "x.y.z"}</span>) remplie avec les issues sans
            version, par priorité, dans la limite de sa capacité. La capacité suit ensuite le rythme
            réel de l'équipe ; les issues non terminées passent au sprint suivant et la branche de
            release est fusionnée dans la branche par défaut quand la CI est verte.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Durée d'un sprint" htmlFor={`${repo}-duree`} hint="modifiable à tout moment">
          <Select
            id={`${repo}-duree`}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={busy}
          >
            {durationOptions(defaults.duration_days).map((d) => (
              <option key={d} value={d}>
                {durationLabel(d)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Capacité du premier sprint"
          htmlFor={`${repo}-capacite`}
          hint="story points ; ensuite, le rythme réel"
        >
          <Input
            id={`${repo}-capacite`}
            size="md"
            mono
            inputMode="numeric"
            className="w-[120px]"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={busy}
          />
        </Field>
        <Field
          label="Version du premier sprint"
          htmlFor={`${repo}-version`}
          hint="puis 0.x+1.0 à chaque sprint"
        >
          <Input
            id={`${repo}-version`}
            size="md"
            mono
            className="w-[120px]"
            value={version}
            onChange={(e) => setVersion(e.target.value.trim())}
            disabled={busy}
          />
        </Field>
        <div className="grow" />
        <Button
          variant="primary"
          icon="play"
          disabled={!valid || busy}
          onClick={() =>
            void run("project_start", {
              repo,
              duration_days: days,
              capacity: points,
              first_version: version,
            })
          }
        >
          {busy ? "Démarrage…" : "Démarrer le projet"}
        </Button>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
    </Card>
  );
}

/** Barre des sprints automatiques : état, pause / reprise, durée, capacité, issue d'état. */
function ProjectBar({
  repo,
  project,
  onDone,
}: {
  repo: string;
  project: ProjectView;
  onDone: () => void;
}) {
  const { busy, error, run } = useProjectAction(onDone);
  const paused = project.status === "paused";
  return (
    <div className="flex flex-col gap-2">
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-[15px] py-[11px]">
        <Badge tone={paused ? "amber" : "green"} dot>
          {paused
            ? `En pause${project.paused_since ? ` depuis le ${formatDay(project.paused_since)}` : ""}`
            : "Sprints automatiques"}
        </Badge>
        <span className="text-caption text-tx3">
          {[
            project.capacity !== null ? `capacité ${project.capacity} SP` : null,
            `rythme ${formatDecimal(project.points_per_day)} SP / jour`,
            project.release_branch,
            project.carried.length > 0
              ? `${plural(project.carried.length, "issue reportée", "issues reportées")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <div className="grow" />
        <label className="flex items-center gap-2 text-caption text-tx3">
          Durée
          <Select
            size="sm"
            value={project.duration_days}
            disabled={busy}
            onChange={(e) =>
              void run("project_set_duration", { repo, duration_days: Number(e.target.value) })
            }
          >
            {durationOptions(project.duration_days).map((d) => (
              <option key={d} value={d}>
                {durationLabel(d)}
              </option>
            ))}
          </Select>
        </label>
        <Button
          size="sm"
          variant={paused ? "primary" : "secondary"}
          icon={paused ? "play" : "pause"}
          disabled={busy}
          onClick={() => void run(paused ? "project_resume" : "project_pause", { repo })}
        >
          {paused ? "Reprendre" : "Mettre en pause"}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          icon="link"
          iconOnly
          aria-label={`Issue d'état #${project.issue}`}
          title={`Issue d'état partagée #${project.issue} (masquée dans les issues)`}
          onClick={() => void cadence.openExternal(project.url)}
        />
      </Card>
      {paused && (
        <Callout tone="warning">
          Sprints en pause : Cadence ne remplit plus et ne clôt plus les sprints. À la reprise,
          l'échéance du sprint en cours est repoussée de la durée de la pause.
        </Callout>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  );
}

/** Sprints terminés : story points livrés et fusion de leur branche de release. */
function Deliveries({ project }: { project: ProjectView }) {
  const ended = project.sprints.filter((s) => s.ended_on);
  if (ended.length === 0) return null;
  return (
    <Card className="px-[15px] py-3.5">
      <CardHeader
        title="Sprints terminés"
        actions={<Badge tone="neutral">release/x → défaut</Badge>}
      />
      <div className="mt-2 divide-y divide-line">
        {ended.map((s) => {
          const info = releaseInfo(s.release);
          return (
            <div key={s.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="mono w-[64px] text-body-sm text-tx">{s.version}</span>
              <span className="text-caption text-tx3">
                {formatRange(s.start_on, s.ended_on ?? s.due_on)}
              </span>
              <span className="mono text-caption text-tx2">
                {s.done_points ?? 0} / {s.capacity} SP
              </span>
              <div className="grow" />
              {info.detail && (
                <span className="max-w-[420px] truncate text-caption text-tx3" title={info.detail}>
                  {info.detail}
                </span>
              )}
              <Badge tone={info.tone}>{info.label}</Badge>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Sprint({ summary, refreshKey }: { summary: SprintSummary; refreshKey: string }) {
  const v = summary.sprint!;
  const pace = summary.pace!;
  const issues = summary.issues ?? [];
  const repo = summary.repo;
  const group = sprintGroup(repo, v);

  // PR ouvertes du dépôt : la PR de chaque tâche en revue (celle qui déclare fermer l'issue).
  const pulls = useTool<PullRequestList>(
    "list_pull_requests",
    { repo, state: "open" },
    refreshKey,
  );
  const openPulls = pulls.data?.repo === repo ? pulls.data.pull_requests : [];
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [launching, setLaunching] = useState(false);
  const inReview = issues.filter((i) => i.status === "review");
  // La sélection ne garde que les tâches encore en revue (après un rafraîchissement).
  const selected = new Set([...picked].filter((n) => inReview.some((i) => i.number === n)));
  const toggle = (issue: Issue) =>
    setPicked((s) => {
      const next = new Set(s);
      if (!next.delete(issue.number)) next.add(issue.number);
      return next;
    });
  const review = async (tasks: Issue[]) => {
    if (tasks.length === 0) return;
    setLaunching(true);
    try {
      const items = tasks.map((i) => ({
        issue: i.number,
        pr: pullRequestFor(openPulls, i)?.number ?? null,
      }));
      await cadence.runAction("relire-valider", reviewContext(repo, items, group));
      setPicked(new Set());
    } catch (e) {
      notifyError(e);
    } finally {
      setLaunching(false);
    }
  };
  const reviewControls = {
    selected,
    onToggle: toggle,
    onToggleAll: (list: Issue[], select: boolean) =>
      setPicked(select ? new Set(list.map((i) => i.number)) : new Set()),
    onReview: (issue: Issue) => void review([issue]),
    pullRequestOf: (issue: Issue) => pullRequestFor(openPulls, issue),
    disabled: launching,
  };
  const remaining = pace.total - pace.closed;
  const required = requiredPace(remaining, pace.days_left);
  const delay = delayLabel(pace.delay_days);
  const gain = gainedToday(pace.burndown, pace.total);
  const openVersion = () =>
    void cadence.navigate("versions", { repo: summary.repo, version: v.title });

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="font-display text-title-sm font-semibold">
          Sprint {v.title}
          {v.name ? ` — ${v.name}` : ""}
        </h2>
        <span className="text-caption text-tx3">
          {[
            formatRange(pace.start_on, pace.due_on),
            daysLeftLabel(pace.days_left),
            `milestone #${v.number}`,
          ].join(" · ")}
        </span>
        <div className="grow" />
        <Button size="sm" variant="ghost" icon="tag" onClick={openVersion}>
          Détail de la version
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <StatCard
          label="Portée"
          value={pace.total}
          hint={
            pace.points_total > 0
              ? `issues · ${plural(pace.closed, "fermée")} · ${pace.points_done}/${pace.points_total} SP`
              : `issues · ${plural(pace.closed, "fermée")}`
          }
        />
        <StatCard
          label="Avancement"
          value={formatPercent(pace.progress)}
          hint={pace.burndown.length > 1 ? `+${gain} aujourd'hui` : undefined}
          tone="clay"
        />
        <StatCard
          label="Restantes"
          value={remaining}
          hint={
            required !== null
              ? `${formatDecimal(required)} / jour requis`
              : daysLeftLabel(pace.days_left)
          }
          tone="amber"
        />
        <StatCard
          label="Rythme"
          value={formatDecimal(pace.velocity)}
          hint="issues fermées / jour"
          tone="blue"
        />
        <StatCard
          label="Retard"
          value={pace.burndown.length > 0 ? formatDecimal(Math.abs(pace.delay_days)) : "—"}
          hint={pace.burndown.length > 0 ? delay.text : "pas encore commencé"}
          tone={delay.tone === "amber" ? "amber" : delay.tone === "green" ? "green" : "tx"}
        />
      </div>

      <div className="flex flex-wrap gap-3.5">
        <Card className="flex min-h-[320px] min-w-[420px] flex-[1_1_560px] flex-col px-[15px] py-[13px]">
          <CardHeader
            title="Tableau du sprint"
            actions={
              <>
                <Badge tone="neutral">Groupé par état</Badge>
                <TextLink onClick={() => void cadence.navigate("issues")}>
                  Voir toutes les issues
                </TextLink>
              </>
            }
          />
          {selected.size > 0 && (
            <div className="mt-[11px] flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-field border border-blue-line bg-blue-d px-3 py-2">
              <Icon name="review" size={14} className="text-blue" />
              <span className="text-body-sm text-tx">
                {plural(selected.size, "tâche sélectionnée", "tâches sélectionnées")}
              </span>
              <span className="text-caption text-tx3">
                une seule conversation relit tout, puis fusionne après votre accord
              </span>
              <div className="grow" />
              <Button
                size="xs"
                variant="quiet"
                onClick={() => setPicked(new Set())}
                disabled={launching}
              >
                Désélectionner
              </Button>
              <Button
                size="xs"
                variant="primary"
                icon="review"
                disabled={launching}
                onClick={() => void review(inReview.filter((i) => selected.has(i.number)))}
              >
                Relire la sélection ({selected.size})
              </Button>
            </div>
          )}
          {issues.length === 0 ? (
            <p className="mt-4 text-body-sm leading-[1.6] text-tx3">
              Aucune issue dans ce sprint. Les issues rattachées au milestone {v.title} apparaissent
              ici, rangées par état (labels status/*).
            </p>
          ) : (
            <div className="mt-[13px] flex min-h-0 grow items-start gap-[11px] overflow-x-auto">
              {sprintBoard(issues).map((col) => (
                <KanbanColumn
                  key={col.status}
                  column={col}
                  review={col.status === "review" ? reviewControls : undefined}
                />
              ))}
            </div>
          )}
        </Card>

        <div className="flex w-[330px] shrink-0 grow-0 flex-col gap-3 max-[900px]:w-full">
          <Card className="px-[15px] py-3.5">
            <div className="flex items-center gap-2">
              <h3 className="text-body">Burndown</h3>
              <div className="grow" />
              {pace.burndown.length > 0 && (
                <span
                  className={cn(
                    "text-tiny",
                    delay.tone === "amber"
                      ? "text-amber"
                      : delay.tone === "green"
                        ? "text-green"
                        : "text-tx3",
                  )}
                >
                  {delay.text}
                </span>
              )}
            </div>
            <div className="mt-3">
              {pace.start_on && pace.due_on && pace.burndown.length > 0 ? (
                <Burndown
                  points={pace.burndown}
                  scope={pace.total}
                  start={pace.start_on}
                  end={pace.due_on}
                  days={(pace.length_days ?? summary.sprint_length_days) + 1}
                  label={`Burndown du sprint ${v.title}`}
                />
              ) : (
                <p className="text-caption leading-[1.6] text-tx3">
                  Le burndown commence au premier jour du sprint
                  {pace.start_on ? ` (${formatRange(pace.start_on, null)})` : ""}.
                </p>
              )}
            </div>
            <p className="mt-2.5 text-tiny leading-[1.6] text-tx3">
              {summary.project
                ? `Sprint automatique de ${durationLabel(summary.project.duration_days)}, branche ${summary.project.release_branch ?? ""}.`
                : `Sprint de ${plural(summary.sprint_length_days, "jour")} (réglages du plugin) se terminant à l'échéance du milestone.`}
            </p>
          </Card>
          <Card className="px-[15px] py-3.5">
            <h3 className="text-body">Progression</h3>
            <MeterList className="mt-[13px]" items={statusMeters(pace.counts)} />
          </Card>
        </div>
      </div>

      <SprintConversations group={group} refreshKey={refreshKey} />
    </div>
  );
}

/**
 * Conversations rattachées au sprint (masquées du chat global) : état, titre, issues, IA, date ;
 * une ligne s'ouvre dans la vue Chat de Cadence.
 */
function SprintConversations({ group, refreshKey }: { group: ActionGroup; refreshKey: string }) {
  const { conversations, error } = useConversations(group.id, refreshKey);
  const list = conversations ?? [];
  const running = list.filter((c) => c.state === "running").length;
  const open = (c: ConversationInfo) => void cadence.conversations.open(c.id).catch(notifyError);
  return (
    <Card className="px-[15px] py-3.5">
      <CardHeader
        title="Conversations du sprint"
        actions={
          <>
            {running > 0 && (
              <Badge tone="clay" dot>
                {plural(running, "en cours", "en cours")}
              </Badge>
            )}
            <Badge tone="neutral">{list.length}</Badge>
          </>
        }
      />
      {error && (
        <Callout tone="danger" className="mt-3">
          {error.message}
        </Callout>
      )}
      {!error && conversations === null && (
        <div className="mt-3">
          <Loading label="Lecture des conversations…" />
        </div>
      )}
      {!error && conversations !== null && list.length === 0 && (
        <p className="mt-2 text-caption leading-[1.6] text-tx3">
          Aucune conversation pour ce sprint. « Développer le sprint », « Implémenter » une issue du
          sprint et « Relire » une tâche en revue ouvrent ici leurs conversations, hors du chat
          global.
        </p>
      )}
      {list.length > 0 && (
        <div className="mt-2 divide-y divide-line">
          {list.map((c) => (
            <ConversationRow key={c.id} conversation={c} onOpen={() => open(c)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ConversationRow({
  conversation: c,
  onOpen,
}: {
  conversation: ConversationInfo;
  onOpen: () => void;
}) {
  const meta = conversationStates[c.state] ?? conversationStates.interrupted;
  const issues = conversationIssues(c);
  const detail = [
    actionLabel(c.action),
    c.mode === "background" ? "en fond" : null,
    aiLabel(c.ai),
    c.turns > 0 ? plural(c.turns, "tour") : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span className="flex w-3.5 shrink-0 justify-center" title={meta.label}>
        {c.state === "running" ? <Spinner size={11} /> : <StatusDot tone={meta.dot} size={7} />}
      </span>
      <button
        type="button"
        onClick={onOpen}
        title="Ouvrir dans le chat"
        className="min-w-0 flex-[1_1_220px] truncate text-left text-body-sm text-tx hover:text-clay"
      >
        {c.title}
      </button>
      {issues.length > 0 && (
        <span className="mono shrink-0 text-tiny text-tx3">
          {issues.slice(0, 3).map((n) => `#${n}`).join(" ")}
          {issues.length > 3 ? ` +${issues.length - 3}` : ""}
        </span>
      )}
      <span className="shrink-0 truncate text-caption text-tx3" title={c.model}>
        {detail.join(" · ")}
      </span>
      <Badge tone={meta.tone}>{meta.label}</Badge>
      <span className="w-[86px] shrink-0 text-right text-caption text-tx3" title={c.updatedAt}>
        {formatAgo(c.updatedAt)}
      </span>
      <Button size="xs" variant="ghost" icon="arrowRight" onClick={onOpen}>
        Ouvrir
      </Button>
    </div>
  );
}
