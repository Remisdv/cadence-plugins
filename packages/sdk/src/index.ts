/**
 * @cadence/plugin-sdk — SDK des écrans de plugin Cadence (iframe isolée, postMessage, API 1).
 *
 * ```ts
 * import { cadence } from "@cadence/plugin-sdk";
 *
 * const issues = await cadence.call("list_issues", { state: "open" });
 * const runId = await cadence.runAction("implementer-issue", { repo: "me/app", issue: 42 });
 * cadence.onRun(runId, (u) => console.log(u.status, u.message));
 *
 * const sprint = await cadence.conversations.list({ group: "sprint:me/app:3" });
 * cadence.conversations.onChange(() => refetch());
 * ```
 */
import { createCadence, type Cadence, type CadenceOptions } from "./client";
import { connectMock, type MockHostOptions } from "./mock";
import { windowPort } from "./port";

export * from "./protocol";
export * from "./errors";
export {
  createCadence,
  toolValue,
  SDK_VERSION,
  REPO_FULL_NAME,
  EXTERNAL_TOOL_ID,
  GROUP_ID,
} from "./client";
export type { Cadence, CadenceOptions, CallOptions, Unsubscribe } from "./client";
export { windowPort, memoryChannel, type Port } from "./port";
export {
  createMockHost,
  connectMock,
  repoInfo,
  type MockConversation,
  type MockConversationsOptions,
  type MockHost,
  type MockExternalTool,
  type MockHostOptions,
  type MockReposOptions,
  type MockTool,
} from "./mock";

export interface ConnectOptions extends CadenceOptions {
  /**
   * Hôte simulé utilisé quand l'écran est ouvert hors de Cadence (`vite dev` dans un
   * navigateur) : sans lui, les appels échouent en `not_connected`.
   */
  dev?: MockHostOptions;
}

/** Vrai quand la page tourne dans une iframe (donc, a priori, dans Cadence). */
export function isFramed(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}

/** Crée le client : vers Cadence dans l'iframe, vers l'hôte simulé `dev` sinon. */
export function connect(options: ConnectOptions = {}): Cadence {
  const { dev, ...clientOptions } = options;
  if (!isFramed() && dev) return connectMock(dev, clientOptions).cadence;
  if (typeof window === "undefined") {
    throw new Error("@cadence/plugin-sdk : connect() s'utilise dans une page web (iframe Cadence).");
  }
  return createCadence(windowPort(window.parent, window), clientOptions);
}

let instance: Cadence | null = null;

/** Remplace le client partagé `cadence` (à appeler avant tout usage, ex. avec l'hôte simulé). */
export function setCadence(client: Cadence): Cadence {
  instance = client;
  return client;
}

/** Client partagé, créé au premier usage avec `connect()`. */
export const cadence: Cadence = new Proxy({} as Cadence, {
  get(_target, key) {
    instance ??= connect();
    const value = Reflect.get(instance, key, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
