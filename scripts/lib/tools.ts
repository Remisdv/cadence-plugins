/** Outils MCP déclarés par les sources d'un serveur Rust rmcp (`#[tool(...)]` sur une `fn`). */

export interface ServerTool {
  /** Nom de l'outil : `name = "…"` de l'attribut, sinon celui de la fonction. */
  name: string;
  /**
   * Réservé à l'interface du plugin (`_meta["cadence/visibility"] = "ui"`), jamais exposé aux IA.
   * Convention du dépôt : l'attribut porte `meta = ui_only()` (ou toute expression `meta = …ui…`).
   */
  ui: boolean;
  /**
   * `annotations(read_only_hint = …)` de l'attribut : `true` (lecture seule), `false` (écriture),
   * `null` si l'outil ne le déclare pas. Cadence demande l'accord, en mode « Demander », avant
   * chaque outil qui n'est pas déclaré en lecture seule.
   */
  readOnly: boolean | null;
}

const TOOL_ATTR = /#\[tool\(([^\]]*)\)\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z0-9_]+)/g;

/** Outils trouvés dans des fichiers `.rs`, dans l'ordre des sources, sans doublon. */
export function scanTools(sources: string[]): ServerTool[] {
  const tools = new Map<string, ServerTool>();
  for (const text of sources) {
    for (const m of text.matchAll(TOOL_ATTR)) {
      const args = m[1]!;
      const explicit = /\bname\s*=\s*"([^"]+)"/.exec(args);
      const name = explicit ? explicit[1]! : m[2]!;
      const ui = /\bmeta\s*=\s*[^,]*\bui\w*/.test(args);
      const hint = /\bread_only_hint\s*=\s*(true|false)\b/.exec(args);
      const readOnly = hint ? hint[1] === "true" : null;
      if (!tools.has(name)) tools.set(name, { name, ui, readOnly });
    }
  }
  return [...tools.values()];
}

/** Noms des outils exposés aux IA (`<plugin>__<outil>`), triés : les outils `ui` sont écartés. */
export function exposedTools(sources: string[]): string[] {
  return scanTools(sources)
    .filter((t) => !t.ui)
    .map((t) => t.name)
    .sort();
}
