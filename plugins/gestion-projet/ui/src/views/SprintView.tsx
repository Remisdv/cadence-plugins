/**
 * Sprint en cours (maquette Main.dc.html de Cadence 1) : KPI du sprint, kanban des issues par
 * état, burndown et retard sur la droite idéale. Tout vient de l'outil `sprint_summary`. Une seule
 * mesure partout : les story points (une issue sans estimation compte 3 SP, comme au remplissage).
 *
 * Sprints automatiques : « Démarrer le projet » (durée, capacité, version) crée l'issue d'état
 * partagée et le premier sprint ; ensuite la barre du projet met en pause, reprend, change la
 * durée (au prochain sprint, ou aussi au sprint en cours après confirmation), clôt le sprint en
 * avance (`project_*`), et liste la livraison des sprints terminés (release/x → branche par
 * défaut). Sans sprints automatiques : milestone daté ouvert le plus proche. En mode « Tous les
 * dépôts », un sprint par dépôt suivi (un seul dépôt suivi : il est pris d'office).
 *
 * Portée : « Ajouter des issues » ouvre le carnet (`sprint_backlog`, dans l'ordre de la roadmap
 * puis par priorité) ; on coche des issues ou on les glisse sur le tableau du sprint ; une carte
 * « À faire » se retire du sprint (`sprint_issues`).
 *
 * Les conversations lancées depuis le sprint (« Développer le sprint », « Implémenter », « Relire »)
 * portent le groupe `sprint:<repo>:<n° du milestone>` : Cadence les masque du chat global, la
 * section « Conversations du sprint » les liste (`conversations.list`) et les ouvre ; celles d'un
 * sprint terminé restent accessibles depuis sa ligne dans « Sprints terminés ». La colonne
 * « En revue » se sélectionne : « Relire » une tâche ou « Relire la sélection » ouvre une seule
 * conversation `relire-valider` (revue, accord de l'utilisateur, puis fusion et clôture) ; la PR de
 * chaque tâche est celle qui la déclare fermer ou dont la branche la nomme (`feat/<n>-…`).
 *
 * Fraîcheur (N08, N09) : tout l'écran se relit après chacune de ses écritures, à l'événement
 * `sync.updated` du serveur (écritures de l'IA comprises), à la fin d'une conversation ou d'une
 * exécution, toutes les 20 s tant qu'une conversation du sprint tourne, et au retour sur la vue
 * (`useLiveRefresh`).
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
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
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
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
  priorityInfo,
  reviewContext,
  sprintGroup,
  withGroup,
  type BacklogList,
  type Issue,
  type Pace,
  type ProjectView,
  type PullRequestList,
  type SprintIssuesResult,
  type SprintRecord,
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
  capacityFor,
  carryOver,
  closeSprintLead,
  daysLeftLabel,
  deliveredLabel,
  delayLabel,
  dueFor,
  durationLabel,
  durationOptions,
  formatAgo,
  formatDay,
  formatDecimal,
  formatPercent,
  formatRange,
  gainedToday,
  issueWeight,
  moveMessage,
  plural,
  pointsByStatus,
  releaseInfo,
  requiredPace,
  sprintBoard,
  statusMeters,
} from "../planning";
import { pullRequestFor } from "../issues";
import { useConversations, type ConversationsState } from "../useConversations";
import { refreshWhenDone, useLiveRefresh } from "../useLiveRefresh";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

const notifyError = (e: unknown) =>
  void cadence.notify(isCadenceError(e) ? e.message : String(e), "error");

type SprintRef = Pick<Version, "number" | "title">;

/**
 * Lance « Développer le sprint » sur un dépôt, rattaché au sprint affiché s'il est connu ; l'écran
 * se relit à la fin de l'exécution (`onDone`).
 */
function developSprint(repo: string, sprint: SprintRef | null | undefined, onDone: () => void) {
  const group = sprint ? sprintGroup(repo, sprint) : null;
  cadence
    .runAction("developper-sprint", { repo, ...withGroup(group) })
    .then((runId) => refreshWhenDone(runId, onDone))
    .catch(notifyError);
}

const DEVELOP_TITLE =
  "L'IA développe les issues à faire du sprint, par priorité : une PR par issue";

