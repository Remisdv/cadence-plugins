/**
 * Protocole postMessage entre l'iframe d'un plugin et Cadence (API 1).
 *
 * Trois sortes de messages, tous marqués `channel: "cadence"` et `api: 1` :
 * - `request`  (plugin → hôte) : `{ id, method, params }` ;
 * - `response` (hôte → plugin) : `{ id, ok: true, result }` ou `{ id, ok: false, error }` ;
 * - `event`    (hôte → plugin) : `{ topic, data }` — notification du backend, progression d'une
 *   exécution de fond, changement de thème ou de route.
 *
 * Le premier appel est toujours `hello` : il négocie la version d'API et renvoie le contexte
 * (plugin, thème, route affichée). Il n'y a pas d'espace de travail (révision 1.1) : un plugin
 * est global et gère son propre contexte, par exemple les dépôts suivis du service `repos`.
 * Les outils externes dont il dépend (`[[requires]]`, révision 1.2) se consultent par `tools.*`,
 * les conversations lancées par ses actions par `conversations.*`.
 */

export const API_VERSION = 1 as const;
export const CHANNEL = "cadence" as const;

/* ---------- Données échangées ---------- */

/** IA de code pilotée par Cadence. Les identifiants connus sont listés ; d'autres peuvent venir. */
export type AiId = "claude-code" | "codex" | "opencode" | (string & {});

export interface PluginInfo {
  id: string;
  version: string;
}

/** Vue du plugin affichée par Cadence (`[[ui.views]]`, ou `view` d'une étape de setup). */
export interface Route {
  view: string;
  params: Record<string, string>;
}

/** Variables CSS injectées par Cadence : `{ "--color-bg": "#0b0d10", "--text-body": "13px", … }`. */
export type ThemeTokens = Readonly<Record<string, string>>;

export interface HelloParams {
  api: typeof API_VERSION;
  /** Version du SDK, pour le diagnostic. */
  sdk: string;
}

export interface HelloResult {
  api: number;
  plugin: PluginInfo;
  theme: ThemeTokens;
  route: Route;
}

/** Bloc de contenu MCP (seuls les champs utiles au SDK sont typés). */
export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Résultat brut d'un appel d'outil MCP, tel que relayé par Cadence. */
export interface ToolCallResult {
  content?: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Progression ou résultat d'une exécution de fond (`runAction` d'une action `background`). */
export interface RunUpdate {
  runId: string;
  status: RunStatus;
  /** Dernière ligne lisible de l'exécution. */
  message?: string;
  /** 0 → 1 quand l'avancement est connu. */
  progress?: number;
  /** Résultat final (exécution réussie). */
  result?: unknown;
  /** Raison de l'échec. */
  error?: string;
}

export type NotifyKind = "info" | "success" | "warning" | "error";

export interface FileFilter {
  name: string;
  /** Extensions sans le point : `["pdf", "docx"]`. */
  extensions: string[];
}

export interface PickFilesOptions {
  title?: string;
  multiple?: boolean;
  /** Choisir un dossier plutôt que des fichiers. */
  directory?: boolean;
  filters?: FileFilter[];
}

export type Settings = Record<string, unknown>;

/* ---------- Service `repos` (manifeste : `services = ["repos"]`) ---------- */

/** Dépôt GitHub suivi par le plugin. */
export interface RepoInfo {
  /** `owner/name`. */
  fullName: string;
  owner: string;
  name: string;
  defaultBranch?: string;
  private?: boolean;
  /** Page GitHub du dépôt. */
  url?: string;
  /** Clone local (fait par Cadence ou désigné par l'utilisateur), s'il existe déjà. */
  localPath?: string | null;
}

/** Sélecteur de la barre du plugin : un dépôt courant (`owner/name`) ou « Tous les dépôts ». */
export type RepoSelection = { kind: "one"; repo: string } | { kind: "all" };

/** Dépôts suivis et sélection, envoyés à chaque changement de l'un ou de l'autre. */
export interface ReposChange {
  repos: RepoInfo[];
  selection: RepoSelection;
}

export interface CheckoutOptions {
  /** Tâche pour laquelle le worktree est préparé (un worktree par tâche, ex. « issue-42 »). */
  task?: string;
}

/* ---------- Outils externes (révision 1.2, manifeste : `[[requires]]`) ---------- */

/**
 * Outil externe du registre de Cadence. Les identifiants connus sont listés ; une version plus
 * récente de l'app peut en ajouter.
 */
export type ExternalToolId = "git" | "gh" | "claude" | "codex" | "opencode" | "node" | (string & {});

/** État d'un outil externe tel que Cadence l'a détecté (lecture seule). */
export interface ExternalToolStatus {
  /** Exécutable trouvé (chemin détecté ou chemin personnalisé des réglages). */
  installed: boolean;
  /** Version détectée (`2.45.1`), `null` si l'outil est absent ou sa version illisible. */
  version: string | null;
  /** Connexion de l'outil (`gh auth status`…) ; `null` pour un outil sans connexion (git, node) ou absent. */
  authenticated: boolean | null;
}

/* ---------- Conversations (sessions de chat lancées par les actions du plugin) ---------- */

/** État d'une conversation dans Cadence. */
export type ConversationState = "idle" | "running" | "waiting-approval" | "failed" | "interrupted";

/** Mode de l'action qui a lancé la conversation (`[[actions]] mode`). */
export type ConversationMode = "chat" | "background";

