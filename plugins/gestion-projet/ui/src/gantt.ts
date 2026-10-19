/**
 * Calculs du planning (Gantt) : dates civiles `AAAA-MM-JJ` en UTC, période affichée, lignes par
 * phase, graduations selon le zoom, identifiants. Fonctions pures, testées.
 */
import type { PlanningTask } from "./domain";

const DAY = 86_400_000;

const toTime = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const toIso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  return toIso(toTime(iso) + days * DAY);
}

/** Jours de `from` à `to` (négatif si `to` est avant). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toTime(to) - toTime(from)) / DAY);
}

/** 0 = dimanche … 6 = samedi. */
export function weekday(iso: string): number {
  return new Date(toTime(iso)).getUTCDay();
}

export const isWeekend = (iso: string) => weekday(iso) === 0 || weekday(iso) === 6;

/** Lundi de la semaine d'un jour. */
export function mondayOf(iso: string): string {
  return addDays(iso, -((weekday(iso) + 6) % 7));
}

export type Zoom = "day" | "week" | "month";

/** Largeur d'un jour en pixels selon le zoom. */
export const dayWidth: Record<Zoom, number> = { day: 34, week: 14, month: 4.5 };

/** Période affichée : des tâches (et d'aujourd'hui), avec une marge, alignée sur un lundi. */
export function ganttRange(
  tasks: Pick<PlanningTask, "start" | "end">[],
  today: string,
  zoom: Zoom,
): { start: string; days: number } {
  const starts = [today, ...tasks.map((t) => t.start)].sort();
  const ends = [today, ...tasks.map((t) => t.end)].sort();
  const margin = zoom === "month" ? 21 : zoom === "week" ? 10 : 4;
  const start = mondayOf(addDays(starts[0]!, -margin));
  const end = addDays(ends[ends.length - 1]!, margin + (zoom === "day" ? 7 : 28));
  return { start, days: daysBetween(start, end) + 1 };
}

export interface Tick {
  /** Décalage en jours depuis le début de la période. */
  offset: number;
  label: string;
  /** Début d'un mois (trait plus marqué). */
  major: boolean;
}

const monthFmt = new Intl.DateTimeFormat("fr-FR", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthShort = new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" });

/** Graduations : un jour (zoom jour), un lundi (semaine) ou un mois. */
export function ticks(start: string, days: number, zoom: Zoom): Tick[] {
  const out: Tick[] = [];
  for (let i = 0; i < days; i++) {
    const iso = addDays(start, i);
    const firstOfMonth = iso.endsWith("-01");
    if (zoom === "day")
      out.push({ offset: i, label: String(Number(iso.slice(8))), major: firstOfMonth });
    else if (zoom === "week" && weekday(iso) === 1)
      out.push({
        offset: i,
        label: `${Number(iso.slice(8))} ${monthShort.format(new Date(toTime(iso)))}`,
        major: false,
      });
    else if (zoom === "month" && (firstOfMonth || i === 0))
      out.push({ offset: i, label: monthFmt.format(new Date(toTime(iso))), major: true });
  }
  return out;
}

/** Bandeau des mois au-dessus des graduations (zooms jour et semaine). */
export function monthBands(
  start: string,
  days: number,
): { offset: number; days: number; label: string }[] {
  const out: { offset: number; days: number; label: string }[] = [];
  for (let i = 0; i < days; i++) {
    const iso = addDays(start, i);
    if (i === 0 || iso.endsWith("-01"))
      out.push({ offset: i, days: 0, label: monthFmt.format(new Date(toTime(iso))) });
    out[out.length - 1]!.days++;
  }
  return out;
}

export type GanttRow =
  { kind: "phase"; phase: string; count: number } | { kind: "task"; task: PlanningTask };

/** Lignes : phases dans l'ordre déclaré (puis les autres, « Sans phase » en dernier), tâches par début. */
export function ganttRows(tasks: PlanningTask[], phases: string[]): GanttRow[] {
  const seen = [...phases];
  for (const t of tasks) if (!seen.includes(t.phase)) seen.push(t.phase);
  const ordered = [...seen.filter((p) => p !== ""), ...(seen.includes("") ? [""] : [])];
  const rows: GanttRow[] = [];
  for (const phase of ordered) {
    const items = tasks
      .filter((t) => t.phase === phase)
      .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    if (items.length === 0) continue;
    rows.push({ kind: "phase", phase, count: items.length });
    for (const task of items) rows.push({ kind: "task", task });
  }
  return rows;
}

/** `Étude de marché` → `etude-de-marche`, suffixé tant que l'identifiant est pris. */
export function uniqueId(name: string, taken: string[], fallback = "tache"): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Initiales d'un nom (« Rémi Lhuillier » → « RL »). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Déplacement (`move`) ou redimensionnement d'une tâche de `delta` jours ; la fin reste ≥ début. */
export function shiftTask(
  task: Pick<PlanningTask, "start" | "end" | "milestone">,
  mode: "move" | "start" | "end",
  delta: number,
): { start: string; end: string } {
  if (mode === "move" || task.milestone)
    return { start: addDays(task.start, delta), end: addDays(task.end, delta) };
  if (mode === "start") {
    const start = addDays(task.start, delta);
    return { start: start > task.end ? task.end : start, end: task.end };
  }
  const end = addDays(task.end, delta);
  return { start: task.start, end: end < task.start ? task.start : end };
}
