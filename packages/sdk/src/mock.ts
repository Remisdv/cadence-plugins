/**
 * Hôte Cadence simulé, pour développer un écran de plugin hors de l'app (`vite dev`) et pour
 * les tests. Il répond au protocole comme Cadence, avec des outils écrits à la main.
 */
import { createCadence, type Cadence, type CadenceOptions } from "./client";
import { CadenceError } from "./errors";
import { memoryChannel, type Port } from "./port";
import {
  API_VERSION,
  CHANNEL,
  isMessage,
  type BackendEvent,
  type EventMessage,
  type Method,
  type PickFilesOptions,
  type PluginInfo,
  type RepoInfo,
  type ReposChange,
  type RepoSelection,
  type ResponseMessage,
  type Route,
  type RunUpdate,
  type Settings,
  type ThemeTokens,
  type Topic,
  type Topics,
  type ToolCallResult,
} from "./protocol";

export type MockTool = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/** Service `repos` simulé ; absent, ses méthodes rejettent en `denied` comme dans Cadence. */
export interface MockReposOptions {
  /** Dépôts suivis au départ (`owner/name` ou fiche complète). */
  repos?: (string | RepoInfo)[];
  /** Sélection initiale : le premier dépôt suivi, sinon « tous ». */
  selection?: RepoSelection;
  /** Chemin du worktree renvoyé par `checkout`. */
  checkout?: (repo: string, task: string | undefined) => string | Promise<string>;
}

export interface MockHostOptions {
  plugin?: PluginInfo;
  theme?: ThemeTokens;
  route?: Route;
  /** Outils du serveur : la valeur renvoyée devient `structuredContent` ; une exception, `isError`. */
  tools?: Record<string, MockTool>;
  settings?: Settings;
  /** Secrets déjà enregistrés (identifiants seulement). */
  secrets?: string[];
  /** Réponse de `pickFiles`. */
  pickFiles?: (options: PickFilesOptions) => string[] | Promise<string[]>;
  /** Service `repos` (manifeste : `services = ["repos"]`). */
  repos?: MockReposOptions;
  /** Version d'API annoncée (pour tester le refus de version). */
  api?: number;
}

export interface MockHost {
  /** Journal des requêtes reçues (méthode et paramètres). */
  readonly requests: { method: Method; params: unknown }[];
  readonly secrets: ReadonlySet<string>;
  readonly settings: Settings;
  emit(name: string, data?: unknown): void;
  updateRun(update: RunUpdate): void;
  setRoute(route: Route): void;
  setTheme(theme: ThemeTokens): void;
  /** Dépôts suivis du service `repos` simulé. */
  readonly repos: readonly RepoInfo[];
  readonly selection: RepoSelection;
  /** Simule le sélecteur de la barre du plugin. */
  select(selection: RepoSelection): void;
  /** Remplace la liste suivie (ajout/retrait depuis Cadence). */
  setRepos(repos: (string | RepoInfo)[]): void;
  dispose(): void;
}

/** Fiche d'un dépôt à partir de `owner/name`. */
export function repoInfo(repo: string | RepoInfo): RepoInfo {
  if (typeof repo !== "string") return repo;
  const [owner = "", name = ""] = repo.split("/");
  return { fullName: repo, owner, name, defaultBranch: "main", url: `https://github.com/${repo}`, localPath: null };
}

let runSeq = 0;

