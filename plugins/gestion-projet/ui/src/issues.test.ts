import { describe, expect, it } from "vitest";
import type { PullRequest } from "./domain";
import {
  createIssueArgs,
  documentContext,
  fileName,
  isIssueSort,
  issueRoute,
  parseIssueRoute,
  priorityRank,
  prIssueLinks,
  prVersion,
  pullRequestFor,
  pullsForIssue,
  releaseVersion,
  sortIssues,
  sortJalonIssues,
  type IssueForm,
} from "./issues";
import { compareVersions } from "./planning";

const it_ = (number: number, priority: number | null, extra: Record<string, unknown> = {}) => ({
  repo: "me/app",
  number,
  priority,
  updated_at: null as string | null,
  ...extra,
});

describe("tri des issues", () => {
  it("range par priorité (P0 socle, P1… P5, puis sans priorité) puis par numéro, comme le serveur", () => {
    // Cas du rapport de recette : « À faire » affichait P0, P1, P2, P1, P2, P5, P4, P1.
    const list = [
      it_(3, 0),
      it_(8, 1),
      it_(5, 2),
      it_(2, 1),
      it_(9, 2),
      it_(4, 5),
      it_(7, 4),
      it_(6, 1),
      it_(1, null),
    ];
    expect(sortIssues(list, "priority").map((i) => i.number)).toEqual([3, 2, 6, 8, 5, 9, 7, 4, 1]);
    expect(priorityRank(null)).toBeGreaterThan(priorityRank(5));
    expect(list[0]!.number).toBe(3); // copie : la liste d'origine n'est pas triée sur place
  });

  it("trie par numéro, par activité, ou dans l'ordre des jalons de la roadmap", () => {
    const list = [
      it_(17, 2, { updated_at: "2026-10-21T09:00:00Z" }),
      it_(15, 0, { updated_at: "2026-10-20T09:00:00Z" }),
      it_(16, 1, { updated_at: "2026-10-21T10:00:00Z" }),
      it_(2, 3),
    ];
    expect(sortIssues(list, "number").map((i) => i.number)).toEqual([2, 15, 16, 17]);
    expect(sortIssues(list, "updated").map((i) => i.number)).toEqual([16, 17, 15, 2]);
    // #2 dans le premier jalon, #15–#17 dans le second, les autres sans jalon.
    const jalon = (i: { number: number }) => (i.number === 2 ? 0 : i.number === 17 ? null : 1);
    expect(sortIssues(list, "roadmap", jalon).map((i) => i.number)).toEqual([2, 15, 16, 17]);
    expect(sortIssues(list, "roadmap").map((i) => i.number)).toEqual([15, 16, 17, 2]);
    expect(isIssueSort("roadmap")).toBe(true);
    expect(isIssueSort("autre")).toBe(false);
  });

  it("sépare les dépôts à priorité égale (mode « Tous les dépôts »)", () => {
    const list = [
      it_(1, 1, { repo: "me/b" }),
      it_(9, 1, { repo: "me/a" }),
      it_(2, 0, { repo: "me/b" }),
    ];
    expect(sortIssues(list, "priority").map((i) => `${i.repo}#${i.number}`)).toEqual([
      "me/b#2",
      "me/a#9",
      "me/b#1",
    ]);
  });

  it("trie les issues d'un jalon par priorité, par sprint ou par numéro", () => {
    // Jalon « Mini-projet » du rapport : #17 (P2), #16 (P1), #15 (P0).
    const issues = [
      { number: 17, priority: 2, sprint: null },
      { number: 16, priority: 1, sprint: "0.10.0" },
      { number: 15, priority: 0, sprint: "0.2.0" },
      { number: 14, priority: 3, sprint: "0.2.0" },
    ];
    expect(sortJalonIssues(issues, "priority", compareVersions).map((i) => i.number)).toEqual([
      15, 16, 17, 14,
    ]);
    expect(sortJalonIssues(issues, "sprint", compareVersions).map((i) => i.number)).toEqual([
      15, 14, 16, 17,
    ]);
    expect(sortJalonIssues(issues, "number", compareVersions).map((i) => i.number)).toEqual([
      14, 15, 16, 17,
    ]);
  });
});