export function SprintView() {
  const { repos, repo, shown, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // Dépôts dont une conversation du sprint tourne : relecture de secours toutes les 20 s.
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const onRunning = useCallback((r: string, busy: boolean) => {
    setRunning((all) => {
      if (all.has(r) === busy) return all;
      const next = new Set(all);
      if (busy) next.add(r);
      else next.delete(r);
      return next;
    });
  }, []);
  useLiveRefresh(shown, refresh, ready && shown.some((r) => running.has(r)));
  // Sprint affiché par dépôt : « Développer le sprint » rattache sa conversation à ce sprint.
  const [sprints, setSprints] = useState<Record<string, SprintRef | null>>({});
  const onSprint = useCallback((r: string, v: SprintRef | null) => {
    setSprints((all) =>
      all[r]?.number === v?.number && all[r]?.title === v?.title ? all : { ...all, [r]: v },
    );
  }, []);
  // « Tous les dépôts » avec un seul dépôt suivi : c'est lui (un seul sprint affiché).
  const target = repo ?? (shown.length === 1 ? shown[0]! : null);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="sprint"
        title="Sprint en cours"
        subtitle={repos && <SelectionLabel repo={repo} count={shown.length} />}
      >
        {target || !ready ? (
          <Button
            size="sm"
            icon="play"
            disabled={!target}
            title={DEVELOP_TITLE}
            onClick={() => target && developSprint(target, sprints[target], refresh)}
          >
            Développer le sprint
          </Button>
        ) : (
          <span className="max-w-[360px] text-right text-caption leading-[1.4] text-tx3">
            {plural(shown.length, "dépôt")} : « Développer » sur le sprint de chacun ci-dessous, ou
            choisissez un dépôt dans le sélecteur.
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={refresh}
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
              developHere={!target}
              refreshKey={String(tick)}
              onRefresh={refresh}
              onRunning={onRunning}
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
  developHere,
  refreshKey,
  onRefresh,
  onRunning,
  onSprint,
}: {
  repo: string;
  heading: boolean;
  /** Plusieurs dépôts affichés : le bouton « Développer » est sur chaque sprint. */
  developHere: boolean;
  refreshKey: string;
  /** Relit tout l'écran (sprint, carnet, PR, conversations), après une écriture par exemple. */
  onRefresh: () => void;
  onRunning: (repo: string, running: boolean) => void;
  onSprint: (repo: string, sprint: SprintRef | null) => void;
}) {
  const { data, error, loading } = useTool<SprintSummary>("sprint_summary", { repo }, refreshKey);
  const onBusy = useCallback((busy: boolean) => onRunning(repo, busy), [repo, onRunning]);
  // Sprint plus affiché (clos, autre dépôt) : plus de relecture de secours pour lui.
  useEffect(() => () => onRunning(repo, false), [repo, onRunning]);
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
  } else
    body = (
      <Sprint summary={current} refreshKey={refreshKey} onChanged={onRefresh} onRunning={onBusy} />
    );

  return (
    <section className="flex flex-col gap-3.5">
      {heading && (
        <RepoHeading repo={repo}>
          {developHere && (
            <Button
              size="xs"
              icon="play"
              disabled={!shownSprint}
              title={DEVELOP_TITLE}
              onClick={() => developSprint(repo, shownSprint, onRefresh)}
            >
              Développer le sprint
            </Button>
          )}
        </RepoHeading>
      )}
      {current?.project_error && (
        <Callout tone="warning">Sprints automatiques : {current.project_error}</Callout>
      )}
      {current && !project && (
        <StartProject
          repo={repo}
          defaults={current.start_defaults ?? startDefaults(current)}
          onDone={onRefresh}
        />
      )}
      {project && current && (
        <ProjectBar repo={repo} project={project} summary={current} onDone={onRefresh} />
      )}
      {body}
      {project && project.sprints.length > 1 && (
        <Deliveries repo={repo} project={project} refreshKey={refreshKey} onDone={onRefresh} />
      )}
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
  const run = async (tool: string, args: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await cadence.call(tool, args);
      onDone();
      return true;
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
      return false;
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
            version, dans l'ordre des jalons de la roadmap puis par priorité, dans la limite de sa
            capacité. La capacité suit ensuite le rythme réel de l'équipe ; les issues non terminées
            passent au sprint suivant et la branche de release est fusionnée dans la branche par
            défaut quand la CI est verte.
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

/**
 * Barre des sprints automatiques : état, durée (confirmée : prochain sprint ou sprint en cours),
 * clôture anticipée, pause / reprise, capacité, issue d'état.
 */
function ProjectBar({
  repo,
  project,
  summary,
  onDone,
}: {
  repo: string;
  project: ProjectView;
  summary: SprintSummary;
  onDone: () => void;
}) {
  const { busy, error, run } = useProjectAction(onDone);
  const [newDuration, setNewDuration] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const paused = project.status === "paused";
  const current = project.sprints.find((s) => s.version === project.current && !s.ended_on);
  const closeHint = paused
    ? "Reprenez les sprints avant de clore le sprint en cours"
    : "Termine le sprint maintenant : les issues ouvertes passent au sprint suivant";
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
            // Capacité 0 : valeur héritée d'avant le plancher d'1 SP, sans signification.
            project.capacity ? `capacité ${project.capacity} SP` : null,
            project.next_capacity !== project.capacity
              ? `prochains sprints ${project.next_capacity} SP`
              : null,
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
            onChange={(e) => {
              const days = Number(e.target.value);
              if (days !== project.duration_days) setNewDuration(days);
            }}
          >
            {durationOptions(project.duration_days).map((d) => (
              <option key={d} value={d}>
                {durationLabel(d)}
              </option>
            ))}
          </Select>
        </label>
        {current && (
          <span title={closeHint} className="flex">
            <Button
              size="sm"
              variant="secondary"
              icon="check"
              disabled={busy || paused}
              onClick={() => setClosing(true)}
            >
              Clore le sprint
            </Button>
          </span>
        )}
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
      {newDuration !== null && (
        <DurationDialog
          project={project}
          current={current ?? null}
          days={newDuration}
          today={summary.today}
          busy={busy}
          onCancel={() => setNewDuration(null)}
          onApply={async (apply) => {
            const ok = await run("project_set_duration", {
              repo,
              duration_days: newDuration,
              apply,
            });
            if (ok) setNewDuration(null);
          }}
        />
      )}
      {closing && current && (
        <CloseSprintDialog
          project={project}
          version={current.version}
          due={current.due_on}
          today={summary.today}
          pace={summary.sprint?.title === current.version ? (summary.pace ?? null) : null}
          openIssues={
            summary.sprint?.title === current.version
              ? (summary.issues ?? []).filter((i) => i.state === "open")
              : null
          }
          busy={busy}
          error={error}
          onCancel={() => setClosing(false)}
          onConfirm={async (toBacklog) => {
            const ok = await run("project_close_sprint", {
              repo,
              version: current.version,
              to_backlog: toBacklog,
            });
            if (ok) {
              setClosing(false);
              void cadence.notify(
                toBacklog.length > 0
                  ? `Sprint ${current.version} clos ; ${toBacklog.map((n) => `#${n}`).join(", ")} ${toBacklog.length > 1 ? "rendues" : "rendue"} au carnet.`
                  : `Sprint ${current.version} clos.`,
                "success",
              );
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Changement de durée : par défaut à partir du prochain sprint ; l'appliquer au sprint en cours
 * change l'échéance de son milestone sur GitHub et sa portée, d'où la confirmation explicite.
 */
function DurationDialog({
  project,
  current,
  days,
  today,
  busy,
  onCancel,
  onApply,
}: {
  project: ProjectView;
  current: ProjectView["sprints"][number] | null;
  days: number;
  today: string;
  busy: boolean;
  onCancel: () => void;
  onApply: (apply: "next" | "current") => void;
}) {
  const capacity = capacityFor(project.points_per_day, days);
  const newDue = current ? dueFor(current.start_on, days, current.paused_days, today) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()} width={560}>
      <DialogHeader title={`Sprints de ${durationLabel(days)}`} icon="clock" />
      <DialogBody>
        <p className="text-body-sm leading-[1.6] text-tx2">
          Les prochains sprints dureront {durationLabel(days)}, avec une capacité de{" "}
          <span className="mono">{capacity} SP</span> (rythme{" "}
          {formatDecimal(project.points_per_day)} SP / jour, au moins une issue par sprint).
        </p>
        {current && newDue && (
          <div className="flex flex-col gap-2 rounded-field border border-line bg-p2 px-3 py-2.5 text-body-sm leading-[1.6]">
            <span className="text-tx">
              Sprint en cours {current.version} : {formatRange(current.start_on, current.due_on)} ·
              capacité {current.capacity} SP
            </span>
            <span className="text-tx3">
              <strong className="font-medium text-tx2">Au prochain sprint</strong> : le sprint en
              cours garde son échéance ({formatDay(current.due_on)}) et sa portée.
            </span>
            <span className="text-tx3">
              <strong className="font-medium text-tx2">Aussi le sprint en cours</strong> : il se
              terminerait le {formatDay(newDue)}
              {newDue === today.slice(0, 10) ? " (aujourd'hui)" : ""}
              {newDue !== current.due_on ? ` au lieu du ${formatDay(current.due_on)}` : ""} ;
              l'échéance du milestone {current.version} est modifiée sur GitHub et sa portée ajustée
              à {capacity} SP (issues « à faire » les moins prioritaires retirées, ou issues du
              carnet ajoutées).
            </span>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button size="sm" variant="quiet" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <div className="grow" />
        {current && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onApply("current")}>
            Aussi le sprint en cours
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onApply("next")}>
          {busy ? "Application…" : "À partir du prochain sprint"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Clôture anticipée du sprint en cours, après confirmation. Quand le report dépasse la capacité du
 * sprint suivant, la boîte le signale et propose de rendre l'excédent au carnet (N13).
 */
function CloseSprintDialog({
  project,
  version,
  due,
  today,
  pace,
  openIssues,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  project: ProjectView;
  version: string;
  due: string;
  today: string;
  pace: Pace | null;
  /** Issues ouvertes du sprint (celui affiché est bien le sprint à clore), sinon `null`. */
  openIssues: Issue[] | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (toBacklog: number[]) => void;
}) {
  const carry = useMemo(
    () => (openIssues ? carryOver(openIssues, project.next_capacity) : null),
    [openIssues, project.next_capacity],
  );
  const [release, setRelease] = useState(true);
  const toBacklog = carry && release ? carry.excess : [];
  const open = openIssues ? openIssues.length : pace ? pace.total - pace.closed : null;
  const openPoints = openIssues
    ? openIssues.reduce((n, i) => n + issueWeight(i), 0)
    : pace
      ? (pace.points_remaining ?? pace.points_total - pace.points_done)
      : null;
  const moving = open === null ? null : open - toBacklog.length;
  const movingPoints =
    openPoints === null || !carry ? openPoints : release ? carry.keepPoints : openPoints;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()} width={560}>
      <DialogHeader title={`Clore le sprint ${version} maintenant ?`} icon="check" />
      <DialogBody>
        <p className="text-body-sm leading-[1.6] text-tx2">
          {closeSprintLead(due, today)}, comme à une échéance normale :
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body-sm leading-[1.6] text-tx3">
          <li>
            {moving === null
              ? "Les issues ouvertes passent au sprint suivant"
              : moving === 0
                ? open === 0
                  ? "Toutes ses issues sont fermées. Le sprint suivant"
                  : "Aucune issue ne passe au sprint suivant"
                : `${plural(moving, "issue ouverte", "issues ouvertes")} (${movingPoints} SP) ${moving > 1 ? "passent" : "passe"} en tête du sprint suivant`}
            {moving === 0 ? "" : ", qui"} commence aujourd'hui pour{" "}
            {durationLabel(project.duration_days)} (capacité {project.next_capacity} SP) et se
            remplit selon l'ordre de la roadmap.
          </li>
          <li>
            Le milestone {version} est fermé ; ses PR encore ouvertes visent la nouvelle branche de
            release.
          </li>
          <li>
            La branche <span className="mono">release/{version}</span> est fusionnée dans la branche
            par défaut dès que la CI est verte (tout de suite sur un dépôt sans CI), puis la version
            est taguée.
          </li>
        </ul>
        {carry && carry.excess.length > 0 && (
          <Callout tone="warning">
            <span className="flex flex-col gap-2">
              <span>
                Le report ({openPoints} SP) dépasse la capacité du sprint suivant (
                {project.next_capacity} SP).
              </span>
              <label className="flex cursor-pointer items-start gap-2 text-tx">
                <input
                  type="checkbox"
                  className="mt-[3px]"
                  checked={release}
                  disabled={busy}
                  onChange={(e) => setRelease(e.target.checked)}
                />
                <span>
                  Rendre l'excédent au carnet : {carry.excess.map((n) => `#${n}`).join(", ")} (
                  {carry.excessPoints} SP, à faire, les moins prioritaires) ;{" "}
                  {carry.keep.length > 1 ? "seules" : "seule"}{" "}
                  {carry.keep.map((n) => `#${n}`).join(", ")} ({carry.keepPoints} SP){" "}
                  {carry.keep.length > 1 ? "passent" : "passe"} au sprint suivant.
                </span>
              </label>
            </span>
          </Callout>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        <div className="grow" />
        <Button size="sm" variant="quiet" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon="check"
          disabled={busy}
          onClick={() => onConfirm(toBacklog)}
        >
          {busy ? "Clôture…" : `Clore le sprint ${version}`}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Sprints terminés : story points livrés sur la portée, fusion de leur branche de release
 * (« Fusionner maintenant » quand aucune CI ne s'annonce) et leurs conversations (N14).
 */
function Deliveries({
  repo,
  project,
  refreshKey,
  onDone,
}: {
  repo: string;
  project: ProjectView;
  refreshKey: string;
  onDone: () => void;
}) {
  const ended = project.sprints.filter((s) => s.ended_on);
  const [shown, setShown] = useState<string | null>(null);
  const [shipping, setShipping] = useState<string | null>(null);
  if (ended.length === 0) return null;
  const ship = async (version: string) => {
    setShipping(version);
    try {
      const r = await cadence.call<{ release: SprintRecord["release"] }>("project_ship_release", {
        repo,
        version,
      });
      const info = releaseInfo(r.release);
      void cadence.notify(
        r.release?.status === "merged"
          ? `Release ${version} fusionnée${r.release.tag ? `, ${r.release.tag} publiée` : ""}.`
          : `Release ${version} : ${info.detail ?? info.label}`,
        r.release?.status === "merged" ? "success" : "warning",
      );
      onDone();
    } catch (e) {
      notifyError(e);
    } finally {
      setShipping(null);
    }
  };
  return (
    <Card className="px-[15px] py-3.5">
      <CardHeader
        title="Sprints terminés"
        actions={<Badge tone="neutral">release/x → défaut</Badge>}
      />
      <div className="mt-2 divide-y divide-line">
        {ended.map((s) => {
          const info = releaseInfo(s.release);
          const open = shown === s.version;
          const canShip = s.release?.status === "pending" && s.release.no_ci === true;
          return (
            <div key={s.version} className="flex flex-col py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="mono w-[64px] text-body-sm text-tx">{s.version}</span>
                <span className="text-caption text-tx3">
                  {formatRange(s.start_on, s.ended_on ?? s.due_on)}
                </span>
                <span
                  className="mono text-caption text-tx2"
                  title="Story points livrés sur la portée du sprint à sa clôture"
                >
                  {deliveredLabel(s)}
                </span>
                <div className="grow" />
                {info.detail && (
                  <span
                    className="max-w-[420px] truncate text-caption text-tx3"
                    title={info.detail}
                  >
                    {info.detail}
                  </span>
                )}
                {canShip && (
                  <Button
                    size="xs"
                    variant="secondary"
                    icon="branch"
                    disabled={shipping !== null}
                    title="Aucune CI ne s'est annoncée : fusionner la PR de release maintenant, puis taguer la version"
                    onClick={() => void ship(s.version)}
                  >
                    {shipping === s.version ? "Fusion…" : "Fusionner maintenant"}
                  </Button>
                )}
                <Badge tone={info.tone}>{info.label}</Badge>
                {s.milestone != null && (
                  <Button
                    size="xs"
                    variant={open ? "secondary" : "ghost"}
                    icon="bot"
                    aria-expanded={open}
                    onClick={() => setShown(open ? null : s.version)}
                  >
                    Conversations
                  </Button>
                )}
              </div>
              {open && s.milestone != null && (
                <SprintConversations
                  className="mt-2"
                  group={sprintGroup(repo, { number: s.milestone, title: s.version })}
                  refreshKey={refreshKey}
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Valeur de KPI en story points : le nombre, puis « SP » en petit. */
function SpValue({ n }: { n: number }) {
  return (
    <>
      {n}
      <span className="ml-1 text-body-sm">SP</span>
    </>
  );
}

/** Type de donnée d'une issue glissée du carnet vers le tableau du sprint. */
const DRAG_TYPE = "application/x-cadence-issue";

function Sprint({
  summary,
  refreshKey,
  onChanged,
  onRunning,
}: {
  summary: SprintSummary;
  refreshKey: string;
  /** Relit tout l'écran après une écriture. */
  onChanged: () => void;
  /** Une conversation du sprint tourne-t-elle ? (relecture de secours de l'écran) */
  onRunning: (running: boolean) => void;
}) {
  const v = summary.sprint!;
  const pace = summary.pace!;
  const repo = summary.repo;
  const group = sprintGroup(repo, v);
  const project = isStarted(summary.project) ? summary.project : null;
  // Cartes tout juste retirées : masquées tout de suite, jusqu'à la relecture du sprint (N08).
  const [removing, setRemoving] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setRemoving(new Set()), [summary]);
  const issues = (summary.issues ?? []).filter((i) => !removing.has(i.number));
  // Résultat de la dernière écriture, sous le titre du tableau (en plus du toast).
  const [notice, setNotice] = useState<{
    text: string;
    kind: "success" | "warning" | "info";
  } | null>(null);

  const conversations = useConversations(group.id, refreshKey);
  const running = (conversations.conversations ?? []).some((c) => c.state === "running");
  useEffect(() => onRunning(running), [running, onRunning]);

  // PR ouvertes du dépôt : la PR de chaque tâche en revue (« Closes #n » ou branche feat/<n>-…).
  const pulls = useTool<PullRequestList>("list_pull_requests", { repo, state: "open" }, refreshKey);
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
      // Liste pas encore lue (ou en erreur) : on la lit maintenant, la revue reçoit la PR.
      const list =
        pulls.data?.repo === repo
          ? openPulls
          : (await cadence.call<PullRequestList>("list_pull_requests", { repo, state: "open" }))
              .pull_requests;
      const items = tasks.map((i) => ({
        issue: i.number,
        pr: pullRequestFor(list, i)?.number ?? null,
      }));
      const runId = await cadence.runAction("relire-valider", reviewContext(repo, items, group));
      refreshWhenDone(runId, onChanged);
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
    pullsLoading: pulls.data?.repo !== repo && !pulls.error,
    disabled: launching,
  };

  // Portée : ajout depuis le carnet (cases ou glisser-déposer), retrait des cartes « À faire ».
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [dropping, setDropping] = useState(false);
  /** Ajoute / retire des issues ; rend les issues ajoutées (le carnet les masque aussitôt). */
  const move = async (add: number[], remove: number[]): Promise<number[]> => {
    if (add.length === 0 && remove.length === 0) return [];
    setMoving(true);
    setNotice(null);
    try {
      let r: Pick<SprintIssuesResult, "added" | "removed" | "skipped">;
      if (project) {
        r = await cadence.call<SprintIssuesResult>("sprint_issues", { repo, add, remove });
      } else {
        // Sprint sans moteur (milestone daté) : on change la version de chaque issue.
        r = { added: [], removed: [], skipped: [] };
        for (const [list, milestone, out] of [
          [add, v.title, r.added],
          [remove, "", r.removed],
        ] as const)
          for (const n of list) {
            try {
              await cadence.call("update_issue", { repo, number: n, milestone });
              out.push(n);
            } catch (e) {
              r.skipped.push({ issue: n, reason: isCadenceError(e) ? e.message : String(e) });
            }
          }
      }
      if (r.removed.length > 0) setRemoving((s) => new Set([...s, ...r.removed]));
      const message = moveMessage(r, v.title);
      setNotice(message);
      void cadence.notify(message.text, message.kind);
      return r.added;
    } catch (e) {
      notifyError(e);
      return [];
    } finally {
      setMoving(false);
      // Tout l'écran se relit : sprint, carnet, PR (le serveur corrige le retard des listes).
      onChanged();
    }
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    setDropping(false);
    const n = Number(e.dataTransfer.getData(DRAG_TYPE));
    if (!Number.isInteger(n) || n <= 0) return;
    e.preventDefault();
    void move([n], []);
  };

  const pointsRemaining = pace.points_remaining ?? pace.points_total - pace.points_done;
  const required = requiredPace(pointsRemaining, pace.days_left);
  const delay = delayLabel(pace.delay_days);
  const gain = gainedToday(pace.burndown, pace.points_total);
  const capacityLeft = project?.capacity != null ? project.capacity - pace.points_total : null;
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
          value={<SpValue n={pace.points_total} />}
          hint={[
            plural(pace.total, "issue"),
            plural(pace.closed, "fermée"),
            pace.unestimated > 0
              ? `${pace.unestimated} non estimée${pace.unestimated > 1 ? "s" : ""} (3 SP)`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <StatCard
          label="Avancement (SP)"
          value={formatPercent(pace.progress)}
          hint={[
            `${pace.points_done} / ${pace.points_total} SP`,
            pace.burndown.length > 1 ? `+${gain} aujourd'hui` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          tone="clay"
        />
        <StatCard
          label="Restant"
          value={<SpValue n={pointsRemaining} />}
          hint={
            required !== null
              ? `${formatDecimal(required)} SP / jour requis`
              : daysLeftLabel(pace.days_left)
          }
          tone="amber"
        />
        <StatCard
          label="Rythme"
          value={formatDecimal(pace.velocity)}
          hint="SP fermés / jour"
          tone="blue"
        />
        <StatCard
          label="Retard"
          value={pace.burndown.length > 0 ? formatDecimal(Math.abs(pace.delay_days)) : "—"}
          hint={pace.burndown.length > 0 ? delay.text : "pas encore commencé"}
          tone={delay.tone === "amber" ? "amber" : delay.tone === "green" ? "green" : "tx"}
        />
      </div>

      {backlogOpen && (
        <BacklogPanel
          repo={repo}
          version={v.title}
          refreshKey={refreshKey}
          capacityLeft={capacityLeft}
          busy={moving}
          onAdd={(numbers) => move(numbers, [])}
          onClose={() => setBacklogOpen(false)}
        />
      )}

      <div className="flex flex-wrap gap-3.5">
        <Card
          className={cn(
            "flex min-h-[320px] min-w-[420px] flex-[1_1_560px] flex-col px-[15px] py-[13px] transition-colors",
            dropping && "border-clay-line bg-clay-d",
          )}
          onDragOver={onDragOver}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        >
          <CardHeader
            title="Tableau du sprint"
            actions={
              <>
                {moving && <Spinner size={12} />}
                <Button
                  size="xs"
                  variant={backlogOpen ? "secondary" : "ghost"}
                  icon="plus"
                  disabled={v.state !== "open"}
                  onClick={() => setBacklogOpen((o) => !o)}
                  title="Ajouter au sprint des issues du carnet (sans version)"
                >
                  Ajouter des issues
                </Button>
                <TextLink onClick={() => void cadence.navigate("issues")}>
                  Voir toutes les issues
                </TextLink>
              </>
            }
          />
          {dropping && (
            <p className="mt-2 text-caption text-clay">Déposez l'issue pour l'ajouter au sprint.</p>
          )}
          {notice && (
            <div
              role="status"
              className={cn(
                "mt-[11px] flex items-center gap-2.5 rounded-field border px-3 py-2",
                notice.kind === "warning"
                  ? "border-amber-line bg-amber-d"
                  : notice.kind === "success"
                    ? "border-green-line bg-green-d"
                    : "border-line bg-p2",
              )}
            >
              <Icon
                name={notice.kind === "warning" ? "warning" : "check"}
                size={14}
                className={notice.kind === "warning" ? "text-amber" : "text-green"}
              />
              <span className="min-w-0 grow text-body-sm text-tx">{notice.text}</span>
              <Button
                size="xs"
                variant="quiet"
                icon="close"
                iconOnly
                aria-label="Masquer"
                onClick={() => setNotice(null)}
              />
            </div>
          )}
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
              Aucune issue dans ce sprint. « Ajouter des issues » ouvre le carnet : cochez des
              issues ou glissez-les ici. Les issues rattachées au milestone {v.title} apparaissent
              rangées par état (labels status/*).
            </p>
          ) : (
            <div className="mt-[13px] flex min-h-0 grow items-start gap-[11px] overflow-x-auto">
              {sprintBoard(issues).map((col) => (
                <KanbanColumn
                  key={col.status}
                  column={col}
                  review={col.status === "review" ? reviewControls : undefined}
                  onRemove={
                    col.status === "todo" && v.state === "open"
                      ? (issue) => void move([], [issue.number])
                      : undefined
                  }
                  removeDisabled={moving}
                />
              ))}
            </div>
          )}
        </Card>

        <div className="flex w-[330px] shrink-0 grow-0 flex-col gap-3 max-[900px]:w-full">
          <Card className="px-[15px] py-3.5">
            <div className="flex items-center gap-2">
              <h3 className="text-body">Burndown</h3>
              <span className="text-tiny text-tx3">story points restants</span>
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
                  scope={Math.max(1, pace.points_total)}
                  start={pace.start_on}
                  end={pace.due_on}
                  days={(pace.length_days ?? summary.sprint_length_days) + 1}
                  label={`Burndown du sprint ${v.title}, en story points`}
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
            <h3 className="text-body">Progression (SP)</h3>
            <MeterList
              className="mt-[13px]"
              items={statusMeters(pace.points_by_status ?? pointsByStatus(issues), "SP")}
            />
          </Card>
        </div>
      </div>

      <SprintConversations group={group} state={conversations} />
    </div>
  );
}

/**
 * Carnet du sprint : issues sans version dans l'ordre où les sprints les prennent (jalons de la
 * roadmap, puis priorité). On coche puis « Ajouter », ou on glisse une ligne sur le tableau.
 */
function BacklogPanel({
  repo,
  version,
  refreshKey,
  capacityLeft,
  busy,
  onAdd,
  onClose,
}: {
  repo: string;
  version: string;
  refreshKey: string;
  /** Story points encore libres dans la capacité du sprint (sprints automatiques). */
  capacityLeft: number | null;
  busy: boolean;
  /** Rend les issues effectivement ajoutées. */
  onAdd: (numbers: number[]) => Promise<number[]>;
  onClose: () => void;
}) {
  const { data, error, loading } = useTool<BacklogList>("sprint_backlog", { repo }, refreshKey);
  // Issues tout juste ajoutées : retirées du carnet sans attendre sa relecture (N08).
  const [added, setAdded] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setAdded(new Set()), [data]);
  const list = data?.repo === repo ? data.issues.filter((i) => !added.has(i.number)) : null;
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const chosen = (list ?? []).filter((i) => checked.has(i.number));
  const points = chosen.reduce((n, i) => n + i.weight, 0);
  const toggle = (n: number) =>
    setChecked((s) => {
      const next = new Set(s);
      if (!next.delete(n)) next.add(n);
      return next;
    });
  return (
    <Card className="px-[15px] py-3.5">
      <CardHeader
        title="Carnet"
        actions={
          <>
            {list && <Badge tone="neutral">{list.length}</Badge>}
            <Button
              size="xs"
              variant="quiet"
              icon="close"
              iconOnly
              aria-label="Fermer le carnet"
              onClick={onClose}
            />
          </>
        }
      />
      <p className="mt-1 text-caption leading-[1.6] text-tx3">
        Issues sans version, dans l'ordre où les sprints les prennent : jalons de la roadmap dans
        leur ordre, puis priorité. Cochez-les, ou glissez une ligne sur le tableau du sprint.
      </p>
      {error && (
        <Callout tone="danger" className="mt-3">
          {error.message}
        </Callout>
      )}
      {!list && !error && loading && (
        <div className="mt-3">
          <Loading label="Lecture du carnet…" />
        </div>
      )}
      {list && list.length === 0 && (
        <p className="mt-3 text-body-sm text-tx3">
          Le carnet est vide : toutes les issues ouvertes ont une version.
        </p>
      )}
      {list && list.length > 0 && (
        <div className="mt-2.5 max-h-[280px] divide-y divide-line overflow-y-auto rounded-field border border-line">
          {list.map((i) => (
            <label
              key={i.number}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, String(i.number));
                e.dataTransfer.setData("text/plain", `#${i.number}`);
                e.dataTransfer.effectAllowed = "move";
              }}
              className="flex cursor-grab items-center gap-2.5 bg-p2 px-3 py-2 hover:bg-p3"
              title="Glissez sur le tableau du sprint pour l'ajouter"
            >
              <input
                type="checkbox"
                checked={checked.has(i.number)}
                disabled={busy}
                onChange={() => toggle(i.number)}
                aria-label={`Ajouter #${i.number} au sprint`}
              />
              <span className="mono w-10 shrink-0 text-tiny text-tx3">#{i.number}</span>
              <span className="min-w-0 grow truncate text-body-sm text-tx">{i.title}</span>
              {i.jalon && <Badge tone="blue">{i.jalon.name}</Badge>}
              {i.priority !== null && (
                <Badge tone={priorityInfo(i.priority).tone}>{priorityInfo(i.priority).label}</Badge>
              )}
              <span
                className="mono w-11 shrink-0 text-right text-tiny text-tx3"
                title={i.points === null ? "Sans estimation : compte 3 SP" : undefined}
              >
                {i.weight} SP{i.points === null ? "*" : ""}
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <span className="text-caption text-tx3">
          {chosen.length > 0
            ? `${plural(chosen.length, "issue choisie", "issues choisies")} · ${points} SP`
            : "Aucune issue choisie"}
          {capacityLeft !== null &&
            (capacityLeft - points >= 0
              ? ` · capacité restante ${capacityLeft - points} SP`
              : ` · capacité du sprint dépassée de ${points - capacityLeft} SP`)}
        </span>
        <div className="grow" />
        <Button
          size="xs"
          variant="primary"
          icon="plus"
          disabled={busy || chosen.length === 0}
          onClick={() => {
            setChecked(new Set());
            void onAdd(chosen.map((i) => i.number)).then((ok) => {
              if (ok.length > 0) setAdded((s) => new Set([...s, ...ok]));
            });
          }}
        >
          Ajouter au sprint {version} ({chosen.length})
        </Button>
      </div>
    </Card>
  );
}

/**
 * Conversations rattachées au sprint (masquées du chat global) : état, titre, issues, IA, date ;
 * une ligne s'ouvre dans la vue Chat de Cadence. `state` : liste déjà lue par le parent ; sinon
 * elle est lue ici (`refreshKey`), comme pour un sprint terminé.
 */
function SprintConversations({
  group,
  state,
  refreshKey = "",
  className,
}: {
  group: ActionGroup;
  state?: ConversationsState;
  refreshKey?: string;
  className?: string;
}) {
  const own = useConversations(state ? null : group.id, refreshKey);
  const { conversations, error } = state ?? own;
  const list = conversations ?? [];
  const running = list.filter((c) => c.state === "running").length;
  const open = (c: ConversationInfo) => void cadence.conversations.open(c.id).catch(notifyError);
  return (
    <Card className={cn("px-[15px] py-3.5", className)}>
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
          {issues
            .slice(0, 3)
            .map((n) => `#${n}`)
            .join(" ")}
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
