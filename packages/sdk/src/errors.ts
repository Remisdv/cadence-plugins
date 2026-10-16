/** Codes d'erreur du SDK. Un code inconnu renvoyé par l'hôte devient `internal`. */
export const ERROR_CODES = [
  /** Pas d'hôte Cadence (page ouverte hors de l'app) ou poignée de main échouée. */
  "not_connected",
  /** L'hôte ne parle pas la version d'API du SDK. */
  "unsupported_api",
  /** Pas de réponse dans le délai. */
  "timeout",
  /** Appel annulé (AbortSignal) ou fenêtre fermée par l'utilisateur. */
  "cancelled",
  /** L'outil MCP a répondu par une erreur (`isError`). */
  "tool_error",
  /** Paramètres refusés par l'hôte ou par l'outil. */
  "invalid_params",
  /** Outil, action, vue ou secret inconnus du manifeste. */
  "not_found",
  /** Refusé par l'hôte (ex. URL non http(s)). */
  "denied",
  /** Erreur de l'hôte ou du backend. */
  "internal",
] as const;

export type CadenceErrorCode = (typeof ERROR_CODES)[number];

export class CadenceError extends Error {
  override readonly name = "CadenceError";
  readonly code: CadenceErrorCode;
  readonly data: unknown;

  constructor(code: CadenceErrorCode, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }

  /** Erreur reçue de l'hôte : un code hors liste devient `internal`. */
  static from(payload: { code?: unknown; message?: unknown; data?: unknown }): CadenceError {
    const code = ERROR_CODES.includes(payload.code as CadenceErrorCode)
      ? (payload.code as CadenceErrorCode)
      : "internal";
    const message = typeof payload.message === "string" ? payload.message : "Erreur inconnue.";
    return new CadenceError(code, message, payload.data);
  }
}

export function isCadenceError(value: unknown, code?: CadenceErrorCode): value is CadenceError {
  return value instanceof CadenceError && (code === undefined || value.code === code);
}
