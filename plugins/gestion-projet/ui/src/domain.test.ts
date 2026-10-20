import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import {
  displayLabels,
  estimateLabel,
  issueContext,
  issueKey,
  isStarted,
  isViewId,
  priorityInfo,
  repoShortName,
  views,
} from "./domain";

describe("vues", () => {
  it("couvrent celles du manifeste", () => {
    const manifest = parse(
      readFileSync(new URL("../../plugin.toml", import.meta.url), "utf8"),
    ) as any;
    const declared: string[] = [
      ...manifest.ui.views.map((v: { id: string }) => v.id),
      ...manifest.setup.map((s: { view: string }) => s.view),
    ];
    expect(declared.filter((id) => !isViewId(id))).toEqual([]);
    for (const v of manifest.ui.views) expect(views[v.id as keyof typeof views].icon).toBe(v.icon);
  });
});

describe("manifeste", () => {
  it("déclare la catégorie projet et le service repos, sans secret GitHub", () => {
    const manifest = parse(
      readFileSync(new URL("../../plugin.toml", import.meta.url), "utf8"),
    ) as any;
    expect(manifest.category).toBe("projet");
    expect(manifest.services).toEqual(["repos"]);
    expect(manifest.secrets).toBeUndefined();
  });
});

describe("dépôts", () => {
  it("identifie une issue par dépôt et numéro", () => {
    const a = { repo: "me/app", number: 4 };
    expect(issueKey(a)).not.toBe(issueKey({ repo: "me/site", number: 4 }));
    expect(issueContext(a)).toEqual({ type: "issue", repo: "me/app", issue: 4 });
    expect(repoShortName("RemiSDV/cadence-plugins")).toBe("cadence-plugins");
  });
});

describe("labels", () => {
  it("masque les labels conventionnés", () => {
    expect(displayLabels(["type/feat", "status/doing", "estimate/M", "area/api"])).toEqual([
      "area/api",
    ]);
    expect(displayLabels(["sp/5", "priority/0", "area/ui"])).toEqual(["area/ui"]);
  });

  it("montre les story points, sinon l'ancienne taille, et la priorité", () => {
    expect(estimateLabel({ points: 5, estimate: "L" })).toBe("5 SP");
    expect(estimateLabel({ points: null, estimate: "M" })).toBe("M");
    expect(estimateLabel({ points: null, estimate: null })).toBeNull();
    expect(priorityInfo(0).label).toBe("P0 · socle");
    expect(priorityInfo(1)).toMatchObject({ label: "P1", tone: "red" });
    expect(priorityInfo(5)).toMatchObject({ label: "P5", tone: "muted" });
  });
});

describe("sprints automatiques", () => {
  const project = {
    issue: 24,
    url: "https://github.com/Remisdv/Go-Alternance-CRM-POC/issues/24",
    paused_since: null,
    duration_days: 7,
    points_per_day: 1.4,
    capacity: null,
    next_capacity: 10,
    current: null,
    release_branch: null,
    carried: [],
  };

  it("ne prend pas une issue d'état « idle » (jalons seuls) pour des sprints démarrés", () => {
    expect(isStarted(null)).toBe(false);
    expect(isStarted(undefined)).toBe(false);
    // Issue #24 de Remisdv/Go-Alternance-CRM-POC : jalons créés, sprints jamais démarrés.
    expect(isStarted({ ...project, status: "idle", sprints: [] })).toBe(false);
    const sprint = {
      version: "0.1.0",
      branch: "release/0.1.0",
      start_on: "2026-10-20",
      due_on: "2026-10-20",
      paused_days: 0,
      capacity: 1,
      filled: true,
    };
    expect(isStarted({ ...project, status: "running", sprints: [sprint] })).toBe(true);
    expect(isStarted({ ...project, status: "paused", sprints: [sprint] })).toBe(true);
  });
});
