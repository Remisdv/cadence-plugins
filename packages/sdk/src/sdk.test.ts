import { describe, expect, it, vi } from "vitest";
import {
  API_VERSION,
  CadenceError,
  CHANNEL,
  connectMock,
  createCadence,
  isCadenceError,
  isMessage,
  memoryChannel,
  toolValue,
  type ConversationChange,
  type ReposChange,
  type RunUpdate,
} from "./index";

const tools = {
  list_issues: ({ state }: Record<string, unknown>) => ({
    issues: [{ number: 12, title: "Connexion GitHub", state }],
  }),
  fail: () => {
    throw new Error("Dépôt introuvable.");
  },
  plain: () => "bonjour",
};

describe("poignée de main", () => {
  it("négocie l'API 1 et expose le contexte", async () => {
    const { cadence } = connectMock({
      plugin: { id: "gestion-projet", version: "0.1.0" },
      route: { view: "issues", params: {} },
      theme: { "--color-bg": "#0b0d10" },
    });
    const hello = await cadence.ready();
    expect(hello.api).toBe(API_VERSION);
    expect(cadence.plugin?.id).toBe("gestion-projet");
    expect(cadence.route?.view).toBe("issues");
    expect(cadence.theme["--color-bg"]).toBe("#0b0d10");
  });

  it("refuse un hôte qui parle une autre version", async () => {
    const { cadence } = connectMock({ api: 2 });
    await expect(cadence.ready()).rejects.toMatchObject({ code: "unsupported_api" });
  });

  it("échoue en not_connected sans hôte", async () => {
    const [client] = memoryChannel();
    const cadence = createCadence(client, { helloTimeoutMs: 20 });
    await expect(cadence.call("list_issues")).rejects.toMatchObject({ code: "not_connected" });
  });
});

describe("requêtes", () => {
  it("call renvoie structuredContent, ou le texte", async () => {
    const { cadence, host } = connectMock({ tools });
    const result = await cadence.call<{ issues: { number: number }[] }>("list_issues", { state: "open" });
    expect(result.issues[0]?.number).toBe(12);
    expect(await cadence.call("plain")).toBe("bonjour");
    expect(host.requests.map((r) => r.method)).toEqual(["hello", "tool.call", "tool.call"]);
  });

  it("transforme les erreurs en CadenceError typées", async () => {
    const { cadence } = connectMock({ tools });
    const error = await cadence.call("fail").catch((e: unknown) => e);
    expect(isCadenceError(error, "tool_error")).toBe(true);
    expect((error as CadenceError).message).toBe("Dépôt introuvable.");
    await expect(cadence.call("inconnu")).rejects.toMatchObject({ code: "not_found" });
    await expect(cadence.openExternal("file:///etc")).rejects.toMatchObject({ code: "denied" });
  });

  it("expire après le délai", async () => {
    const [client, server] = memoryChannel();
    // Hôte qui répond à hello puis ignore tout.
    server.listen((m) => {
      if (isMessage(m) && m.kind === "request" && m.method === "hello") {
        server.post({
          channel: CHANNEL,
          api: API_VERSION,
          kind: "response",
          id: m.id,
          ok: true,
          result: { api: 1, plugin: { id: "x", version: "0" }, theme: {}, route: { view: "a", params: {} } },
        });
      }
    });
    const cadence = createCadence(client, { timeoutMs: 20 });
    await expect(cadence.settings.get()).rejects.toMatchObject({ code: "timeout" });
  });

  it("annule avec un AbortSignal", async () => {
    const { cadence } = connectMock({ tools: { slow: () => new Promise((r) => setTimeout(r, 1_000)) } });
    await cadence.ready();
    const controller = new AbortController();
    const call = cadence.call("slow", {}, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: "cancelled" });
  });

  it("écrit les secrets sans jamais les relire", async () => {
    const { cadence, host } = connectMock();
    expect(await cadence.secrets.has("api_key")).toBe(false);
    await cadence.secrets.set("api_key", "cle-de-test");
    expect(await cadence.secrets.has("api_key")).toBe(true);
    expect(host.secrets.has("api_key")).toBe(true);
    expect("get" in cadence.secrets).toBe(false);
  });

  it("fusionne les réglages", async () => {
    const { cadence } = connectMock({ settings: { repository: "me/app" } });
    const next = await cadence.settings.set({ tag_prefix: "v" });
    expect(next).toEqual({ repository: "me/app", tag_prefix: "v" });
  });
});

