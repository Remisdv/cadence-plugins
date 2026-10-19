import { describe, expect, it } from "vitest";
import type { PlanningTask } from "./domain";
import {
  addDays,
  daysBetween,
  ganttRange,
  ganttRows,
  initials,
  isWeekend,
  mondayOf,
  monthBands,
  shiftTask,
  ticks,
  uniqueId,
} from "./gantt";

const task = (id: string, phase: string, start: string, end: string): PlanningTask => ({
  id,
  name: id,
  phase,
  start,
  end,
  people: [],
  depends: [],
  progress: 0,
  milestone: false,
});

describe("planning (Gantt)", () => {
  it("compte les jours civils", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
    expect([isWeekend("2026-10-24"), isWeekend("2026-10-26")]).toEqual([true, false]);
  });

  it("cadre la période sur les tâches et aujourd'hui", () => {
    const r = ganttRange([task("a", "", "2026-11-02", "2026-11-20")], "2026-10-19", "day");
    expect(r.start).toBe("2026-10-12");
    expect(addDays(r.start, r.days - 1)).toBe("2026-12-01");
    expect(ganttRange([], "2026-10-19", "month").start <= "2026-09-28").toBe(true);
  });

  it("gradue selon le zoom", () => {
    expect(ticks("2026-10-26", 10, "day").map((t) => t.label)).toEqual([
      "26",
      "27",
      "28",
      "29",
      "30",
      "31",
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(ticks("2026-10-26", 10, "day")[6]!.major).toBe(true);
    expect(ticks("2026-10-26", 14, "week").map((t) => t.offset)).toEqual([0, 7]);
    expect(ticks("2026-10-26", 40, "month").map((t) => t.offset)).toEqual([0, 6, 36]);
    expect(monthBands("2026-10-26", 10).map((b) => b.days)).toEqual([6, 4]);
  });

  it("groupe les tâches par phase", () => {
    const rows = ganttRows(
      [
        task("dev", "Développement", "2026-11-02", "2026-11-20"),
        task("libre", "", "2026-10-20", "2026-10-21"),
        task("etude2", "Étude", "2026-10-26", "2026-10-30"),
        task("etude1", "Étude", "2026-10-19", "2026-10-23"),
      ],
      ["Étude", "Développement"],
    );
    expect(rows.map((r) => (r.kind === "phase" ? `[${r.phase}]` : r.task.id))).toEqual([
      "[Étude]",
      "etude1",
      "etude2",
      "[Développement]",
      "dev",
      "[]",
      "libre",
    ]);
  });

  it("déplace et redimensionne sans inverser les dates", () => {
    const t = { start: "2026-10-19", end: "2026-10-23", milestone: false };
    expect(shiftTask(t, "move", 7)).toEqual({ start: "2026-10-26", end: "2026-10-30" });
    expect(shiftTask(t, "end", -10)).toEqual({ start: "2026-10-19", end: "2026-10-19" });
    expect(shiftTask(t, "start", 2)).toEqual({ start: "2026-10-21", end: "2026-10-23" });
    expect(shiftTask({ ...t, milestone: true }, "end", 1).start).toBe("2026-10-20");
  });

  it("fabrique identifiants et initiales", () => {
    expect(uniqueId("Étude de marché", [])).toBe("etude-de-marche");
    expect(uniqueId("Étude de marché", ["etude-de-marche"])).toBe("etude-de-marche-2");
    expect(uniqueId("!!!", [])).toBe("tache");
    expect(initials("Rémi Lhuillier")).toBe("RL");
  });
});
