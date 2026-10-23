import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import {
  aiLabel,
  architectureContext,
  conversationIssues,
  conversationStates,
  conversationStatus,
  designRequestContext,
  displayLabels,
  estimateLabel,
  issueContext,
  issueGroup,
  issueKey,
  isStarted,
  isViewId,
  planningContext,
  priorityInfo,
  pullsContext,
  repoShortName,
  reviewContext,
  sprintGroup,
  views,
  withGroup,
} from "./domain";

describe("vues", () => {
  it("couvrent celles du manifeste", () => {
    const manifest = parse(
      readFileSync(new URL("../../plugin.toml", import.meta.url), "utf8"),
    ) as any;
    const declared: string[] = [
      ...manifest.ui.views.map((v: { id: string }) => v.id),
      ...(manifest.setup ?? []).map((s: { view: string }) => s.view),
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

describe("manifeste : onboarding, détail d'issue, document", () => {
  const manifest = () =>
    parse(readFileSync(new URL("../../plugin.toml", import.meta.url), "utf8")) as any;

  it("laisse à Cadence l'étape « Dépôts suivis » du service repos (pas de doublon)", () => {
    const m = manifest();
    expect(m.services).toContain("repos");
    expect((m.setup ?? []).map((s: { view: string }) => s.view)).not.toContain("setup-depots");
    // L'écran reste joignable (« Choisir des dépôts ») sans paraître dans la barre.
    expect(m.ui.views.find((v: { id: string }) => v.id === "setup-depots")).toMatchObject({
      hidden: true,
    });
  });

  it("déclare le détail d'issue comme route cachée", () => {
    expect(manifest().ui.views.find((v: { id: string }) => v.id === "issue")).toMatchObject({
      hidden: true,
      icon: "issue",
    });
  });

  it("n'offre « Créer des issues depuis un document » qu'avec un document", () => {
    const action = manifest().actions.find((a: { id: string }) => a.id === "extraire-issues");
    // Un contexte typé retire l'action de la barre du plugin (lancée sans contexte).
    expect(action).toMatchObject({ skill: "extraire-issues", mode: "chat", context: "document" });
  });
});

describe("manifeste : actions de sprint", () => {
  it("déclare « Relire et valider » en chat, contexte review, avec son skill", () => {
    const manifest = parse(
      readFileSync(new URL("../../plugin.toml", import.meta.url), "utf8"),
    ) as any;
    const action = manifest.actions.find((a: { id: string }) => a.id === "relire-valider");
    expect(action).toMatchObject({ skill: "relire-valider", mode: "chat", context: "review" });
    const skill = readFileSync(
      new URL("../../skills/relire-valider/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(skill).toMatch(/^---\r?\nname: relire-valider\r?\n/);
  });
});

describe("groupes de conversations", () => {
  it("rattache les conversations au sprint de l'issue", () => {
    const group = sprintGroup("me/app", { number: 3, title: "0.3.0" });
    expect(group).toEqual({ id: "sprint:me/app:3", label: "Sprint 0.3.0 · me/app" });
    // Même règle que Cadence pour l'id de groupe.
    expect(group.id).toMatch(/^[A-Za-z0-9:/._-]{1,120}$/);
    expect(issueGroup({ repo: "me/app", sprint: 3, milestone: "0.3.0" })).toEqual(group);
    // Sans sprint (pas de version, ou palier sans date) : conversation normale.
    expect(issueGroup({ repo: "me/app", sprint: null, milestone: "1.0.0" })).toBeNull();
    expect(issueGroup({ repo: "me/app", milestone: null })).toBeNull();
    expect(withGroup(null)).toEqual({});
    expect({ ...issueContext({ repo: "me/app", number: 4 }), ...withGroup(group) }).toEqual({
      type: "issue",
      repo: "me/app",
      issue: 4,
      group,
    });
  });

  it("construit le contexte de la revue groupée", () => {
    const group = sprintGroup("me/app", { number: 3, title: "0.3.0" });
    expect(
      reviewContext(
        "me/app",
        [
          { issue: 42, pr: 51 },
          { issue: 43, pr: null },
        ],
        group,
      ),
    ).toEqual({
      type: "review",
      repo: "me/app",
      items: [
        { issue: 42, pr: 51 },
        { issue: 43, pr: null },
      ],
      group,
    });
    expect(reviewContext("me/app", [])).not.toHaveProperty("group");
  });

  it("décrit une conversation : issues, état, IA", () => {
    expect(conversationIssues({ context: { type: "issue", issue: 42 } })).toEqual([42]);
    expect(
      conversationIssues({ context: { items: [{ issue: 42, pr: 51 }, { issue: 43 }], issue: 42 } }),
    ).toEqual([42, 43]);
    expect(conversationIssues({ context: { issues: [7, 8] } })).toEqual([7, 8]);
    expect(conversationIssues({})).toEqual([]);
    expect(conversationStates["waiting-approval"].label).toBe("Attend votre accord");
    // N10 : Cadence précise ce qu'attend une conversation en `waiting-approval`.
    expect(conversationStatus({ state: "waiting-approval", waiting: "reply" }).label).toBe(
      "En attente de votre réponse",
    );
    expect(conversationStatus({ state: "waiting-approval", waiting: "approval" }).label).toBe(
      "Attend votre accord",
    );
    // Hôte plus ancien, sans `waiting` : un accord.
    expect(conversationStatus({ state: "waiting-approval" }).label).toBe("Attend votre accord");
    expect(conversationStatus({ state: "idle" }).label).toBe("Terminée");
    expect(aiLabel("claude-code")).toBe("Claude Code");
    expect(aiLabel("autre-ia")).toBe("autre-ia");
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

describe("actions : jamais d'un clic depuis la barre du plugin", () => {
  const manifest = () =>
    parse(readFileSync(new URL("../../plugin.toml", import.meta.url), "utf8")) as {
      actions: { id: string; context?: string }[];
    };

  it("déclare un contexte pour chaque action (la barre n'affiche que celles sans contexte)", () => {
    const loose = manifest().actions.filter((a) => !a.context);
    expect(loose.map((a) => a.id)).toEqual([]);
  });

  it("construit des contextes du type déclaré par l'action", () => {
    const declared = Object.fromEntries(manifest().actions.map((a) => [a.id, a.context]));
    expect(pullsContext("me/app", [52, 51, 52]).type).toBe(declared["relire-pr"]);
    expect(architectureContext("me/app").type).toBe(declared["adapter-architecture"]);
    expect(planningContext("me/app").type).toBe(declared["planifier"]);
    expect(designRequestContext("me/app", "Écran de connexion")?.type).toBe(
      declared["creer-design"],
    );
    // SprintView lance `developper-sprint` avec `{ type: "sprint", repo, group? }`.
    expect(declared["developper-sprint"]).toBe("sprint");
  });

  it("relit seulement les PR choisies, sans doublon", () => {
    expect(pullsContext("me/app", [52, 51, 52])).toEqual({
      type: "pulls",
      repo: "me/app",
      pulls: [51, 52],
    });
  });

  it("n'envoie le service ou le design que s'il est choisi", () => {
    expect(architectureContext("me/app", null)).toEqual({ type: "architecture", repo: "me/app" });
    expect(architectureContext("me/app", "api")).toEqual({
      type: "architecture",
      repo: "me/app",
      service: "api",
    });
    expect(designRequestContext("me/app", "  ")).toBeNull();
    expect(designRequestContext("me/app", " Accueil mobile ", "accueil")).toEqual({
      type: "demande-design",
      repo: "me/app",
      request: "Accueil mobile",
      design: "accueil",
    });
    expect(designRequestContext("me/app", "Accueil", "")).toEqual({
      type: "demande-design",
      repo: "me/app",
      request: "Accueil",
    });
  });
});
