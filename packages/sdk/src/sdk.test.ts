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
          result: { api: 1, plugin: { id: "x", version: "0" }, workspace: {}, theme: {}, route: { view: "a", params: {} } },
        });
      }
    });
    const cadence = createCadence(client, { timeoutMs: 20 });
    await expect(cadence.workspace()).rejects.toMatchObject({ code: "timeout" });
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
    expect(await cadence.secrets.has("github_token")).toBe(false);
    await cadence.secrets.set("github_token", "ghp_test");
    expect(await cadence.secrets.has("github_token")).toBe(true);
    expect(host.secrets.has("github_token")).toBe(true);
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

describe("toolValue", () => {
  it("décode le JSON textuel et signale isError", () => {
    expect(toolValue({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(toolValue({ content: [] })).toBeNull();
    expect(() => toolValue({ content: [{ type: "text", text: "non" }], isError: true })).toThrow(CadenceError);
  });
});