describe("événements", () => {
  it("relaie les notifications du backend, avec le joker *", async () => {
    const { cadence, host } = connectMock();
    await cadence.ready();
    const named = vi.fn();
    const all = vi.fn();
    cadence.on("issues-changed", named);
    cadence.on("*", all);
    host.emit("issues-changed", { number: 3 });
    host.emit("autre");
    await new Promise((r) => setTimeout(r, 0));
    expect(named).toHaveBeenCalledWith({ number: 3 }, { name: "issues-changed", data: { number: 3 } });
    expect(all).toHaveBeenCalledTimes(2);
  });

  it("suit une exécution de fond et rejoue le dernier état", async () => {
    const { cadence, host } = connectMock();
    const runId = await cadence.runAction("preparer-release", { version: "0.2.0" });
    await new Promise((r) => setTimeout(r, 0));
    host.updateRun({ runId, status: "running", progress: 0.5 });
    await new Promise((r) => setTimeout(r, 0));
    const updates: RunUpdate[] = [];
    const off = cadence.onRun(runId, (u) => updates.push(u));
    host.updateRun({ runId, status: "succeeded", result: { tag: "v0.2.0" } });
    await new Promise((r) => setTimeout(r, 0));
    off();
    host.updateRun({ runId, status: "failed" });
    await new Promise((r) => setTimeout(r, 0));
    expect(updates.map((u) => u.status)).toEqual(["running", "succeeded"]);
  });

  it("suit la route et le thème", async () => {
    const { cadence, host } = connectMock({ route: { view: "sprint", params: {} } });
    await cadence.ready();
    const routes: string[] = [];
    cadence.onRoute((r) => routes.push(r.view));
    await cadence.navigate("issues", { number: "4" });
    await new Promise((r) => setTimeout(r, 0));
    host.setTheme({ "--color-clay": "#d97757" });
    await new Promise((r) => setTimeout(r, 0));
    expect(routes).toEqual(["issues"]);
    expect(cadence.route).toEqual({ view: "issues", params: { number: "4" } });
    expect(cadence.theme["--color-clay"]).toBe("#d97757");
  });
});

describe("service repos", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("liste les dépôts suivis et la sélection courante", async () => {
    const { cadence } = connectMock({ repos: { repos: ["me/app", "me/site"] } });
    const repos = await cadence.repos.list();
    expect(repos.map((r) => r.fullName)).toEqual(["me/app", "me/site"]);
    expect(repos[0]).toMatchObject({ owner: "me", name: "app" });
    expect(await cadence.repos.selection()).toEqual({ kind: "one", repo: "me/app" });
    expect("workspace" in cadence).toBe(false);
  });

  it("suit et cesse de suivre, avec notification des changements", async () => {
    const { cadence, host } = connectMock({ repos: { repos: ["me/app"], selection: { kind: "all" } } });
    await cadence.ready();
    const changes: ReposChange[] = [];
    const off = cadence.repos.onChange((c) => changes.push(c));
    expect((await cadence.repos.follow(" me/site ")).map((r) => r.fullName)).toEqual(["me/app", "me/site"]);
    await tick();
    host.select({ kind: "one", repo: "me/site" });
    await tick();
    expect((await cadence.repos.unfollow("me/site")).map((r) => r.fullName)).toEqual(["me/app"]);
    await tick();
    off();
    host.select({ kind: "one", repo: "me/app" });
    await tick();
    expect(changes.map((c) => [c.repos.length, c.selection])).toEqual([
      [2, { kind: "all" }],
      [2, { kind: "one", repo: "me/site" }],
      // Le dépôt sélectionné n'est plus suivi : retour à « tous ».
      [1, { kind: "all" }],
    ]);
  });

  it("refuse un nom de dépôt invalide sans appeler l'hôte", async () => {
    const { cadence, host } = connectMock({ repos: {} });
    await expect(cadence.repos.follow("pas un dépôt")).rejects.toMatchObject({ code: "invalid_params" });
    expect(host.requests.some((r) => r.method === "repos.follow")).toBe(false);
  });

  it("prépare un worktree par tâche", async () => {
    const { cadence, host } = connectMock({
      repos: { repos: ["me/app"], checkout: (repo, task) => `/data/repos/${repo}/wt/${task}` },
    });
    expect(await cadence.repos.checkout("me/app", { task: "issue-42" })).toBe("/data/repos/me/app/wt/issue-42");
    expect(host.requests.at(-1)).toEqual({ method: "repos.checkout", params: { repo: "me/app", task: "issue-42" } });
    await expect(cadence.repos.checkout("me/autre")).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejette en denied quand le plugin ne déclare pas le service", async () => {
    const { cadence } = connectMock();
    await expect(cadence.repos.list()).rejects.toMatchObject({ code: "denied" });
  });
});

