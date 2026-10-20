/**
 * Hôte Cadence simulé, pour développer un écran de plugin hors de l'app (`vite dev`) et pour
 * les tests. Il répond au protocole comme Cadence, avec des outils écrits à la main.
 */
import { createCadence, GROUP_ID, type Cadence, type CadenceOptions } from "./client";
import { CadenceError } from "./errors";
import { memoryChannel, type Port } from "./port";
import {
  API_VERSION,
  CHANNEL,
  isMessage,
  type AiId,
  type BackendEvent,
  type ConversationDetail,
  type ConversationGroup,
  type ConversationInfo,
  type ConversationMessage,
  type ConversationMode,
  type ConversationState,
  type ConversationToolUse,
  type EventMessage,
  type ExternalToolStatus,
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

/** Identifiants du registre d'outils externes de Cadence (révision 1.2). */
const KNOWN_EXTERNAL_TOOLS = ["git", "gh", "claude", "codex", "opencode", "node"];

/** Outil externe déclaré par le plugin simulé (`[[requires]]` ou service) et son état détecté. */
export interface MockExternalTool {
  /** Exécutable trouvé (faux par défaut). */
  installed?: boolean;
  version?: string | null;
  /** Connexion : `null` (défaut) pour un outil sans connexion, comme git et node. */
  authenticated?: boolean | null;
  /**
   * Issue de la boîte d'installation ouverte par `ensure` : `install` (défaut) simule le clic
   * « Installer » puis « Se connecter » ; `dismiss`, « Ignorer » (état inchangé).
   */
  onEnsure?: "install" | "dismiss";
}

/** Conversation simulée : les champs absents prennent une valeur par défaut. */
export interface MockConversation extends Partial<Omit<ConversationInfo, "group">> {
  group?: ConversationGroup;
  /** Masquée du chat global : vrai par défaut quand `group` est présent, comme dans Cadence. */
  hidden?: boolean;
  messages?: ConversationMessage[];
  tools?: ConversationToolUse[];
  usage?: ConversationDetail["usage"];
}

/** Conversations simulées ; `action.run` en crée une à chaque action déclenchée. */
export interface MockConversationsOptions {
  /** Conversations déjà présentes (plugin courant). */
  conversations?: MockConversation[];
  /** Mode des actions (`[[actions]] mode`), par identifiant : `chat` par défaut. */
  modes?: Record<string, ConversationMode>;
  /** IA et modèle des conversations créées par `action.run`. */
  ai?: AiId;
  model?: string;
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
  /**
   * Outils externes déclarés par le plugin (`[[requires]]` ou service), par identifiant. Un
   * outil du registre absent d'ici rejette en `denied`, un identifiant inconnu en `not_found`.
   */
  externalTools?: Record<string, MockExternalTool>;
  /** Conversations du plugin (`conversations.*`). */
  conversations?: MockConversationsOptions;
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
  /** État courant des outils externes déclarés. */
  readonly externalTools: Readonly<Record<string, ExternalToolStatus>>;
  /** Simule une nouvelle détection (installation faite hors de Cadence, chemin personnalisé…). */
  setExternalTool(id: string, status: ExternalToolStatus): void;
  /** Conversations du plugin, groupes cachés compris (`hidden`). */
  readonly conversations: readonly (ConversationInfo & { hidden: boolean })[];
  /** Conversations ouvertes par `conversations.open`, dans l'ordre. */
  readonly opened: readonly string[];
  /** Ajoute une conversation (lancée hors de l'écran) et émet l'événement `conversations`. */
  addConversation(conversation: MockConversation): ConversationInfo;
  /** Change l'état d'une conversation et émet l'événement `conversations`. */
  setConversationState(id: string, state: ConversationState): void;
  dispose(): void;
}

interface StoredConversation {
  info: ConversationInfo;
  hidden: boolean;
  messages: ConversationMessage[];
  tools: ConversationToolUse[];
  usage?: ConversationDetail["usage"];
}

/** Groupe du champ réservé `group` d'un contexte d'action (`invalid_params` s'il est mal formé). */
function actionGroup(context: unknown): { group: ConversationGroup; hidden: boolean } | null {
  if (typeof context !== "object" || context === null) return null;
  const raw = (context as { group?: unknown }).group;
  if (raw === undefined || raw === null) return null;
  const g = raw as { id?: unknown; label?: unknown; hidden?: unknown };
  if (typeof g !== "object" || typeof g.id !== "string" || !GROUP_ID.test(g.id)) {
    throw new CadenceError("invalid_params", "Groupe invalide : id attendu [A-Za-z0-9:/._-]{1,120}.");
  }
  if (typeof g.label !== "string" || !g.label.trim()) {
    throw new CadenceError("invalid_params", "Groupe sans libellé (label).");
  }
  return { group: { id: g.id, label: g.label }, hidden: g.hidden !== false };
}

let conversationSeq = 0;

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

  const externalTools: Record<string, ExternalToolStatus> = {};
  const ensureOutcome: Record<string, "install" | "dismiss"> = {};
  for (const [id, tool] of Object.entries(options.externalTools ?? {})) {
    externalTools[id] = {
      installed: tool.installed ?? false,
      version: tool.installed ? (tool.version ?? null) : null,
      authenticated: tool.authenticated ?? null,
    };
    ensureOutcome[id] = tool.onEnsure ?? "install";
  }

  const declaredTool = (id: string): ExternalToolStatus => {
    const status = externalTools[id];
    if (status) return status;
    if (KNOWN_EXTERNAL_TOOLS.includes(id)) {
      throw new CadenceError("denied", `Outil « ${id} » non déclaré : ajouter [[requires]] tool = "${id}" au manifeste.`);
    }
    throw new CadenceError("not_found", `Outil externe inconnu de Cadence : ${id}.`);
  };

  const conversationOptions = options.conversations ?? {};
  const conversations: StoredConversation[] = [];
  const opened: string[] = [];
  const store = (c: MockConversation): StoredConversation => {
    const now = new Date().toISOString();
    const { hidden, messages, tools, usage, group, ...info } = c;
    const stored: StoredConversation = {
      info: {
        id: info.id ?? `conv-${++conversationSeq}`,
        title: info.title ?? "Conversation",
        ai: info.ai ?? conversationOptions.ai ?? "claude-code",
        model: info.model ?? conversationOptions.model ?? "claude-sonnet",
        state: info.state ?? "idle",
        mode: info.mode ?? "chat",
        createdAt: info.createdAt ?? now,
        updatedAt: info.updatedAt ?? info.createdAt ?? now,
        turns: info.turns ?? messages?.length ?? 0,
        ...(info.action !== undefined ? { action: info.action } : {}),
        ...(info.context !== undefined ? { context: info.context } : {}),
        ...(group ? { group } : {}),
      },
      hidden: hidden ?? !!group,
      messages: messages ?? [],
      tools: tools ?? [],
      ...(usage ? { usage } : {}),
    };
    conversations.push(stored);
    return stored;
  };
  (conversationOptions.conversations ?? []).forEach(store);
  const conversation = (id: string): StoredConversation => {
    const c = conversations.find((x) => x.info.id === id);
    if (!c) throw new CadenceError("not_found", `Conversation inconnue : ${id}.`);
    return c;
  };
  const conversationChanged = (c: StoredConversation) => {
    const { id, group, state } = c.info;
    queueMicrotask(() => send("conversations", { id, state, ...(group ? { group } : {}) }));
  };

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
        const grouped = actionGroup(params.context);
        const hasContext = typeof params.context === "object" && params.context !== null;
        const { group: _group, ...context } = hasContext ? params.context : {};
        const created = store({
          title: String(params.action),
          action: String(params.action),
          mode: conversationOptions.modes?.[params.action] ?? "chat",
          state: "running",
          ...(hasContext ? { context } : {}),
          ...(grouped ?? {}),
        });
        conversationChanged(created);
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
      case "tools.status":
        return { ...declaredTool(params.tool) };
      case "tools.ensure": {
        const current = declaredTool(params.tool);
        const ready = current.installed && current.authenticated !== false;
        if (ready || ensureOutcome[params.tool] === "dismiss") return { ...current };
        const next: ExternalToolStatus = {
          installed: true,
          version: current.version ?? "1.0.0",
          authenticated: current.authenticated === null ? null : true,
        };
        externalTools[params.tool] = next;
        return { ...next };
      }
      case "conversations.list": {
        const group: unknown = params.group;
        if (group !== undefined && (typeof group !== "string" || !GROUP_ID.test(group))) {
          throw new CadenceError("invalid_params", `Groupe invalide : « ${String(group)} ».`);
        }
        const list =
          group === undefined
            ? conversations.filter((c) => !c.hidden)
            : conversations.filter((c) => c.info.group?.id === group);
        // Les plus récentes d'abord, comme la liste du chat.
        return list.map((c) => c.info).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      case "conversations.get": {
        const c = conversation(params.id);
        return { info: c.info, messages: c.messages, tools: c.tools, ...(c.usage ? { usage: c.usage } : {}) };
      }
      case "conversations.open":
        conversation(params.id);
        opened.push(params.id);
        return null;
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
    get externalTools() {
      return externalTools;
    },
    setExternalTool(id, status) {
      externalTools[id] = { ...status };
    },
    get conversations() {
      return conversations.map((c) => ({ ...c.info, hidden: c.hidden }));
    },
    get opened() {
      return opened;
    },
    addConversation(c) {
      const stored = store(c);
      conversationChanged(stored);
      return stored.info;
    },
    setConversationState(id, state) {
      const c = conversation(id);
      c.info = { ...c.info, state, updatedAt: new Date().toISOString() };
      conversationChanged(c);
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
