/**
 * Roadmap par jalons : un jalon est un objectif nommé (« MVP privé », « Bêta publique ») réalisé
 * en un ou plusieurs sprints. Les jalons vivent dans l'issue d'état partagée (affichage seulement :
 * les sprints restent remplis par priorité). La frise place chaque jalon sur les sprints terminés,
 * en cours et prévus ; sa date de fin est celle du sprint qui prend sa dernière issue ouverte, au
 * rythme moyen, avec une fourchette (meilleur et moins bon rythme récents) qui se resserre avec
 * l'historique. Données : `roadmap` ; modifications : `jalon_save`, `jalon_delete`, `jalon_issues`.
 */
import { useState, type ReactNode } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
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
  ProgressBar,
  Textarea,
  cn,
} from "@cadence/ui";
import { priorityInfo, type JalonView, type RoadmapPlan, type RoadmapSprint } from "../domain";
import {
  EmptyCard,
  Loading,
  NoRepos,
  PageHeader,
  RepoHeading,
  SelectionLabel,
  TextLink,
  ToolError,
} from "../components";
import {
  estimateRange,
  formatDate,
  formatDecimal,
  formatPercent,
  jalonSpan,
  jalonStatusMeta,
  plural,
} from "../planning";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

export function RoadmapView() {
  const { repos, repo, shown, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="roadmap"
        title="Roadmap"
        subtitle={repos && <SelectionLabel repo={repo} count={shown.length} />}
      >
        <Badge tone="neutral">Un jalon = un ou plusieurs sprints</Badge>
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
            <RepoRoadmap key={r} repo={r} heading={!repo} refreshKey={String(tick)} />
          ))}
        </div>
      </main>
    </div>
  );
}

/** Appelle un outil de jalon puis recharge la roadmap ; l'erreur est rendue en français. */
function useJalonAction(onDone: () => void) {
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

type Editing = { kind: "jalon"; jalon: JalonView | null } | { kind: "issues"; jalon: JalonView };

function RepoRoadmap({
  repo,
  heading,
  refreshKey,
}: {
  repo: string;
  heading: boolean;
  refreshKey: string;
}) {
  const { data, error, loading, reload } = useTool<RoadmapPlan>("roadmap", { repo }, refreshKey);
  const plan = data?.repo === repo ? data : null;
  const action = useJalonAction(reload);
  const [editing, setEditing] = useState<Editing | null>(null);

  const move = (j: JalonView, by: number) => {
    const at = (plan?.jalons.findIndex((x) => x.id === j.id) ?? 0) + by;
    void action.run("jalon_save", { repo, id: j.id, name: j.name, position: Math.max(0, at) });
  };
  const propose = (j: JalonView) =>
    cadence
      .runAction("proposer-issues", { type: "jalon", repo, jalon: j.id, jalon_name: j.name })
      .catch((e: unknown) => cadence.notify(isCadenceError(e) ? e.message : String(e), "error"));
  const closeAndReload = () => {
    setEditing(null);
    reload();
  };

  let body: ReactNode;
  if (error) body = <ToolError message={error.message} className="mb-0" />;
  else if (!plan) body = loading ? <Loading label="Calcul de la roadmap…" /> : null;
  else
    body = (
      <div className="flex flex-col gap-4">
        <Summary plan={plan} onNew={() => setEditing({ kind: "jalon", jalon: null })} />
        {action.error && <Callout tone="danger">{action.error}</Callout>}
        {plan.jalons.length === 0 ? (
          <EmptyCard icon="roadmap" title="Aucun jalon pour l'instant">
            Un jalon regroupe les issues d'un objectif (« MVP privé », « Bêta publique ») et
            s'atteint en un ou plusieurs sprints : la roadmap estime sa date de fin au rythme réel
            de l'équipe. Créez-en un avec « Nouveau jalon », ou laissez le skill « Créer des issues
            depuis un document » ranger les issues qu'il crée.
          </EmptyCard>
        ) : (
          <>
            {plan.sprints.length > 0 && <Timeline plan={plan} />}
            {plan.jalons.map((j, i) => (
              <JalonCard
                key={j.id}
                jalon={j}
                today={plan.today}
                started={plan.started}
                first={i === 0}
                last={i === plan.jalons.length - 1}
                busy={action.busy}
                onEdit={() => setEditing({ kind: "jalon", jalon: j })}
                onAddIssues={() => setEditing({ kind: "issues", jalon: j })}
                onRemoveIssue={(n) =>
                  void action.run("jalon_issues", { repo, id: j.id, remove: [n] })
                }
                onMove={(by) => move(j, by)}
                onPropose={() => void propose(j)}
              />
            ))}
          </>
        )}
        {plan.unassigned.length > 0 && <Unassigned plan={plan} />}
      </div>
    );

  return (
    <section>
      {heading && <RepoHeading repo={repo} />}
      {body}
      {editing?.kind === "jalon" && (
        <JalonDialog
          repo={repo}
          jalon={editing.jalon}
          onClose={() => setEditing(null)}
          onSaved={closeAndReload}
        />
      )}
      {editing?.kind === "issues" && plan && (
        <IssuesDialog
          repo={repo}
          jalon={editing.jalon}
          plan={plan}
          onClose={() => setEditing(null)}
          onSaved={closeAndReload}
        />
      )}
    </section>
  );
}

/** Fin estimée de tout le travail ouvert, rythme, issues sans jalon. */
function Summary({ plan, onNew }: { plan: RoadmapPlan; onNew: () => void }) {
  const end = plan.end
    ? estimateRange(plan.end.on, plan.end.early, plan.end.late, plan.today)
    : null;
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-2.5 px-[15px] py-3">
      {plan.started ? (
        <>
          <div className="flex flex-col">
            <span className="text-caption text-tx3">Fin estimée du travail ouvert</span>
            <span className="text-body font-semibold">
              {end?.date ?? "—"}
              {end?.range && (
                <span className="ml-2 text-caption font-normal text-tx3">{end.range}</span>
              )}
            </span>
          </div>
          {plan.rates && (
            <div className="flex flex-col">
              <span className="text-caption text-tx3">Rythme de l'équipe</span>
              <span className="mono text-body-sm text-tx2">
                {formatDecimal(plan.rates.avg)} SP / jour
                <span className="text-tx3">
                  {" "}
                  ({formatDecimal(plan.rates.low)} – {formatDecimal(plan.rates.high)})
                </span>
              </span>
            </div>
          )}
        </>
      ) : (
        <span className="text-body-sm text-tx3">
          Les dates apparaissent dès que les sprints sont démarrés.{" "}
          <TextLink onClick={() => void cadence.navigate("sprint")}>Démarrer le projet</TextLink>
        </span>
      )}
      <div className="grow" />
      {plan.unassigned.length > 0 && (
        <span className="text-caption text-tx3">
          {plural(plan.unassigned.length, "issue ouverte sans jalon", "issues ouvertes sans jalon")}
        </span>
      )}
      <Button size="sm" variant="primary" icon="plus" onClick={onNew}>
        Nouveau jalon
      </Button>
    </Card>
  );
}

