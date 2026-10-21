/**
 * Markdown des issues et commentaires GitHub (sous-ensemble, repris de Cadence 1) : titres,
 * paragraphes, listes `-` / `1.`, cases `- [ ]`, citations, blocs de code ; en ligne : code,
 * gras, italique, liens. Le HTML brut n'est jamais interprété : tout reste du texte.
 */

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "tasks"; items: { done: boolean; text: string }[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    /^\s*>/.test(line) ||
    ITEM.test(line) ||
    RULE.test(line)
  );
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!))
        code.push(lines[i++]!);
      i++; // clôture (ou fin du texte)
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (TASK.test(line)) {
      const items: { done: boolean; text: string }[] = [];
      let m: RegExpExecArray | null;
      while (i < lines.length && (m = TASK.exec(lines[i]!))) {
        items.push({ done: m[1] !== " ", text: m[2]! });
        i++;
      }
      blocks.push({ kind: "tasks", items });
      continue;
    }
    if (ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      // Passer de `-` à `1.` (ou l'inverse) commence une autre liste.
      const sameKind = (l: string) => ITEM.test(l) && !TASK.test(l) && /^\s*\d/.test(l) === ordered;
      while (i < lines.length && sameKind(lines[i]!)) {
        items.push(lines[i++]!.replace(ITEM, ""));
        // Ligne de continuation indentée : même élément.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !ITEM.test(lines[i]!)) {
          items[items.length - 1] += ` ${lines[i++]!.trim()}`;
        }
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: quote.join(" ").trim() });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!))
      para.push(lines[i++]!.trim());
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

// Code d'abord : son contenu n'est pas analysé. Le gras peut contenir du code (`**`x`**`).
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_(?![A-Za-z0-9])|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Liens http(s) et mailto seulement (pas de `javascript:`). */
export function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out.at(-1);
    if (prev?.kind === "text") prev.text += t;
    else out.push({ kind: "text", text: t });
  };
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    push(text.slice(last, at));
    if (m[1] !== undefined) out.push({ kind: "code", text: m[2]!.trim() || m[2]! });
    else if (m[3] !== undefined || m[4] !== undefined)
      out.push({ kind: "strong", children: parseInline(m[3] ?? m[4]!) });
    else if (m[5] !== undefined || m[6] !== undefined)
      out.push({ kind: "em", children: parseInline(m[5] ?? m[6]!) });
    else {
      const href = safeHref(m[8]!);
      if (href) out.push({ kind: "link", href, children: parseInline(m[7]!) });
      else push(m[0]);
    }
    last = at + m[0].length;
  }
  push(text.slice(last));
  return out;
}