describe("outils externes", () => {
  it("lit l'état détecté par Cadence", async () => {
    const { cadence, host } = connectMock({
      externalTools: {
        git: { installed: true, version: "2.45.1" },
        gh: { installed: true, version: "2.60.0", authenticated: false },
        node: {},
      },
    });
    expect(await cadence.tools.status("git")).toEqual({ installed: true, version: "2.45.1", authenticated: null });
    expect(await cadence.tools.status("gh")).toEqual({ installed: true, version: "2.60.0", authenticated: false });
    expect(await cadence.tools.status("node")).toEqual({ installed: false, version: null, authenticated: null });
    expect(host.requests.at(-1)).toEqual({ method: "tools.status", params: { tool: "node" } });
  });

  it("ouvre la boîte d'installation et renvoie l'état final", async () => {
    const { cadence, host } = connectMock({
      externalTools: {
        git: { installed: true, version: "2.45.1" },
        gh: { installed: true, version: "2.60.0", authenticated: false },
        codex: { onEnsure: "dismiss" },
        node: {},
      },
    });
    // Déjà prêt : rien à faire.
    expect(await cadence.tools.ensure("git")).toEqual({ installed: true, version: "2.45.1", authenticated: null });
    // Installé mais non connecté : « Se connecter ».
    expect(await cadence.tools.ensure("gh")).toMatchObject({ installed: true, authenticated: true });
    // Absent : « Installer ».
    expect(await cadence.tools.ensure("node")).toMatchObject({ installed: true, authenticated: null });
    expect(host.externalTools.node?.installed).toBe(true);
    // L'utilisateur ignore : état inchangé, pas d'erreur.
    expect(await cadence.tools.ensure("codex")).toEqual({ installed: false, version: null, authenticated: null });
  });

  it("suit une nouvelle détection", async () => {
    const { cadence, host } = connectMock({ externalTools: { claude: {} } });
    host.setExternalTool("claude", { installed: true, version: "2.1.0", authenticated: true });
    expect(await cadence.tools.status("claude")).toEqual({ installed: true, version: "2.1.0", authenticated: true });
  });

  it("refuse un outil non déclaré, inconnu ou mal nommé", async () => {
    const { cadence, host } = connectMock({ externalTools: { git: { installed: true } } });
    await expect(cadence.tools.status("gh")).rejects.toMatchObject({ code: "denied" });
    await expect(cadence.tools.ensure("docker")).rejects.toMatchObject({ code: "not_found" });
    await expect(cadence.tools.status("Git CLI")).rejects.toMatchObject({ code: "invalid_params" });
    expect(host.requests.some((r) => (r.params as { tool?: string }).tool === "Git CLI")).toBe(false);
  });
});