const COLUMN = 104;
const LABEL = 180;

/** Frise : une colonne par sprint (terminé, en cours, prévu), une barre par jalon. */
function Timeline({ plan }: { plan: RoadmapPlan }) {
  const sprints = plan.sprints;
  const width = sprints.length * COLUMN;
  return (
    <Card className="px-[15px] py-3.5">
      <CardHeader
        title="Frise des jalons"
        actions={
          <span className="text-caption text-tx3">
            sprints de {plural(plan.duration_days ?? 14, "jour")} · prévision au rythme moyen
          </span>
        }
      />
      <div className="mt-3 overflow-x-auto pb-1">
        <div style={{ width: LABEL + width }} className="flex flex-col gap-1.5">
          <div className="flex">
            <div style={{ width: LABEL }} className="shrink-0" />
            {sprints.map((s) => (
              <SprintColumn key={s.version} sprint={s} today={plan.today} />
            ))}
          </div>
          {plan.jalons.map((j) => {
            const span = jalonSpan(j, sprints);
            const meta = jalonStatusMeta[j.status];
            return (
              <div key={j.id} className="flex items-center">
                <div
                  style={{ width: LABEL }}
                  className="shrink-0 truncate pr-3 text-body-sm text-tx2"
                  title={j.name}
                >
                  {j.name}
                </div>
                <div className="relative h-7" style={{ width }}>
                  {span && (
                    <div
                      className={cn(
                        "absolute inset-y-0.5 flex items-center overflow-hidden rounded-control border px-2 text-tiny font-medium whitespace-nowrap",
                        meta.bar,
                      )}
                      style={{
                        left: span.from * COLUMN + 2,
                        width: (span.to - span.from + 1) * COLUMN - 4,
                      }}
                      title={`${j.name} · ${meta.label}`}
                    >
                      {j.end_on ? formatDate(j.end_on, plan.today) : meta.label}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function SprintColumn({ sprint, today }: { sprint: RoadmapSprint; today: string }) {
  return (
    <div
      style={{ width: COLUMN }}
      className={cn(
        "flex shrink-0 flex-col border-l px-2 py-1",
        sprint.state === "current" ? "border-clay" : "border-line",
        sprint.state === "planned" && "border-dashed",
      )}
    >
      <span
        className={cn(
          "mono text-caption",
          sprint.state === "current"
            ? "text-clay"
            : sprint.state === "done"
              ? "text-tx3"
              : "text-tx2",
        )}
      >
        {sprint.version}
      </span>
      <span className="text-micro text-tx3">→ {formatDate(sprint.due_on, today)}</span>
    </div>
  );
}

function JalonCard({
  jalon,
  today,
  started,
  first,
  last,
  busy,
  onEdit,
  onAddIssues,
  onRemoveIssue,
  onMove,
  onPropose,
}: {
  jalon: JalonView;
  today: string;
  started: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  onEdit: () => void;
  onAddIssues: () => void;
  onRemoveIssue: (n: number) => void;
  onMove: (by: number) => void;
  onPropose: () => void;
}) {
  const meta = jalonStatusMeta[jalon.status];
  const progress = jalon.points_total
    ? Math.round((jalon.points_done / jalon.points_total) * 100)
    : 0;
  const end = estimateRange(jalon.end_on, jalon.end_early, jalon.end_late, today);
  let when: string;
  if (jalon.status === "done") when = end.date ? `atteint le ${end.date}` : "atteint";
  else if (!started) when = "dates après le démarrage des sprints";
  else if (jalon.status === "empty") when = "aucune issue";
  else if (!end.date) when = "pas encore planifiable";
  else when = `fin estimée le ${end.date}`;

  return (
    <Card className="flex flex-col gap-3 px-[15px] py-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 grow flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-title-sm font-semibold">{jalon.name}</h3>
            <Badge tone={meta.tone} dot>
              {meta.label}
            </Badge>
          </div>
          {jalon.description && (
            <p className="max-w-[760px] text-body-sm leading-[1.6] text-tx2">{jalon.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="quiet"
            iconOnly
            icon="chevronDown"
            className="rotate-180"
            aria-label="Monter le jalon"
            disabled={first || busy}
            onClick={() => onMove(-1)}
          />
          <Button
            size="xs"
            variant="quiet"
            iconOnly
            icon="chevronDown"
            aria-label="Descendre le jalon"
            disabled={last || busy}
            onClick={() => onMove(1)}
          />
          <Button size="xs" variant="ghost" icon="settings" onClick={onEdit}>
            Modifier
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <ProgressBar
            value={progress}
            tone={meta.progress}
            height={4}
            label={`Avancement ${jalon.name}`}
          />
          <span className="text-micro text-tx3">
            {formatPercent(progress)} · {jalon.points_done} / {jalon.points_total} SP ·{" "}
            {jalon.closed} / {plural(jalon.total, "issue")}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-body-sm text-tx">{when}</span>
          {end.range && jalon.status !== "done" && (
            <span className="text-caption text-tx3">{end.range}</span>
          )}
        </div>
        {jalon.sprints.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {jalon.sprints.map((v) => (
              <Badge key={v} mono tone="clay" icon="tag">
                {v}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {(jalon.unplanned > 0 || jalon.unestimated > 0) && started && jalon.status !== "done" && (
        <p className="text-caption text-amber">
          {[
            jalon.unestimated > 0 &&
              `${plural(jalon.unestimated, "issue non estimée", "issues non estimées")} (comptées 3 SP)`,
            jalon.unplanned > 0 &&
              `${plural(jalon.unplanned, "issue hors prévision", "issues hors prévision")} (dépendance non planifiée)`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      {jalon.issues.length > 0 && (
        <div className="divide-y divide-line rounded-control border border-line">
          {jalon.issues.map((i) => (
            <div key={i.number} className="group flex items-center gap-2.5 px-2.5 py-1.5">
              <span className={cn("flex", i.state === "closed" ? "text-green" : "text-tx3")}>
                <Icon name={i.state === "closed" ? "check" : "issue"} size={13} />
              </span>
              <span className="mono w-[38px] shrink-0 text-tiny text-tx3">#{i.number}</span>
              <span
                className={cn(
                  "min-w-0 grow truncate text-body-sm",
                  i.state === "closed" ? "text-tx3 line-through" : "text-tx",
                )}
              >
                {i.title}
              </span>
              {i.priority !== null && (
                <Badge tone={priorityInfo(i.priority).tone}>{priorityInfo(i.priority).label}</Badge>
              )}
              {i.points !== null && <Badge mono>{i.points} SP</Badge>}
              <span className="mono w-[44px] shrink-0 text-right text-tiny text-tx3">
                {i.sprint ?? ""}
              </span>
              <Button
                size="xs"
                variant="quiet"
                iconOnly
                icon="close"
                aria-label={`Retirer #${i.number} du jalon`}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                disabled={busy}
                onClick={() => onRemoveIssue(i.number)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="secondary" icon="plus" onClick={onAddIssues}>
          Ranger des issues
        </Button>
        <Button size="xs" variant="ghost" icon="sparkle" onClick={onPropose}>
          Proposer des issues
        </Button>
      </div>
    </Card>
  );
}

function Unassigned({ plan }: { plan: RoadmapPlan }) {
  return (
    <Card className="px-[15px] py-3.5">
      <CardHeader
        title="Sans jalon"
        actions={
          <span className="text-caption text-tx3">
            {plural(plan.unassigned.length, "issue ouverte", "issues ouvertes")}
          </span>
        }
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {plan.unassigned.map((i) => (
          <span
            key={i.number}
            className="inline-flex max-w-[320px] items-center gap-1.5 rounded-badge bg-p3 px-2 py-0.5 text-caption text-tx2"
            title={i.title}
          >
            <span className="mono text-tx3">#{i.number}</span>
            <span className="truncate">{i.title}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

/** Nouveau jalon ou modification : nom, objectif ; suppression. */
function JalonDialog({
  repo,
  jalon,
  onClose,
  onSaved,
}: {
  repo: string;
  jalon: JalonView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(jalon?.name ?? "");
  const [description, setDescription] = useState(jalon?.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, error, run } = useJalonAction(onSaved);
  const save = () =>
    void run("jalon_save", {
      repo,
      ...(jalon ? { id: jalon.id } : {}),
      name: name.trim(),
      description: description.trim(),
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={560}>
      <DialogHeader title={jalon ? "Modifier le jalon" : "Nouveau jalon"} icon="roadmap" />
      <DialogBody className="flex flex-col gap-4">
        <Field
          label="Nom"
          htmlFor="jalon-nom"
          hint="clair et court : « MVP privé », « Bêta publique »"
        >
          <Input
            id="jalon-nom"
            size="md"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="Objectif"
          htmlFor="jalon-objectif"
          hint="ce que le jalon permet, en une ou deux phrases"
        >
          <Textarea
            id="jalon-objectif"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        {jalon &&
          (confirmDelete ? (
            <Button
              variant="danger"
              size="md"
              disabled={busy}
              onClick={() => void run("jalon_delete", { repo, id: jalon.id })}
            >
              Confirmer la suppression
            </Button>
          ) : (
            <Button variant="quiet" size="md" onClick={() => setConfirmDelete(true)}>
              Supprimer le jalon
            </Button>
          ))}
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="primary" size="md" disabled={busy || name.trim() === ""} onClick={save}>
          {jalon ? "Enregistrer" : "Créer le jalon"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Ranger des issues ouvertes dans un jalon : celles sans jalon, puis celles d'autres jalons. */
function IssuesDialog({
  repo,
  jalon,
  plan,
  onClose,
  onSaved,
}: {
  repo: string;
  jalon: JalonView;
  plan: RoadmapPlan;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const { busy, error, run } = useJalonAction(onSaved);
  const rows = [
    ...plan.unassigned.map((i) => ({ ...i, from: null as string | null })),
    ...plan.jalons
      .filter((j) => j.id !== jalon.id)
      .flatMap((j) =>
        j.issues.filter((i) => i.state === "open").map((i) => ({ ...i, from: j.name })),
      ),
  ];
  const toggle = (n: number) =>
    setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={620}>
      <DialogHeader title={`Ranger des issues dans « ${jalon.name} »`} icon="issue" />
      <DialogBody className="flex max-h-[calc(100vh-240px)] flex-col gap-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="text-body-sm text-tx3">
            Toutes les issues ouvertes sont déjà dans ce jalon.
          </p>
        ) : (
          rows.map((r) => (
            <label
              key={r.number}
              className="flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-p2"
            >
              <input
                type="checkbox"
                checked={picked.includes(r.number)}
                onChange={() => toggle(r.number)}
              />
              <span className="mono w-[38px] shrink-0 text-tiny text-tx3">#{r.number}</span>
              <span className="min-w-0 grow truncate text-body-sm text-tx">{r.title}</span>
              {r.points !== null && <Badge mono>{r.points} SP</Badge>}
              {r.from && <span className="shrink-0 text-tiny text-tx3">dans « {r.from} »</span>}
            </label>
          ))
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        <span className="text-caption text-tx3">Une issue n'appartient qu'à un jalon.</span>
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={busy || picked.length === 0}
          onClick={() => void run("jalon_issues", { repo, id: jalon.id, add: picked })}
        >
          {picked.length > 0 ? `Ranger ${plural(picked.length, "issue")}` : "Ranger"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
