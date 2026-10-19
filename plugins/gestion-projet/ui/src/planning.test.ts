import { describe, expect, it } from "vitest";
import type { Issue, PullRequest, Version } from "./domain";
import {
  buildRoadmap,
  ciLabel,
  closeChecks,
  compareVersions,
  currentVersion,
  daysLeftLabel,
  delayLabel,
  durationLabel,
  durationOptions,
  formatRange,
  gainedToday,
  releaseInfo,
  releaseNotes,
  requiredPace,
  reviewSummary,
  sortVersions,
  sprintBoard,
  sprintStart,
  statusMeters,
  versionStage,
} from "./planning";

const issue = (number: number, extra: Partial<Issue> = {}): Issue => ({
  repo: "me/app",
  number,
  title: `Issue ${number}`,
  state: "open",
  status: "todo",
  type: "feat",
  estimate: null,
  points: null,
  priority: null,
  labels: [],
  milestone: "0.1.2",
  assignees: [],
  author: null,
  comments: 0,
  url: "",
  updated_at: "2026-10-01T00:00:00Z",
  ...extra,
});

const version = (title: string, extra: Partial<Version> = {}): Version => ({
  title,
  number: 1,
  kind: "sprint",
  state: "open",
  due_on: null,
  name: null,
  themes: [],
  description: null,
  open_issues: 0,
  closed_issues: 0,
  url: "",
  ...extra,
});

const pr = (extra: Partial<PullRequest> = {}): PullRequest => ({
  repo: "me/app",
  number: 1,
  title: "PR",
  state: "open",
  head: "feat/1-x",
  base: "main",
  author: "me",
  url: "",
  milestone: null,
  labels: [],
  closes: [],
  ci: { state: "none", passed: 0, total: 0 },
  review: null,
  approvals: 0,
  changes_requested: 0,
  reviewers: [],
  review_requested_at: null,
  additions: 0,
  deletions: 0,
  changed_files: 0,
  comments: 0,
  created_at: null,
  updated_at: null,
  ...extra,
});

describe("sprint", () => {
  it("range les issues par état et tronque « Fait »", () => {
    const issues = [
      issue(3, { status: "doing" }),
      issue(1, { status: "doing" }),
      ...[10, 11, 12].map((n) =>
        issue(n, { status: "done", updated_at: `2026-10-0${n - 9}T00:00:00Z` }),
      ),
    ];
    const board = sprintBoard(issues, 2);
    expect(board.map((c) => c.status)).toEqual(["todo", "doing", "review", "done"]);
    expect(board[1]!.issues.map((i) => i.number)).toEqual([1, 3]);
    expect(board[3]!.issues.map((i) => i.number)).toEqual([12, 11]);
    expect(board[3]!.total).toBe(3);
  });

  it("libelle le retard, les jours restants et le rythme requis", () => {
    expect(delayLabel(1.5)).toEqual({ text: "1,5 j de retard", tone: "amber" });
    expect(delayLabel(-2)).toEqual({ text: "2 j d'avance", tone: "green" });
    expect(delayLabel(0.2).tone).toBe("tx3");
    expect(daysLeftLabel(6)).toBe("6 jours restants");
    expect(daysLeftLabel(0)).toBe("dernier jour");
    expect(daysLeftLabel(-2)).toBe("échéance dépassée de 2 j");
    expect(daysLeftLabel(null)).toBe("sans échéance");
    expect(requiredPace(7, 5)).toBe(1.4);
    expect(requiredPace(7, 0)).toBeNull();
    expect(gainedToday([{ remaining: 8 }, { remaining: 6 }], 10)).toBe(20);
  });

  it("calcule le début du sprint et les jauges", () => {
    expect(sprintStart("2026-10-20T07:00:00Z", 14)).toBe("2026-10-06");
    expect(formatRange("2026-10-06", "2026-10-20")).toMatch(/^6 oct\. → 20 oct\.$/);
    const meters = statusMeters({ todo: 1, doing: 1, review: 0, done: 2 });
    expect(meters.map((m) => [m.label, m.value, m.percent])).toEqual([
      ["Fermées", 2, 50],
      ["En revue", 0, 0],
      ["En cours", 1, 25],
      ["À faire", 1, 25],
    ]);
  });
});