/**
 * Groupe de conversations, propre au plugin (`sprint:me/app:3`) : Cadence le préfixe par l'id du
 * plugin, un plugin ne voit donc que ses propres groupes.
 */
export interface ConversationGroup {
  /** `[A-Za-z0-9:/._-]{1,120}` (voir `GROUP_ID`). */
  id: string;
  /** Libellé de la puce affichée dans le chat (« Sprint 3 · me/app »). */
  label: string;
}

/**
 * Champ réservé `group` du contexte d'une action : la conversation lancée est rattachée au groupe.
 * `hidden` (vrai par défaut) la retire du chat global et de « Conversations » de la barre du
 * plugin : on la retrouve par `conversations.list({ group })`.
 */
export interface ActionGroup extends ConversationGroup {
  hidden?: boolean;
}

/** Conversation lancée par une action du plugin courant (dates ISO 8601). */
export interface ConversationInfo {
  id: string;
  title: string;
  /** IA qui répond (`claude-code`, `codex`, `opencode`…). */
  ai: AiId;
  model: string;
  state: ConversationState;
  mode: ConversationMode;
  /** Identifiant de l'action du manifeste, si la conversation vient d'une action. */
  action?: string;
  /** Contexte passé à l'action. */
  context?: Record<string, unknown>;
  group?: ConversationGroup;
  createdAt: string;
  updatedAt: string;
  /** Nombre de tours (messages de l'utilisateur et réponses). */
  turns: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  /** Texte complet du message. */
  text: string;
  at: string;
}

/** Appel d'outil de la conversation (sa sortie n'est pas transmise). */
export interface ConversationToolUse {
  name: string;
  ok: boolean;
  at: string;
}

/** Conversation complète (`conversations.get`), par exemple pour exporter un sprint. */
export interface ConversationDetail {
  info: ConversationInfo;
  messages: ConversationMessage[];
  tools: ConversationToolUse[];
  usage?: { inputTokens: number; outputTokens: number };
}

/** Événement `conversations` : création ou changement d'état d'une conversation du plugin. */
export interface ConversationChange {
  id: string;
  group?: ConversationGroup;
  state: ConversationState;
}

export interface ConversationQuery {
  /**
   * Identifiant de groupe (sans le préfixe du plugin). Absent : les conversations visibles du
   * plugin, sans celles des groupes cachés.
   */
  group?: string;
}

/** Événement émis par le backend du plugin (`notifications/cadence/event`). */
export interface BackendEvent {
  name: string;
  data: unknown;
}

/* ---------- Méthodes ---------- */

export interface Methods {
  hello: { params: HelloParams; result: HelloResult };
  "tool.call": { params: { tool: string; args: Record<string, unknown> }; result: ToolCallResult };
  "action.run": { params: { action: string; context: unknown }; result: { runId: string } };
  "secrets.set": { params: { id: string; value: string }; result: null };
  "secrets.has": { params: { id: string }; result: boolean };
  "settings.get": { params: Record<string, never>; result: Settings };
  "settings.set": { params: { patch: Settings }; result: Settings };
  "repos.list": { params: Record<string, never>; result: RepoInfo[] };
  "repos.selection": { params: Record<string, never>; result: RepoSelection };
  "repos.follow": { params: { repo: string }; result: RepoInfo[] };
  "repos.unfollow": { params: { repo: string }; result: RepoInfo[] };
  "repos.checkout": { params: { repo: string; task?: string }; result: { path: string } };
  "tools.status": { params: { tool: string }; result: ExternalToolStatus };
  "tools.ensure": { params: { tool: string }; result: ExternalToolStatus };
  "conversations.list": { params: ConversationQuery; result: ConversationInfo[] };
  "conversations.get": { params: { id: string }; result: ConversationDetail };
  "conversations.open": { params: { id: string }; result: null };
  navigate: { params: Route; result: null };
  notify: { params: { message: string; kind: NotifyKind }; result: null };
  openExternal: { params: { url: string }; result: null };
  pickFiles: { params: PickFilesOptions; result: string[] };
}

export type Method = keyof Methods;
export type ParamsOf<M extends Method> = Methods[M]["params"];
export type ResultOf<M extends Method> = Methods[M]["result"];

export interface Topics {
  event: BackendEvent;
  run: RunUpdate;
  theme: ThemeTokens;
  route: Route;
  repos: ReposChange;
  conversations: ConversationChange;
}

export type Topic = keyof Topics;

/* ---------- Enveloppes ---------- */

interface Envelope {
  channel: typeof CHANNEL;
  api: typeof API_VERSION;
}

export interface RequestMessage<M extends Method = Method> extends Envelope {
  kind: "request";
  id: string;
  method: M;
  params: ParamsOf<M>;
}

export interface ErrorPayload {
  code: string;
  message: string;
  data?: unknown;
}

export type ResponseMessage = Envelope & { kind: "response"; id: string } & (
    | { ok: true; result: unknown }
    | { ok: false; error: ErrorPayload }
  );

export interface EventMessage<T extends Topic = Topic> extends Envelope {
  kind: "event";
  topic: T;
  data: Topics[T];
}

export type Message = RequestMessage | ResponseMessage | EventMessage;

/** Reconnaît un message du protocole (les autres messages de la fenêtre sont ignorés). */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<Message>;
  return (
    m.channel === CHANNEL &&
    m.api === API_VERSION &&
    (m.kind === "request" || m.kind === "response" || m.kind === "event")
  );
}
