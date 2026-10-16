import { CadenceError } from "./errors";
import {
  API_VERSION,
  CHANNEL,
  isMessage,
  type BackendEvent,
  type CheckoutOptions,
  type HelloResult,
  type Method,
  type NotifyKind,
  type ParamsOf,
  type PickFilesOptions,
  type PluginInfo,
  type RepoInfo,
  type ReposChange,
  type RepoSelection,
  type RequestMessage,
  type ResultOf,
  type Route,
  type RunUpdate,
  type Settings,
  type ThemeTokens,
  type ToolCallResult,
} from "./protocol";
import type { Port } from "./port";

export const SDK_VERSION = "0.2.0";

/** `owner/name` d'un dépôt GitHub. */
export const REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CallOptions {
  /** Délai de réponse en ms ; `0` pour attendre indéfiniment. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CadenceOptions {
  /** Délai de la poignée de main (5 s par défaut). */
  helloTimeoutMs?: number;
  /** Délai par défaut des requêtes (30 s ; 120 s pour `call`, aucun pour `pickFiles`). */
  timeoutMs?: number;
  /** Applique les variables du thème sur `document.documentElement` (vrai par défaut). */
  applyTheme?: boolean;
}

export type Unsubscribe = () => void;

/** L'objet `cadence` des écrans de plugin. */
export interface Cadence {
  /** Attend la poignée de main ; les autres méthodes l'attendent d'elles-mêmes. */
  ready(): Promise<HelloResult>;
  /** Version d'API négociée (1), connue après `ready()`. */
  readonly api: number | null;
  readonly plugin: PluginInfo | null;
  /** Variables CSS du thème de Cadence (`--color-*`, `--text-*`…), à jour des changements. */
  readonly theme: ThemeTokens;
  /** Vue affichée et ses paramètres. */
  readonly route: Route | null;

  /**
   * Appelle un outil MCP du serveur du plugin (nom sans préfixe : `list_issues`).
   * Renvoie `structuredContent`, sinon le texte (JSON décodé s'il l'est) ; rejette avec
   * `tool_error` si l'outil répond par une erreur.
   */
  call<T = unknown>(tool: string, args?: Record<string, unknown>, options?: CallOptions): Promise<T>;
  /** Résultat MCP brut, sans normalisation. */
  callRaw(tool: string, args?: Record<string, unknown>, options?: CallOptions): Promise<ToolCallResult>;
  /** Déclenche une action du manifeste (chat ou fond) ; renvoie l'identifiant d'exécution. */
  runAction(actionId: string, context?: unknown): Promise<string>;
  /** Suit une exécution de fond ; la dernière mise à jour connue est rejouée tout de suite. */
  onRun(runId: string, listener: (update: RunUpdate) => void): Unsubscribe;
  /** Notifications du backend (`notifications/cadence/event`) ; `"*"` les reçoit toutes. */
  on(event: string, listener: (data: unknown, event: BackendEvent) => void): Unsubscribe;
  /** Changements de vue demandés par Cadence (barre du plugin, `navigate`). */
  onRoute(listener: (route: Route) => void): Unsubscribe;
  onTheme(listener: (theme: ThemeTokens) => void): Unsubscribe;

  /** Écriture seule : l'UI ne lit jamais un secret. */
  secrets: {
    set(id: string, value: string): Promise<void>;
    has(id: string): Promise<boolean>;
  };
  /** Réglages globaux du plugin (`[settings]`). */
  settings: {
    get<T extends Settings = Settings>(): Promise<T>;
    set<T extends Settings = Settings>(patch: Partial<T>): Promise<T>;
  };
  /**
   * Service `repos` de Cadence (manifeste : `services = ["repos"]`) : dépôts GitHub suivis,
   * sélecteur de la barre du plugin, clone et worktree à la demande. Sans le service déclaré,
   * les appels rejettent en `denied`.
   */
  repos: {
    /** Dépôts suivis par le plugin. */
    list(): Promise<RepoInfo[]>;
    /** Sélection courante du sélecteur : un dépôt, ou tous. */
    selection(): Promise<RepoSelection>;
    /** Changements de la liste suivie ou de la sélection. */
    onChange(listener: (change: ReposChange) => void): Unsubscribe;
    /** Suit un dépôt (`owner/name`) ; renvoie la liste à jour. */
    follow(fullName: string): Promise<RepoInfo[]>;
    /** Cesse de suivre un dépôt ; renvoie la liste à jour. */
    unfollow(fullName: string): Promise<RepoInfo[]>;
    /**
     * Clone le dépôt au besoin et prépare un worktree pour la tâche ; renvoie son chemin.
     * Côté IA, le même service est l'outil du cœur `cadence__repo_checkout`.
     */
    checkout(repo: string, options?: CheckoutOptions): Promise<string>;
  };
  navigate(viewId: string, params?: Record<string, string>): Promise<void>;
  notify(message: string, kind?: NotifyKind): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Chemins absolus choisis ; tableau vide si l'utilisateur annule. */
  pickFiles(options?: PickFilesOptions): Promise<string[]>;