describe("versions", () => {
  const versions = [
    version("0.1.1", { state: "closed", due_on: "2026-10-01T07:00:00Z" }),
    version("0.1.3", { due_on: "2026-11-03T07:00:00Z" }),
    version("0.1.2", { due_on: "2026-10-20T07:00:00Z" }),
    version("0.2.0", { kind: "palier" }),
    version("1.0.0", { kind: "palier" }),
  ];

  it("trie en semver et trouve la version en cours comme le serveur", () => {
    expect(["0.11.0", "0.2.0", "v0.10.1", "x"].sort(compareVersions)).toEqual([
      "0.2.0",
      "v0.10.1",
      "0.11.0",
      "x",
    ]);
    expect(currentVersion(versions, "2026-10-17")).toBe("0.1.2");
    expect(currentVersion(versions, "2026-10-21")).toBe("0.1.3");
    expect(currentVersion(versions, "2026-12-01")).toBe("0.1.3");
    expect(currentVersion(versions.slice(3), "2026-10-17")).toBeNull();
  });

  it("classe les versions de la roadmap", () => {
    const current = "0.1.2";
    expect(versions.map((v) => versionStage(v, current))).toEqual([
      "shipped",
      "planned",
      "current",
      "milestone",
      "vision",
    ]);
    const roadmap = buildRoadmap(versions, current);
    expect(roadmap.shipped.map((v) => v.title)).toEqual(["0.1.1"]);
    expect(roadmap.current?.title).toBe("0.1.2");
    expect(roadmap.planned.map((v) => v.title)).toEqual(["0.1.3", "0.2.0", "1.0.0"]);
    expect(sortVersions(versions, current).map((v) => v.title)).toEqual([
      "0.1.2",
      "0.1.3",
      "0.2.0",
      "1.0.0",
      "0.1.1",
    ]);
  });

  it("prépare les notes et les conditions de clôture", () => {
    const issues = [
      issue(1, { status: "done", type: "feat" }),
      issue(2, { status: "done", type: "fix" }),
      issue(3, { status: "done", type: null }),
      issue(4),
    ];
    expect(releaseNotes(issues).map((s) => [s.title, s.items])).toEqual([
      ["Nouveautés", ["Issue 1 (#1)"]],
      ["Corrections", ["Issue 2 (#2)"]],
      ["Maintenance", ["Issue 3 (#3)"]],
    ]);
    const checks = closeChecks(issues, [
      pr({ ci: { state: "failure", passed: 1, total: 2 } }),
      pr({ state: "merged" }),
    ]);
    expect(checks).toEqual([
      { ok: false, text: "1 issue encore ouverte" },
      { ok: false, text: "1 PR non fusionnée" },
      { ok: false, text: "CI en échec sur 1 PR" },
    ]);
    expect(closeChecks([issue(1, { status: "done" })], []).every((c) => c.ok)).toBe(true);
  });
});

describe("pull requests", () => {
  it("résume la CI et les revues", () => {
    expect(ciLabel({ state: "failure", passed: 3, total: 4 })).toBe("3/4");
    expect(ciLabel({ state: "pending", passed: 0, total: 2 })).toBe("en cours");
    expect(ciLabel({ state: "none", passed: 0, total: 0 })).toBe("—");
    const now = new Date("2026-10-17T12:00:00Z");
    expect(reviewSummary(pr({ changes_requested: 2 }), now)).toEqual({
      text: "2 changements demandés",
      tone: "amber",
    });
    expect(reviewSummary(pr({ approvals: 1 }), now)).toEqual({
      text: "1 approbation",
      tone: "green",
    });
    expect(reviewSummary(pr({ review_requested_at: "2026-10-17T06:00:00Z" }), now)).toEqual({
      text: "en attente · 6 h",
      tone: "amber",
    });
    expect(reviewSummary(pr({ review_requested_at: "2026-10-14T06:00:00Z" }), now)?.tone).toBe(
      "red",
    );
    expect(
      reviewSummary(pr({ state: "merged", review_requested_at: "2026-10-14T06:00:00Z" }), now),
    ).toBeNull();
  });
});

describe("sprints automatiques", () => {
  it("nomme les durées en semaines ou en jours", () => {
    expect(durationLabel(7)).toBe("1 semaine");
    expect(durationLabel(14)).toBe("2 semaines");
    expect(durationLabel(10)).toBe("10 jours");
    expect(durationOptions(14)).toEqual([7, 14, 21, 28]);
    expect(durationOptions(10)).toEqual([7, 10, 14, 21, 28]);
  });

  it("décrit la livraison d'un sprint terminé", () => {
    expect(releaseInfo({ status: "merged", tag: "v0.2.0" })).toMatchObject({
      label: "v0.2.0 publiée",
      tone: "green",
    });
    expect(releaseInfo({ status: "blocked", message: "CI en échec sur la PR #12." })).toEqual({
      label: "Livraison bloquée",
      tone: "red",
      detail: "CI en échec sur la PR #12.",
    });
    expect(releaseInfo({ status: "pending" }).tone).toBe("amber");
    expect(releaseInfo(null).label).toBe("En cours");
  });
});