export function createMockHost(port: Port, options: MockHostOptions = {}): MockHost {
  const requests: { method: Method; params: unknown }[] = [];
  const secrets = new Set(options.secrets ?? []);
  let settings: Settings = { ...(options.settings ?? {}) };
  let route: Route = options.route ?? { view: "index", params: {} };
  let theme: ThemeTokens = options.theme ?? {};
  const plugin = options.plugin ?? { id: "plugin-local", version: "0.0.0" };
  const reposService = options.repos;
  let repos: RepoInfo[] = (reposService?.repos ?? []).map(repoInfo);
  let selection: RepoSelection =
    reposService?.selection ?? (repos[0] ? { kind: "one", repo: repos[0].fullName } : { kind: "all" });

  const send = <T extends Topic>(topic: T, data: Topics[T]) => {
    const message: EventMessage<T> = { channel: CHANNEL, api: API_VERSION, kind: "event", topic, data };
    port.post(message);
  };

  const reposChanged = () => {
    const current = selection;
    if (current.kind === "one" && !repos.some((r) => r.fullName === current.repo)) selection = { kind: "all" };
    const change: ReposChange = { repos: [...repos], selection };
    queueMicrotask(() => send("repos", change));
  };

  const requireRepos = (method: string) => {
    if (!reposService) {
      throw new CadenceError("denied", `${method} : le plugin ne déclare pas services = ["repos"].`);
    }
  };

  async function handle(method: Method, params: any): Promise<unknown> {
    if (method.startsWith("repos.")) requireRepos(method);
    switch (method) {
      case "hello":
        return { api: options.api ?? API_VERSION, plugin, theme, route };
      case "tool.call": {
        const tool = options.tools?.[params.tool];
        if (!tool) throw new CadenceError("not_found", `Outil inconnu : ${params.tool}.`);
        try {
          const value = await tool(params.args ?? {});
          const result: ToolCallResult = {
            content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
            structuredContent: typeof value === "string" ? undefined : value,
          };
          return result;
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text }], isError: true } satisfies ToolCallResult;
        }
      }
      case "action.run": {
        const runId = `run-${++runSeq}`;
        queueMicrotask(() => send("run", { runId, status: "queued", message: `Action ${params.action}` }));
        return { runId };
      }
      case "secrets.set":
        if (typeof params.value !== "string" || !params.value) {
          throw new CadenceError("invalid_params", "Secret vide.");
        }
        secrets.add(params.id);
        return null;
      case "secrets.has":
        return secrets.has(params.id);
      case "settings.get":
        return settings;
      case "settings.set":
        settings = { ...settings, ...params.patch };
        return settings;
      case "repos.list":
        return repos;
      case "repos.selection":
        return selection;
      case "repos.follow":
        if (!repos.some((r) => r.fullName === params.repo)) {
          repos = [...repos, repoInfo(params.repo)];
          reposChanged();
        }
        return repos;
      case "repos.unfollow":
        if (repos.some((r) => r.fullName === params.repo)) {
          repos = repos.filter((r) => r.fullName !== params.repo);
          reposChanged();
        }
        return repos;
      case "repos.checkout": {
        if (!repos.some((r) => r.fullName === params.repo)) {
          throw new CadenceError("not_found", `Dépôt non suivi : ${params.repo}.`);
        }
        const path = reposService?.checkout
          ? await reposService.checkout(params.repo, params.task)
          : `/tmp/cadence/repos/${params.repo}/worktrees/${params.task ?? "tache"}`;
        return { path };
      }
      case "navigate":
        route = { view: params.view, params: params.params ?? {} };
        queueMicrotask(() => send("route", route));
        return null;
      case "notify":
        console.info(`[cadence:${params.kind}] ${params.message}`);
        return null;
      case "openExternal":
        if (!/^https?:\/\//.test(params.url)) throw new CadenceError("denied", "Seules les URL http(s) s'ouvrent.");
        return null;
      case "pickFiles":
        return options.pickFiles ? options.pickFiles(params) : [];
      default:
        throw new CadenceError("not_found", `Méthode inconnue : ${String(method)}.`);
    }
  }

  const stop = port.listen(async (raw) => {
    if (!isMessage(raw) || raw.kind !== "request") return;
    requests.push({ method: raw.method, params: raw.params });
    let response: ResponseMessage;
    try {
      const result = await handle(raw.method, raw.params);
      response = { channel: CHANNEL, api: API_VERSION, kind: "response", id: raw.id, ok: true, result };
    } catch (error) {
      const e = error instanceof CadenceError ? error : new CadenceError("internal", String(error));
      response = {
        channel: CHANNEL,
        api: API_VERSION,
        kind: "response",
        id: raw.id,
        ok: false,
        error: { code: e.code, message: e.message, data: e.data },
      };
    }
    port.post(response);
  });

  return {
    requests,
    secrets,
    get settings() {
      return settings;
    },
    emit(name, data = null) {
      const event: BackendEvent = { name, data };
      send("event", event);
    },
    updateRun: (update) => send("run", update),
    setRoute(next) {
      route = next;
      send("route", next);
    },
    setTheme(next) {
      theme = next;
      send("theme", next);
    },
    get repos() {
      return repos;
    },
    get selection() {
      return selection;
    },
    select(next) {
      selection = next;
      reposChanged();
    },
    setRepos(next) {
      repos = next.map(repoInfo);
      reposChanged();
    },
    dispose: stop,
  };
}

/** Client relié à un hôte simulé : `const { cadence, host } = connectMock({ tools })`. */
export function connectMock(
  options: MockHostOptions = {},
  clientOptions: CadenceOptions = {},
): { cadence: Cadence; host: MockHost } {
  const [client, server] = memoryChannel();
  const host = createMockHost(server, options);
  const cadence = createCadence(client, clientOptions);
  return { cadence, host };
}
