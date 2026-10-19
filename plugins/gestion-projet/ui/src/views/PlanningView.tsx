/**
 * Planning (Gantt) : tâches libres — étude, conception, développement, recette, lancement… —
 * groupées par phase, avec personnes, dépendances (flèches), avancement et jalons-dates
 * (losanges). On déplace une barre ou on tire ses bords pour changer ses dates ; un clic ouvre la
 * tâche. « Planifier avec l'IA » ouvre le skill `planifier`, qui propose un planning et ne
 * l'enregistre qu'après accord. Données : `planning_get` / `planning_save` (issue cachée
 * `cadence/planning`, partagée par l'équipe ; une révision dépassée est refusée).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Select,
  Textarea,
  cn,
} from "@cadence/ui";
import type { Planning, PlanningPerson, PlanningResponse, PlanningTask } from "../domain";
import { EmptyCard, Loading, NoRepos, PageHeader, SegmentedTabs, ToolError } from "../components";
import {
  addDays,
  dayWidth,
  daysBetween,
  ganttRange,
  ganttRows,
  initials,
  isWeekend,
  monthBands,
  shiftTask,
  ticks,
  uniqueId,
  type Zoom,
} from "../gantt";
import { formatDay } from "../planning";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

const ROW = 34;
const HEADER = 46;
const LABEL = 280;

const zooms: { id: Zoom; label: string }[] = [
  { id: "day", label: "Jours" },
  { id: "week", label: "Semaines" },
  { id: "month", label: "Mois" },
];

const todayIso = () => new Date().toISOString().slice(0, 10);

export function PlanningView() {
  const { repos, repo, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("week");
  const [person, setPerson] = useState("");
  const [editing, setEditing] = useState<PlanningTask | "new" | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [local, setLocal] = useState<Planning | null>(null);
  const {
    data,
    error: loadError,
    loading,
  } = useTool<PlanningResponse>("planning_get", { repo }, String(tick), ready && repo !== null);
  const remote = data?.repo === repo ? data.planning : null;
  // Copie locale : les déplacements s'affichent tout de suite, la réponse du serveur fait foi.
  useEffect(() => setLocal(remote), [remote]);
  const planning = local;
  const reload = () => setTick((t) => t + 1);

  const save = async (next: Planning) => {
    if (!repo || !planning) return;
    setSaveError(null);
    setLocal(next);
    try {
      const res = await cadence.call<PlanningResponse>("planning_save", {
        repo,
        planning: next,
        base_revision: planning.revision,
      });
      setLocal(res.planning);
    } catch (e) {
      setSaveError(isCadenceError(e) ? e.message : String(e));
      reload();
    }
  };
  const plan = () =>
    cadence
      .runAction("planifier", { repo })
      .catch((e: unknown) => cadence.notify(isCadenceError(e) ? e.message : String(e), "error"));

  let body;
  if (error) body = <ToolError message={error.message} />;
  else if (repos && repos.length === 0) body = <NoRepos />;
  else if (!repo)
    body = (
      <EmptyCard icon="calendar" title="Choisissez un dépôt">
        Le planning est propre à chaque dépôt : sélectionnez-en un dans le sélecteur de la barre du
        plugin.
      </EmptyCard>
    );
  else if (loadError) body = <ToolError message={loadError.message} />;
  else if (!planning) body = loading ? <Loading label="Lecture du planning…" /> : null;
  else if (planning.tasks.length === 0)
    body = (
      <EmptyCard icon="calendar" title="Planning vide">
        Le planning couvre tout le projet, pas seulement le développement : étude, ateliers,
        conception, recette, lancement… Ajoutez des tâches à la main, ou laissez l'IA proposer un
        planning à partir de vos contraintes (vous le validez avant qu'il soit enregistré).
      </EmptyCard>
    );
  else
    body = (
      <Gantt
        planning={planning}
        zoom={zoom}
        person={person}
        onOpen={setEditing}
        onMove={(task, dates) =>
          void save({
            ...planning,
            tasks: planning.tasks.map((t) => (t.id === task.id ? { ...t, ...dates } : t)),
          })
        }
      />
    );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="calendar"
        title="Planning"
        subtitle={repo && <span className="mono text-caption text-tx3">{repo}</span>}
      >
        {planning && planning.tasks.length > 0 && (
          <>
            <SegmentedTabs items={zooms} value={zoom} onChange={setZoom} label="Échelle" />
            {planning.people.length > 0 && (
              <Select
                size="sm"
                value={person}
                onChange={(e) => setPerson(e.target.value)}
                aria-label="Personne"
              >
                <option value="">Toute l'équipe</option>
                {planning.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon="user"
          disabled={!planning}
          onClick={() => setPeopleOpen(true)}
        >
          Personnes
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="sparkle"
          disabled={!repo}
          onClick={() => void plan()}
        >
          Planifier avec l'IA
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          disabled={!planning}
          onClick={() => setEditing("new")}
        >
          Nouvelle tâche
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={reload}
          disabled={!repo}
        />
      </PageHeader>
      <main className="flex min-h-0 grow flex-col overflow-hidden p-5">
        {saveError && (
          <Callout tone="danger" className="mb-3">
            {saveError}
          </Callout>
        )}
        {body}
      </main>
      {editing && planning && (
        <TaskDialog
          planning={planning}
          task={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            setEditing(null);
            void save(next);
          }}
        />
      )}
      {peopleOpen && planning && (
        <PeopleDialog
          planning={planning}
          onClose={() => setPeopleOpen(false)}
          onSave={(next) => {
            setPeopleOpen(false);
            void save(next);
          }}
        />
      )}
    </div>
  );
}

type Drag = {
  id: string;
  mode: "move" | "start" | "end";
  x: number;
  delta: number;
  moved: boolean;
};

function Gantt({
  planning,
  zoom,
  person,
  onOpen,
  onMove,
}: {
  planning: Planning;
  zoom: Zoom;
  person: string;
  onOpen: (task: PlanningTask) => void;
  onMove: (task: PlanningTask, dates: { start: string; end: string }) => void;
}) {
  const today = todayIso();
  const dw = dayWidth[zoom];
  const range = useMemo(
    () => ganttRange(planning.tasks, today, zoom),
    [planning.tasks, today, zoom],
  );
  const width = range.days * dw;
  const tasks = person ? planning.tasks.filter((t) => t.people.includes(person)) : planning.tasks;
  const rows = ganttRows(tasks, planning.phases);
  const people = new Map(planning.people.map((p) => [p.id, p]));
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Ouvre la vue sur aujourd'hui.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, daysBetween(range.start, today) * dw - 160);
  }, [range.start, today, dw]);

  const dates = (t: PlanningTask) =>
    drag && drag.id === t.id ? shiftTask(t, drag.mode, drag.delta) : t;
  const x = (iso: string) => daysBetween(range.start, iso) * dw;
  const rowOf = new Map<string, number>();
  rows.forEach((r, i) => r.kind === "task" && rowOf.set(r.task.id, i));

  const down = (e: ReactPointerEvent, task: PlanningTask, mode: Drag["mode"]) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const d = { id: task.id, mode, x: e.clientX, delta: 0, moved: false };
    dragRef.current = d;
    setDrag(d);
  };
  const moveTo = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const delta = Math.round((e.clientX - d.x) / dw);
    const next = { ...d, delta, moved: d.moved || Math.abs(e.clientX - d.x) > 3 };
    dragRef.current = next;
    setDrag(next);
  };
  const up = (task: PlanningTask) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (!d.moved) onOpen(task);
    else if (d.delta !== 0) onMove(task, shiftTask(task, d.mode, d.delta));
  };

  const todayX = x(today);
  const bands = zoom === "month" ? [] : monthBands(range.start, range.days);
  const marks = ticks(range.start, range.days, zoom);
  const height = HEADER + rows.length * ROW;

  return (
    <div
      ref={scroller}
      className="min-h-0 grow overflow-auto rounded-card border border-line bg-panel"
    >
      <div className="relative" style={{ width: LABEL + width, height }}>
        {/* En-tête : mois puis graduations. */}
        <div
          className="sticky top-0 z-20 flex border-b border-line bg-panel"
          style={{ height: HEADER }}
        >
          <div
            className="sticky left-0 z-30 flex shrink-0 items-end border-r border-line bg-panel px-3 pb-1.5 text-caption text-tx3"
            style={{ width: LABEL }}
          >
            {rows.filter((r) => r.kind === "task").length} tâches
          </div>
          <div className="relative" style={{ width }}>
            {bands.map((b) => (
              <div
                key={b.offset}
                className="absolute top-0 truncate border-l border-line px-1.5 pt-1 text-tiny font-medium text-tx2"
                style={{ left: b.offset * dw, width: b.days * dw }}
              >
                {b.label}
              </div>
            ))}
            {marks.map((t) => (
              <div
                key={t.offset}
                className={cn(
                  "absolute bottom-1 truncate px-1 text-micro",
                  t.major ? "font-medium text-tx2" : "text-tx3",
                  zoom === "day" && "text-center",
                )}
                style={{
                  left: t.offset * dw,
                  width: zoom === "day" ? dw : zoom === "week" ? 7 * dw : 30 * dw,
                }}
              >
                {t.label}
              </div>
            ))}
          </div>
        </div>

        {/* Fond : week-ends, graduations, aujourd'hui. */}
        <div
          className="pointer-events-none absolute"
          style={{ left: LABEL, top: HEADER, width, height: rows.length * ROW }}
        >
          {zoom !== "month" &&
            Array.from({ length: range.days }, (_, i) => i)
              .filter((i) => isWeekend(addDays(range.start, i)))
              .map((i) => (
                <div
                  key={i}
                  className="absolute inset-y-0 bg-p2"
                  style={{ left: i * dw, width: dw }}
                />
              ))}
          {marks.map((t) => (
            <div
              key={t.offset}
              className={cn(
                "absolute inset-y-0 border-l",
                t.major ? "border-line2" : "border-line",
              )}
              style={{ left: t.offset * dw }}
            />
          ))}
          {todayX >= 0 && todayX <= width && (
            <div
              className="absolute inset-y-0 z-10 w-0.5 bg-clay"
              style={{ left: todayX }}
              title={`Aujourd'hui, ${formatDay(today)}`}
            />
          )}
        </div>

        {/* Flèches de dépendance. */}
        <svg
          className="pointer-events-none absolute z-10 text-tx3"
          style={{ left: LABEL, top: HEADER }}
          width={width}
          height={rows.length * ROW}
        >
          <defs>
            <marker id="fleche" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
            </marker>
          </defs>
          {rows.flatMap((r, i) => {
            if (r.kind !== "task") return [];
            return r.task.depends.flatMap((dep) => {
              const j = rowOf.get(dep);
              const from = tasks.find((t) => t.id === dep);
              if (j === undefined || !from) return [];
              const a = dates(from);
              const b = dates(r.task);
              const x1 = x(a.end) + dw;
              const y1 = j * ROW + ROW / 2;
              const x2 = x(b.start);
              const y2 = i * ROW + ROW / 2;
              const mid = Math.max(x1 + 6, Math.min(x2 - 6, x1 + 10));
              return [
                <path
                  key={`${dep}-${r.task.id}`}
                  d={`M${x1},${y1} H${mid} V${y2} H${x2 - 1}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  markerEnd="url(#fleche)"
                />,
              ];
            });
          })}
        </svg>

        {/* Lignes. */}
        {rows.map((r, i) => {
          const top = HEADER + i * ROW;
          if (r.kind === "phase")
            return (
              <div
                key={`phase-${r.phase}`}
                className="absolute flex items-center"
                style={{ top, height: ROW, width: LABEL + width }}
              >
                <div
                  className="sticky left-0 z-20 flex h-full items-center gap-2 border-r border-line bg-p2 px-3 text-caption font-semibold tracking-[0.04em] text-tx2 uppercase"
                  style={{ width: LABEL }}
                >
                  {r.phase || "Sans phase"}
                  <span className="font-normal text-tx3 normal-case">· {r.count}</span>
                </div>
              </div>
            );
          const t = r.task;
          const d = dates(t);
          const left = x(d.start);
          const span = (daysBetween(d.start, d.end) + 1) * dw;
          const assignees = t.people
            .map((id) => people.get(id))
            .filter((p): p is PlanningPerson => !!p);
          return (
            <div
              key={t.id}
              className="absolute flex items-center"
              style={{ top, height: ROW, width: LABEL + width }}
            >
              <button
                type="button"
                onClick={() => onOpen(t)}
                className="sticky left-0 z-20 flex h-full items-center gap-2 border-r border-b border-line bg-panel px-3 text-left hover:bg-p2"
                style={{ width: LABEL }}
              >
                <span className="min-w-0 grow truncate text-body-sm text-tx">{t.name}</span>
                {t.issue ? <span className="mono text-tiny text-tx3">#{t.issue}</span> : null}
                <span className="mono shrink-0 text-tiny text-tx3">
                  {formatDay(d.start)}
                  {t.milestone ? "" : ` → ${formatDay(d.end)}`}
                </span>
              </button>
              <div className="relative h-full" style={{ width }}>
                {t.milestone ? (
                  <div
                    role="button"
                    aria-label={`${t.name}, ${formatDay(d.start)}`}
                    tabIndex={0}
                    onPointerDown={(e) => down(e, t, "move")}
                    onPointerMove={moveTo}
                    onPointerUp={() => up(t)}
                    onKeyDown={(e) => e.key === "Enter" && onOpen(t)}
                    className="absolute top-1/2 z-10 size-3.5 -translate-y-1/2 rotate-45 cursor-grab border border-purple bg-purple-d"
                    style={{ left: left + dw / 2 - 7 }}
                    title={`${t.name} · ${formatDay(d.start)}`}
                  />
                ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${t.name}, du ${formatDay(d.start)} au ${formatDay(d.end)}`}
                    onPointerDown={(e) => down(e, t, "move")}
                    onPointerMove={moveTo}
                    onPointerUp={() => up(t)}
                    onKeyDown={(e) => e.key === "Enter" && onOpen(t)}
                    className={cn(
                      "group absolute top-[6px] bottom-[6px] z-10 cursor-grab overflow-hidden rounded-control border border-clay-line bg-clay-d",
                      drag?.id === t.id && "cursor-grabbing ring-1 ring-clay",
                    )}
                    style={{ left, width: Math.max(span, 6) }}
                    title={`${t.name} · ${t.progress} %`}
                  >
                    <div
                      className="absolute inset-y-0 left-0 bg-clay/35"
                      style={{ width: `${t.progress}%` }}
                    />
                    {span > 60 && (
                      <span className="relative truncate px-1.5 text-tiny leading-[20px] font-medium text-clay">
                        {t.name}
                      </span>
                    )}
                    <span
                      className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize"
                      onPointerDown={(e) => down(e, t, "start")}
                    />
                    <span
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
                      onPointerDown={(e) => down(e, t, "end")}
                    />
                  </div>
                )}
                {assignees.length > 0 && (
                  <div
                    className="pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 gap-0.5"
                    style={{ left: left + (t.milestone ? dw / 2 + 12 : Math.max(span, 6) + 6) }}
                  >
                    {assignees.map((p) => (
                      <span
                        key={p.id}
                        title={p.name}
                        className="flex size-[18px] items-center justify-center rounded-full bg-p4 text-micro font-semibold text-tx2"
                      >
                        {initials(p.name)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskDialog({
  planning,
  task,
  onClose,
  onSave,
}: {
  planning: Planning;
  task: PlanningTask | null;
  onClose: () => void;
  onSave: (next: Planning) => void;
}) {
  const today = todayIso();
  const [name, setName] = useState(task?.name ?? "");
  const [phase, setPhase] = useState(task?.phase ?? planning.phases[0] ?? "");
  const [start, setStart] = useState(task?.start ?? today);
  const [end, setEnd] = useState(task?.end ?? addDays(today, 4));
  const [milestone, setMilestone] = useState(task?.milestone ?? false);
  const [people, setPeople] = useState<string[]>(task?.people ?? []);
  const [depends, setDepends] = useState<string[]>(task?.depends ?? []);
  const [progress, setProgress] = useState(String(task?.progress ?? 0));
  const [issue, setIssue] = useState(task?.issue ? String(task.issue) : "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const others = planning.tasks.filter((t) => t.id !== task?.id);
  const phases = [...new Set([...planning.phases, ...planning.tasks.map((t) => t.phase)])].filter(
    Boolean,
  );
  const finalEnd = milestone ? start : end;
  const pct = Math.min(100, Math.max(0, Number(progress) || 0));
  const valid = name.trim() !== "" && start !== "" && finalEnd >= start;
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const submit = () => {
    const next: PlanningTask = {
      id:
        task?.id ??
        uniqueId(
          name,
          planning.tasks.map((t) => t.id),
        ),
      name: name.trim(),
      phase: phase.trim(),
      start,
      end: finalEnd,
      people,
      depends,
      progress: pct,
      milestone,
      ...(Number(issue) > 0 ? { issue: Number(issue) } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    const tasks = task
      ? planning.tasks.map((t) => (t.id === task.id ? next : t))
      : [...planning.tasks, next];
    const nextPhases =
      next.phase && !planning.phases.includes(next.phase)
        ? [...planning.phases, next.phase]
        : planning.phases;
    onSave({ ...planning, tasks, phases: nextPhases });
  };
  const remove = () => {
    if (!task) return;
    onSave({
      ...planning,
      tasks: planning.tasks
        .filter((t) => t.id !== task.id)
        .map((t) => ({ ...t, depends: t.depends.filter((d) => d !== task.id) })),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={640}>
      <DialogHeader title={task ? "Modifier la tâche" : "Nouvelle tâche"} icon="calendar" />
      <DialogBody className="flex max-h-[calc(100vh-220px)] flex-col gap-4 overflow-y-auto">
        <Field label="Nom" htmlFor="tache-nom">
          <Input
            id="tache-nom"
            size="md"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Field label="Phase" htmlFor="tache-phase" hint="étude, conception, développement…">
            <Input
              id="tache-phase"
              size="md"
              list="phases"
              value={phase}
              onChange={(e) => setPhase(e.target.value)}
            />
            <datalist id="phases">
              {phases.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <Field label="Début" htmlFor="tache-debut">
            <Input
              id="tache-debut"
              size="md"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          {!milestone && (
            <Field label="Fin (incluse)" htmlFor="tache-fin">
              <Input
                id="tache-fin"
                size="md"
                type="date"
                value={end}
                min={start}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          )}
          <Field label="Avancement" htmlFor="tache-avancement" hint="%">
            <Input
              id="tache-avancement"
              size="md"
              mono
              inputMode="numeric"
              className="w-[80px]"
              value={progress}
              onChange={(e) => setProgress(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-body-sm text-tx2">
          <input
            type="checkbox"
            checked={milestone}
            onChange={(e) => setMilestone(e.target.checked)}
          />
          Jalon-date (une échéance : démo, mise en ligne…)
        </label>
        {planning.people.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-small font-medium text-tx2">Personnes</span>
            <div className="flex flex-wrap gap-1.5">
              {planning.people.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPeople((l) => toggle(l, p.id))}
                  className={cn(
                    "rounded-badge border px-2 py-0.5 text-caption",
                    people.includes(p.id)
                      ? "border-clay-line bg-clay-d text-clay"
                      : "border-line text-tx3 hover:text-tx2",
                  )}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {others.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-small font-medium text-tx2">Après la fin de</span>
            <div className="flex max-h-[140px] flex-wrap gap-1.5 overflow-y-auto">
              {others.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setDepends((l) => toggle(l, t.id))}
                  className={cn(
                    "max-w-[260px] truncate rounded-badge border px-2 py-0.5 text-caption",
                    depends.includes(t.id)
                      ? "border-blue-line bg-blue-d text-blue"
                      : "border-line text-tx3 hover:text-tx2",
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <Field label="Issue liée" htmlFor="tache-issue" hint="numéro, facultatif">
            <Input
              id="tache-issue"
              size="md"
              mono
              inputMode="numeric"
              className="w-[100px]"
              value={issue}
              onChange={(e) => setIssue(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </Field>
        </div>
        <Field label="Notes" htmlFor="tache-notes">
          <Textarea
            id="tache-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        {task &&
          (confirmDelete ? (
            <Button variant="danger" size="md" onClick={remove}>
              Confirmer la suppression
            </Button>
          ) : (
            <Button variant="quiet" size="md" onClick={() => setConfirmDelete(true)}>
              Supprimer
            </Button>
          ))}
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="primary" size="md" disabled={!valid} onClick={submit}>
          {task ? "Enregistrer" : "Ajouter"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function PeopleDialog({
  planning,
  onClose,
  onSave,
}: {
  planning: Planning;
  onClose: () => void;
  onSave: (next: Planning) => void;
}) {
  const [people, setPeople] = useState(planning.people);
  const [name, setName] = useState("");
  const load = (id: string) => planning.tasks.filter((t) => t.people.includes(id)).length;
  const add = () => {
    if (!name.trim()) return;
    setPeople((l) => [
      ...l,
      {
        id: uniqueId(
          name,
          l.map((p) => p.id),
          "personne",
        ),
        name: name.trim(),
      },
    ]);
    setName("");
  };
  const submit = () => {
    const ids = new Set(people.map((p) => p.id));
    onSave({
      ...planning,
      people,
      tasks: planning.tasks.map((t) => ({ ...t, people: t.people.filter((p) => ids.has(p)) })),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={480}>
      <DialogHeader title="Personnes du planning" icon="user" />
      <DialogBody className="flex flex-col gap-3">
        {people.length === 0 && <p className="text-body-sm text-tx3">Personne pour l'instant.</p>}
        {people.map((p) => (
          <div key={p.id} className="flex items-center gap-2.5">
            <span className="flex size-6 items-center justify-center rounded-full bg-p4 text-micro font-semibold text-tx2">
              {initials(p.name)}
            </span>
            <span className="grow text-body-sm text-tx">{p.name}</span>
            <Badge tone="neutral">{load(p.id)} tâche(s)</Badge>
            <Button
              size="xs"
              variant="quiet"
              iconOnly
              icon="close"
              aria-label={`Retirer ${p.name}`}
              onClick={() => setPeople((l) => l.filter((x) => x.id !== p.id))}
            />
          </div>
        ))}
        <div className="flex gap-2">
          <Input
            size="md"
            placeholder="Nom (ex. Marc, Équipe design)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Button size="md" variant="secondary" icon="plus" disabled={!name.trim()} onClick={add}>
            Ajouter
          </Button>
        </div>
      </DialogBody>
      <DialogFooter>
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="primary" size="md" onClick={submit}>
          Enregistrer
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
