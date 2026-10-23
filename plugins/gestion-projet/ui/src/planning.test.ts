import { describe, expect, it } from "vitest";
import type { Issue, PullRequest, Version } from "./domain";
import {
  buildRoadmap,
  capacityFor,
  carryOver,
  closeSprintLead,
  deliveredLabel,
  moveMessage,
  dueFor,
  issueWeight,
  pointsByStatus,
  ciLabel,
  closeChecks,
  compareVersions,
  currentVersion,
  daysLeftLabel,
  delayLabel,
  delayTile,
  durationLabel,
  durationOptions,
  estimateRange,
  formatDate,
  jalonSpan,
  formatRange,
  gainedToday,
  releaseInfo,
  releaseShippedMessage,
  recentReleases,
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
  issues: [1],
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
    // 5 jours après aujourd'hui : 6 jours pour fermer 7 issues.
    expect(requiredPace(7, 5)).toBe(1.2);
    // Dernier jour (sprint d'un jour compris) : tout aujourd'hui.
    expect(requiredPace(3, 0)).toBe(3);
    expect(requiredPace(7, -1)).toBeNull();
    expect(requiredPace(7, null)).toBeNull();
    // Delta en story points, jamais en points de pourcentage (R07 : « +11 aujourd'hui » pour 2 SP / 18).
    expect(gainedToday([{ remaining: 18 }, { remaining: 16 }])).toBe(2);
    expect(gainedToday([{ remaining: 8 }, { remaining: 10 }])).toBe(0);
    expect(gainedToday([{ remaining: 8 }])).toBe(0);
    // Retard avec son unité, cohérent avec l'état affiché.
    expect(delayTile(0.1)).toEqual({ label: "Retard", value: "0 j", hint: "dans les temps", tone: "tx" });
    expect(delayTile(-0.3).value).toBe("0 j");
    expect(delayTile(1.5)).toEqual({ label: "Retard", value: "1,5 j", hint: "sur la droite idéale", tone: "amber" });
    expect(delayTile(-2)).toEqual({ label: "Avance", value: "2 j", hint: "sur la droite idéale", tone: "green" });
  });

  it("calcule le début du sprint et les jauges", () => {
    expect(sprintStart("2026-10-20T07:00:00Z", 14)).toBe("2026-10-07");
    expect(sprintStart("2026-10-20", 1)).toBe("2026-10-20");
    expect(sprintStart("2026-10-20", 2)).toBe("2026-10-19");
    expect(formatRange("2026-10-06", "2026-10-20")).toMatch(/^6 oct\. → 20 oct\.$/);
    const meters = statusMeters({ todo: 1, doing: 1, review: 0, done: 2 });
    expect(meters.map((m) => [m.label, m.value, m.percent])).toEqual([
      ["Fermées", 2, 50],
      ["En revue", 0, 0],
      ["En cours", 1, 25],
      ["À faire", 1, 25],
    ]);
  });

  it("mesure le sprint en story points (3 SP sans estimation)", () => {
    const list = [
      issue(2, { points: 8 }),
      issue(3, { points: 8, status: "doing" }),
      issue(15, { points: 1, status: "done" }),
      issue(16, { points: null, status: "done" }),
    ];
    expect(issueWeight(list[3]!)).toBe(3);
    const points = pointsByStatus(list);
    expect(points).toEqual({ todo: 8, doing: 8, review: 0, done: 4 });
    expect(statusMeters(points, "SP").map((m) => m.value)).toEqual([
      "4 SP",
      "0 SP",
      "8 SP",
      "8 SP",
    ]);
  });

  it("calcule capacité et échéance comme le serveur (constat P09)", () => {
    // 0,4 SP / jour sur un jour : au moins 1 SP.
    expect([capacityFor(0.4, 1), capacityFor(0, 7), capacityFor(1.6, 14)]).toEqual([1, 1, 22]);
    expect(dueFor("2026-10-19", 21, 0, "2026-10-21")).toBe("2026-11-08");
    expect(dueFor("2026-10-19", 1, 0, "2026-10-21")).toBe("2026-10-21");
    expect(dueFor("2026-10-19", 3, 2, "2026-10-19")).toBe("2026-10-23");
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
    expect(durationLabel(1)).toBe("1 jour");
    expect(durationLabel(2)).toBe("2 jours");
    // Sprints courts proposés, dès un jour.
    expect(durationOptions(14)).toEqual([1, 2, 3, 4, 5, 7, 10, 14, 21, 28]);
    expect(durationOptions(6)).toEqual([1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28]);
    expect(durationOptions(1)[0]).toBe(1);
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
    // R09 : historique de la livraison dans les sprints terminés.
    expect(releaseInfo({ status: "merged", tag: "v0.2.0", pull_request: 25 }).detail).toBe(
      "PR #25 fusionnée",
    );
    expect(
      releaseInfo({ status: "merged", tag: "v0.2.0", pull_request: 25, merged_at: "2026-10-21T12:42:00Z" })
        .detail,
    ).toMatch(/^PR #25 fusionnée le 21 oct\. à \d{2}:\d{2}$/);
    expect(releaseInfo({ status: "merged" }).detail).toBeNull();
    expect(releaseInfo(null).label).toBe("En cours");
  });
  it("ne garde au sprint suivant que ce qui tient dans sa capacité (N13)", () => {
    // Recette du 21/10 : #2 (socle, 8 SP) et #3 (P1, 8 SP) dans un sprint de 1 SP.
    const open = [issue(3, { priority: 1, points: 8 }), issue(2, { priority: 0, points: 8 })];
    expect(carryOver(open, 1)).toEqual({ keep: [2], excess: [3], keepPoints: 8, excessPoints: 8 });
    expect(carryOver(open, 16).excess).toEqual([]);
    // Une petite issue moins prioritaire tient encore après une grosse qui ne tient pas.
    const mix = [
      issue(1, { priority: 1, points: 5 }),
      issue(2, { priority: 2, points: 8 }),
      issue(3, { priority: null, points: 2 }),
    ];
    expect(carryOver(mix, 8)).toMatchObject({ keep: [1, 3], excess: [2], keepPoints: 7 });
    expect(carryOver([], 3)).toMatchObject({ keep: [], excess: [] });
    // Une issue déjà en revue (sa PR est ouverte) passe toujours, avant une issue à faire.
    const review = [
      issue(5, { priority: 0, points: 3 }),
      issue(6, { priority: 3, points: 3, status: "review" }),
    ];
    expect(carryOver(review, 3)).toMatchObject({ keep: [6], excess: [5] });
    const twoInReview = [
      issue(7, { points: 8, status: "review" }),
      issue(8, { points: 5, status: "doing" }),
      issue(9, { priority: 0, points: 1 }),
    ];
    expect(carryOver(twoInReview, 2)).toMatchObject({ keep: [7, 8], excess: [9], keepPoints: 13 });
  });

  it("formule la clôture selon l'échéance (N13)", () => {
    expect(closeSprintLead("2026-10-21", "2026-10-21")).toBe(
      "Le sprint se termine aujourd'hui, à son échéance",
    );
    expect(closeSprintLead("2026-10-23T00:00:00Z", "2026-10-21")).toBe(
      "Le sprint se termine aujourd'hui, au lieu de l'échéance du 23 oct.",
    );
  });

  it("compte les SP livrés sur la portée du sprint terminé (N14)", () => {
    // Même format pour tous les sprints terminés (recette 3 : « 4 SP livrés » / « 5 / 21 SP »).
    expect(deliveredLabel({ done_points: 4, scope_points: 20 })).toBe("4 / 20 SP");
    expect(deliveredLabel({ done_points: 4, scope_points: 4 })).toBe("4 / 4 SP");
    expect(deliveredLabel({ done_points: 5 })).toBe("5 / — SP");
    expect(deliveredLabel({})).toBe("0 / — SP");
  });

  it("annonce une release livrée, en fond comme à la demande (R09)", () => {
    expect(releaseShippedMessage("0.2.0", { pull_request: 25, tag: "v0.2.0" })).toBe(
      "Release 0.2.0 livrée : PR #25 fusionnée, tag v0.2.0.",
    );
    expect(releaseShippedMessage("0.2.0", {})).toBe(
      "Release 0.2.0 livrée : branche de release fusionnée.",
    );
    const now = new Date("2026-10-21T15:00:00Z");
    const sprints = [
      { version: "0.1.0", ended_on: "2026-10-10", release: { status: "merged" as const, tag: "v0.1.0" } },
      {
        version: "0.2.0",
        ended_on: "2026-10-20",
        release: { status: "merged" as const, tag: "v0.2.0", pull_request: 25, merged_at: "2026-10-21T12:42:00Z" },
      },
      {
        version: "0.3.0",
        ended_on: "2026-10-21",
        release: { status: "merged" as const, pull_request: 30, merged_at: "2026-10-19T12:00:00Z" },
      },
      { version: "0.4.0", ended_on: null, release: null },
    ];
    expect(recentReleases("Me/App", sprints, new Set(), now)).toEqual([
      { key: "me/app@0.2.0", version: "0.2.0", message: "Release 0.2.0 livrée : PR #25 fusionnée, tag v0.2.0." },
    ]);
    expect(recentReleases("me/app", sprints, new Set(["me/app@0.2.0"]), now)).toEqual([]);
  });

  it("résume un ajout ou un retrait d'issues du sprint (N08)", () => {
    expect(moveMessage({ added: [20, 21], removed: [], skipped: [] }, "0.2.0")).toEqual({
      text: "#20, #21 ajoutées au sprint 0.2.0.",
      kind: "success",
    });
    expect(moveMessage({ added: [], removed: [21], skipped: [] }, "0.2.0").text).toBe(
      "#21 retirée du sprint 0.2.0 (retour au carnet).",
    );
    expect(
      moveMessage(
        { added: [4], removed: [], skipped: [{ issue: 9, reason: "issue fermée" }] },
        "0.2.0",
      ),
    ).toEqual({
      text: "#4 ajoutée au sprint 0.2.0 ; 1 refusée : #9 (issue fermée).",
      kind: "warning",
    });
    expect(moveMessage({ added: [], removed: [], skipped: [] }, "0.2.0").kind).toBe("info");
  });
});