  /** Ferme le canal (tests, démontage). */
  dispose(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: CadenceError) => void;
  cleanup: () => void;
}

/** Décode le résultat d'un outil MCP. */
export function toolValue(result: ToolCallResult): unknown {
  if (result.isError) {
    const text = textOf(result) || "L'outil a renvoyé une erreur.";
    throw new CadenceError("tool_error", text, result.structuredContent ?? result.content);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function textOf(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function createCadence(port: Port, options: CadenceOptions = {}): Cadence {
  const helloTimeout = options.helloTimeoutMs ?? 5_000;
  const defaultTimeout = options.timeoutMs ?? 30_000;
  const applyTheme = options.applyTheme ?? true;

  let seq = 0;
  let hello: HelloResult | null = null;
  let theme: ThemeTokens = {};
  let route: Route | null = null;
  let disposed = false;
  const pending = new Map<string, Pending>();
  const runs = new Map<string, Set<(u: RunUpdate) => void>>();
  const lastRun = new Map<string, RunUpdate>();
  const events = new Map<string, Set<(data: unknown, e: BackendEvent) => void>>();
  const routeListeners = new Set<(r: Route) => void>();
  const themeListeners = new Set<(t: ThemeTokens) => void>();
  const repoListeners = new Set<(c: ReposChange) => void>();

  const setTheme = (next: ThemeTokens) => {
    theme = Object.freeze({ ...next });
    if (applyTheme && typeof document !== "undefined") {
      const style = document.documentElement.style;
      for (const [name, value] of Object.entries(theme)) {
        if (name.startsWith("--")) style.setProperty(name, value);
      }
    }
    themeListeners.forEach((l) => l(theme));
  };

  const stop = port.listen((raw) => {
    if (!isMessage(raw)) return;
    if (raw.kind === "response") {
      const p = pending.get(raw.id);
      if (!p) return;
      pending.delete(raw.id);
      p.cleanup();
      if (raw.ok) p.resolve(raw.result);
      else p.reject(CadenceError.from(raw.error));
      return;
    }
    if (raw.kind !== "event") return;
    switch (raw.topic) {
      case "event": {
        const e = raw.data as BackendEvent;
        events.get(e.name)?.forEach((l) => l(e.data, e));
        events.get("*")?.forEach((l) => l(e.data, e));
        break;
      }
      case "run": {
        const u = raw.data as RunUpdate;
        lastRun.set(u.runId, u);
        runs.get(u.runId)?.forEach((l) => l(u));
        break;
      }
      case "theme":
        setTheme(raw.data as ThemeTokens);
        break;
      case "route":
        route = raw.data as Route;
        routeListeners.forEach((l) => l(route!));
        break;
      case "repos": {
        const change = raw.data as ReposChange;
        repoListeners.forEach((l) => l(change));
        break;
      }
    }
  });

  function send<M extends Method>(
    method: M,
    params: ParamsOf<M>,
    { timeoutMs = defaultTimeout, signal }: CallOptions = {},
  ): Promise<ResultOf<M>> {
    if (disposed) return Promise.reject(new CadenceError("not_connected", "Canal fermé."));
    if (signal?.aborted) return Promise.reject(new CadenceError("cancelled", "Appel annulé."));
    const id = `r${++seq}`;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => fail(new CadenceError("cancelled", "Appel annulé."));
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: CadenceError) => {
        if (!pending.delete(id)) return;
        cleanup();
        reject(error);
      };
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, cleanup });
      if (timeoutMs > 0) {
        timer = setTimeout(
          () =>
            fail(
              method === "hello"
                ? new CadenceError("not_connected", "Cadence ne répond pas : écran ouvert hors de l'app ?")
                : new CadenceError("timeout", `Pas de réponse de Cadence à « ${method} ».`),
            ),
          timeoutMs,
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const message: RequestMessage<M> = { channel: CHANNEL, api: API_VERSION, kind: "request", id, method, params };
      port.post(message);
    });
  }

  let helloPromise: Promise<HelloResult> | null = null;
  const ready = (): Promise<HelloResult> => {
    helloPromise ??= send("hello", { api: API_VERSION, sdk: SDK_VERSION }, { timeoutMs: helloTimeout }).then(
      (result) => {
        if (result.api !== API_VERSION) {
          throw new CadenceError(
            "unsupported_api",
            `Cadence parle l'API ${result.api}, ce plugin attend l'API ${API_VERSION}.`,
          );
        }
        hello = result;
        route = result.route;
        setTheme(result.theme ?? {});
        return result;
      },
      (error: unknown) => {
        helloPromise = null; // un nouvel appel retentera la poignée de main
        throw error;
      },
    );
    return helloPromise;
  };

  async function request<M extends Method>(method: M, params: ParamsOf<M>, opts?: CallOptions) {
    await ready();
    return send(method, params, opts);
  }

  const subscribe = <T>(map: Map<string, Set<T>>, key: string, listener: T): Unsubscribe => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) map.delete(key);
    };
  };

  const repoName = (fullName: string): Promise<string> => {
    const repo = typeof fullName === "string" ? fullName.trim() : "";
    return REPO_FULL_NAME.test(repo)
      ? Promise.resolve(repo)
      : Promise.reject(new CadenceError("invalid_params", `Dépôt invalide : « ${String(fullName)} » (attendu owner/name).`));
  };

  const callRaw = (tool: string, args: Record<string, unknown> = {}, opts?: CallOptions) =>
    request("tool.call", { tool, args }, { timeoutMs: 120_000, ...opts });

  return {
    ready,
    get api() {
      return hello?.api ?? null;
    },
    get plugin() {
      return hello?.plugin ?? null;
    },
    get theme() {
      return theme;
    },
    get route() {
      return route;
    },
    callRaw,
    async call<T>(tool: string, args?: Record<string, unknown>, opts?: CallOptions) {
      return toolValue(await callRaw(tool, args, opts)) as T;
    },
    async runAction(actionId, context = null) {
      const { runId } = await request("action.run", { action: actionId, context });
      return runId;
    },
    onRun(runId, listener) {
      const off = subscribe(runs, runId, listener);
      const last = lastRun.get(runId);
      if (last) listener(last);
      return off;
    },
    on(event, listener) {
      return subscribe(events, event, listener);
    },
    onRoute(listener) {
      routeListeners.add(listener);
      return () => {
        routeListeners.delete(listener);
      };
    },
    onTheme(listener) {
      themeListeners.add(listener);
      return () => {
        themeListeners.delete(listener);
      };
    },
    secrets: {
      async set(id, value) {
        await request("secrets.set", { id, value });
      },
      has: (id) => request("secrets.has", { id }),
    },
    settings: {
      get: async <T extends Settings>() => (await request("settings.get", {})) as T,
      set: async <T extends Settings>(patch: Partial<T>) =>
        (await request("settings.set", { patch: patch as Settings })) as T,
    },
    repos: {
      list: () => request("repos.list", {}),
      selection: () => request("repos.selection", {}),
      onChange(listener) {
        repoListeners.add(listener);
        return () => {
          repoListeners.delete(listener);
        };
      },
      follow: async (fullName) => request("repos.follow", { repo: await repoName(fullName) }),
      unfollow: async (fullName) => request("repos.unfollow", { repo: await repoName(fullName) }),
      async checkout(repo, options = {}) {
        const params = { repo: await repoName(repo), ...(options.task ? { task: options.task } : {}) };
        // Un clone peut être long : pas de délai.
        const { path } = await request("repos.checkout", params, { timeoutMs: 0 });
        return path;
      },
    },
    async navigate(view, params = {}) {
      await request("navigate", { view, params });
    },
    async notify(message, kind = "info") {
      await request("notify", { message, kind });
    },
    async openExternal(url) {
      await request("openExternal", { url });
    },
    pickFiles: (opts = {}) => request("pickFiles", opts, { timeoutMs: 0 }),
    dispose() {
      disposed = true;
      stop();
      for (const [id, p] of pending) {
        pending.delete(id);
        p.cleanup();
        p.reject(new CadenceError("not_connected", "Canal fermé."));
      }
    },
  };
}
