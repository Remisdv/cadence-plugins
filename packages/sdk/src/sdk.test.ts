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

describe("toolValue", () => {
  it("décode le JSON textuel et signale isError", () => {
    expect(toolValue({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(toolValue({ content: [] })).toBeNull();
    expect(() => toolValue({ content: [{ type: "text", text: "non" }], isError: true })).toThrow(CadenceError);
  });
});