describe("roadmap par jalons", () => {
  it("date les jalons avec l'année quand elle change", () => {
    expect(formatDate("2026-11-16", "2026-10-19")).toBe("16 nov.");
    expect(formatDate("2027-01-25", "2026-10-19")).toBe("25 janv. 2027");
  });

  it("donne la fourchette seulement si elle n'est pas réduite à un jour", () => {
    expect(estimateRange("2026-11-16", "2026-11-02", "2026-11-30", "2026-10-19")).toEqual({
      date: "16 nov.",
      range: "entre le 2 nov. et le 30 nov.",
    });
    expect(estimateRange("2026-11-16", "2026-11-16", "2026-11-16", "2026-10-19").range).toBeNull();
    expect(estimateRange(null, null, null, "2026-10-19")).toEqual({ date: null, range: null });
  });

  it("place un jalon sur les colonnes de ses sprints", () => {
    const sprints = [{ version: "0.1.0" }, { version: "0.2.0" }, { version: "0.3.0" }];
    expect(jalonSpan({ sprints: ["0.3.0", "0.2.0"] }, sprints)).toEqual({ from: 1, to: 2 });
    expect(jalonSpan({ sprints: ["9.9.9"] }, sprints)).toBeNull();
    expect(jalonSpan({ sprints: [] }, sprints)).toBeNull();
  });
});