const pr = (extra: Partial<PullRequest>): PullRequest => ({
  repo: "me/app",
  number: 18,
  title: "feat : bonjour",
  state: "draft",
  head: "feat/15-bonjour",
  base: "release/0.2.0",
  author: "me",
  url: "https://github.com/me/app/pull/18",
  milestone: null,
  labels: [],
  closes: [],
  // Comme le serveur : `closes` plus l'issue de la branche `feat/15-…`.
  issues: [15],
  ci: { state: "none", passed: 0, total: 0 },
  review: null,
  approvals: 0,
  changes_requested: 0,
  reviewers: [],
  review_requested_at: null,
  additions: 12,
  deletions: 0,
  changed_files: 1,
  comments: 0,
  created_at: null,
  updated_at: null,
  ...extra,
});

describe("pull requests", () => {
  it("déduit la version de la branche cible release/<version>, après le milestone", () => {
    expect(releaseVersion("release/0.2.0")).toBe("0.2.0");
    expect(releaseVersion("main")).toBeNull();
    expect(prVersion(pr({}))).toBe("0.2.0");
    expect(prVersion(pr({ milestone: "0.3.0" }))).toBe("0.3.0");
    expect(prVersion(pr({ base: "main" }))).toBeNull();
  });

  it("sépare les issues fermées par la PR de celles liées par sa seule branche", () => {
    expect(prIssueLinks(pr({}))).toEqual({ closes: [], branch: [15] });
    expect(prIssueLinks(pr({ closes: [15, 20], issues: [15, 20] }))).toEqual({
      closes: [15, 20],
      branch: [],
    });
    expect(prIssueLinks(pr({ closes: [20], issues: [20, 15] }))).toEqual({
      closes: [20],
      branch: [15],
    });
    expect(prIssueLinks(pr({ head: "chore/maj", issues: [] }))).toEqual({ closes: [], branch: [] });
  });

  it("liste les PR d'une issue d'après `issues` du serveur, ouvertes d'abord", () => {
    const pulls = [
      pr({ number: 10, state: "closed", head: "feat/15-essai" }),
      pr({ number: 11, state: "merged", closes: [15], head: "feat/15-v1" }),
      pr({ number: 18 }),
      pr({ number: 19, head: "feat/16-nom", issues: [16] }),
      pr({ number: 20, repo: "me/autre" }),
      // La branche nomme #15 mais le serveur ne la lie pas : l'écran ne la relit pas.
      pr({ number: 21, head: "feat/15-ailleurs", issues: [] }),
    ];
    expect(pullsForIssue(pulls, { repo: "me/app", number: 15 }).map((p) => p.number)).toEqual([
      18, 11, 10,
    ]);
  });

  it("trouve la PR ouverte d'une tâche en revue, même source que le détail d'issue", () => {
    const at = (number: number, state: PullRequest["state"], closes: number[], updated: string) =>
      pr({ number, state, closes, issues: closes, head: "chore/x", updated_at: updated });
    const pulls = [
      at(50, "merged", [42], "2026-10-19T10:00:00Z"),
      at(51, "draft", [42], "2026-10-18T10:00:00Z"),
      at(52, "open", [42, 43], "2026-10-20T10:00:00Z"),
      { ...at(53, "open", [44], "2026-10-20T10:00:00Z"), repo: "me/site" },
    ];
    expect(pullRequestFor(pulls, { repo: "me/app", number: 42 })?.number).toBe(52);
    expect(pullRequestFor(pulls.slice(0, 2), { repo: "me/app", number: 42 })?.number).toBe(51);
    expect(pullRequestFor(pulls.slice(0, 1), { repo: "me/app", number: 42 })).toBeNull();
    expect(pullRequestFor(pulls, { repo: "me/app", number: 44 })).toBeNull();
    for (const n of [42, 43]) {
      expect(pullRequestFor(pulls, { repo: "me/app", number: n })).toBe(
        pullsForIssue(pulls, { repo: "me/app", number: n }).find(
          (p) => p.state === "open" || p.state === "draft",
        ) ?? null,
      );
    }
  });

  it("relie une PR de sprint (vers release/x) : « Closes » l'emporte sur la branche", () => {
    // Constat P15 : PR #18 « Closes #15 » et #19 (branche feat/16-…) vers release/0.2.0.
    const pulls = [
      pr({ number: 18, closes: [15], issues: [15], updated_at: "2026-10-18T10:00:00Z" }),
      pr({ number: 19, head: "feat/16-nom", issues: [16], updated_at: "2026-10-20T10:00:00Z" }),
      pr({
        number: 20,
        state: "open",
        head: "chore/x",
        closes: [16],
        issues: [16],
        updated_at: "2026-10-19T10:00:00Z",
      }),
    ];
    expect(pullRequestFor(pulls, { repo: "me/app", number: 15 })?.number).toBe(18);
    expect(pullRequestFor(pulls, { repo: "me/app", number: 16 })?.number).toBe(20);
    expect(pullRequestFor(pulls.slice(0, 2), { repo: "me/app", number: 16 })?.number).toBe(19);
    expect(pullsForIssue(pulls, { repo: "me/app", number: 16 }).map((p) => p.number)).toEqual([
      20, 19,
    ]);
  });
});