describe("conversations", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const sprint = { id: "sprint:me/app:3", label: "Sprint 0.3.0 · me/app" };

  it("rattache la conversation d'une action à son groupe, masquée du chat global", async () => {
    const { cadence, host } = connectMock({
      conversations: {
        modes: { "implementer-issue": "background" },
        conversations: [{ id: "c-libre", title: "Question libre", updatedAt: "2026-10-01T09:00:00Z" }],
      },
    });
    await cadence.ready();
    const changes: ConversationChange[] = [];
    const off = cadence.conversations.onChange((c) => changes.push(c));

    await cadence.runAction("developper-sprint", { repo: "me/app", group: sprint });
    await cadence.runAction("implementer-issue", { type: "issue", repo: "me/app", issue: 42, group: sprint });
    await cadence.runAction("completer-issue", { type: "issue", repo: "me/app", issue: 7 });
    await tick();

    // Sans groupe : les conversations visibles seulement.
    const visible = await cadence.conversations.list();
    expect(visible.map((c) => c.action ?? c.id).sort()).toEqual(["c-libre", "completer-issue"]);
    // Avec le groupe : celles du sprint, cachées comprises, contexte sans le champ réservé.
    const grouped = await cadence.conversations.list({ group: sprint.id });
    expect(grouped.map((c) => c.action).sort()).toEqual(["developper-sprint", "implementer-issue"]);
    const implement = grouped.find((c) => c.action === "implementer-issue")!;
    expect(implement).toMatchObject({
      mode: "background",
      state: "running",
      group: sprint,
      context: { type: "issue", repo: "me/app", issue: 42 },
    });
    expect(implement.context).not.toHaveProperty("group");
    expect(await cadence.conversations.list({ group: "sprint:me/app:4" })).toEqual([]);

    // Un événement par création, puis par changement d'état.
    host.setConversationState(implement.id, "waiting-approval");
    await tick();
    off();
    host.setConversationState(implement.id, "idle");
    await tick();
    expect(changes).toHaveLength(4);
    expect(changes.at(-1)).toEqual({ id: implement.id, group: sprint, state: "waiting-approval", waiting: "approval" });
    expect(changes.find((c) => !c.group)?.state).toBe("running");
  });

  it("distingue une réponse attendue d'un accord attendu (waiting)", async () => {
    const { cadence, host } = connectMock({
      conversations: { conversations: [{ id: "c-q", title: "Développer le sprint", state: "running" }] },
    });
    await cadence.ready();
    const changes: ConversationChange[] = [];
    cadence.conversations.onChange((c) => changes.push(c));

    host.setConversationState("c-q", "waiting-approval", "reply");
    await tick();
    expect(changes.at(-1)).toEqual({ id: "c-q", state: "waiting-approval", waiting: "reply" });
    expect((await cadence.conversations.list())[0]).toMatchObject({ state: "waiting-approval", waiting: "reply" });

    host.setConversationState("c-q", "waiting-approval");
    await tick();
    expect(changes.at(-1)?.waiting).toBe("approval");

    // Hors attente, le champ disparaît.
    host.setConversationState("c-q", "idle");
    await tick();
    expect(changes.at(-1)).toEqual({ id: "c-q", state: "idle" });
    expect((await cadence.conversations.list())[0]).not.toHaveProperty("waiting");
  });

  it("un groupe non caché reste dans le chat global", async () => {
    const { cadence } = connectMock();
    await cadence.runAction("relire-valider", { type: "review", group: { ...sprint, hidden: false } });
    expect((await cadence.conversations.list()).map((c) => c.group)).toEqual([sprint]);
  });

  it("lit une conversation complète et l'ouvre dans le chat", async () => {
    const { cadence, host } = connectMock({
      conversations: {
        conversations: [
          {
            id: "c1",
            title: "Développer l'issue #42",
            group: sprint,
            messages: [
              { role: "user", text: "Développe #42", at: "2026-10-20T08:00:00Z" },
              { role: "assistant", text: "PR #51 ouverte.", at: "2026-10-20T08:20:00Z" },
            ],
            tools: [{ name: "gestion-projet__create_pull_request", ok: true, at: "2026-10-20T08:19:00Z" }],
            usage: { inputTokens: 1200, outputTokens: 300 },
          },
        ],
      },
    });
    const detail = await cadence.conversations.get("c1");
    expect(detail.info).toMatchObject({ id: "c1", turns: 2, group: sprint });
    expect(detail.messages[1]?.text).toBe("PR #51 ouverte.");
    expect(detail.tools).toEqual([{ name: "gestion-projet__create_pull_request", ok: true, at: "2026-10-20T08:19:00Z" }]);
    expect(detail.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    await cadence.conversations.open("c1");
    expect(host.opened).toEqual(["c1"]);
    expect(host.requests.at(-1)).toEqual({ method: "conversations.open", params: { id: "c1" } });
    await expect(cadence.conversations.get("absente")).rejects.toMatchObject({ code: "not_found" });
    await expect(cadence.conversations.open("absente")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuse un groupe mal formé", async () => {
    const { cadence, host } = connectMock();
    await expect(cadence.conversations.list({ group: "sprint 3" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(cadence.conversations.list({ group: "x".repeat(121) })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(host.requests.some((r) => r.method === "conversations.list")).toBe(false);
    await expect(cadence.conversations.get("")).rejects.toMatchObject({ code: "invalid_params" });
    // Groupe d'action invalide : refusé par l'hôte.
    await expect(
      cadence.runAction("developper-sprint", { group: { id: "sprint 3", label: "Sprint 3" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(cadence.runAction("developper-sprint", { group: { id: "sprint:3" } })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(host.conversations).toEqual([]);
  });
});

describe("toolValue", () => {
  it("décode le JSON textuel et signale isError", () => {
    expect(toolValue({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(toolValue({ content: [] })).toBeNull();
    expect(() => toolValue({ content: [{ type: "text", text: "non" }], isError: true })).toThrow(CadenceError);
  });
});