describe("route du détail d'issue", () => {
  it("aller-retour des paramètres", () => {
    expect(issueRoute({ repo: "me/app", number: 15 }, "sprint")).toEqual({
      repo: "me/app",
      number: "15",
      from: "sprint",
    });
    expect(parseIssueRoute(issueRoute({ repo: "me/app", number: 15 }))).toEqual({
      repo: "me/app",
      number: 15,
      from: null,
    });
    expect(parseIssueRoute({ repo: "me/app" })).toBeNull();
    expect(parseIssueRoute({ repo: "pas un dépôt", number: "3" })).toBeNull();
    expect(parseIssueRoute({ repo: "me/app", number: "-2" })).toBeNull();
  });
});

describe("nouvelle issue", () => {
  const form: IssueForm = {
    repo: "me/app",
    title: "  Dire bonjour  ",
    body: "",
    type: "feat",
    points: null,
    priority: null,
    milestone: "",
  };

  it("construit les arguments de create_issue, sans les champs vides", () => {
    expect(createIssueArgs(form)).toEqual({
      ok: true,
      args: { repo: "me/app", title: "Dire bonjour", type: "feat" },
    });
    expect(
      createIssueArgs({
        ...form,
        body: "Corps",
        points: 3,
        priority: 0,
        milestone: "0.2.0",
        type: "",
      }),
    ).toEqual({
      ok: true,
      args: {
        repo: "me/app",
        title: "Dire bonjour",
        body: "Corps",
        points: 3,
        priority: 0,
        milestone: "0.2.0",
      },
    });
  });

  it("refuse un titre vide, un dépôt absent, des points hors Fibonacci, une priorité hors 0–5", () => {
    expect(createIssueArgs({ ...form, title: "  " })).toMatchObject({ ok: false });
    expect(createIssueArgs({ ...form, repo: "" })).toMatchObject({ ok: false });
    expect(createIssueArgs({ ...form, points: 4 })).toMatchObject({ ok: false });
    expect(createIssueArgs({ ...form, priority: 6 })).toMatchObject({ ok: false });
  });
});

describe("créer des issues depuis un document", () => {
  it("ne produit aucun contexte sans document : l'IA n'est pas lancée pour rien", () => {
    expect(documentContext("me/app", {})).toBeNull();
    expect(documentContext("me/app", { text: "   ", files: [""] })).toBeNull();
  });

  it("porte le texte collé et/ou les fichiers choisis, avec le type exigé par l'action", () => {
    expect(
      documentContext("me/app", { text: " Un besoin ", files: ["C:\\docs\\cdc.pdf"] }),
    ).toEqual({
      type: "document",
      repo: "me/app",
      document: { text: "Un besoin", files: ["C:\\docs\\cdc.pdf"] },
    });
    expect(documentContext("me/app", {}, { design: "accueil" })).toEqual({
      type: "document",
      repo: "me/app",
      document: {},
      design: "accueil",
    });
    expect(fileName("C:\\docs\\cdc.pdf")).toBe("cdc.pdf");
    expect(fileName("/home/me/notes.md")).toBe("notes.md");
  });
});
