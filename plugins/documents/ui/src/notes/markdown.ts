/**
 * Markdown ↔ document de l'éditeur (JSON TipTap / ProseMirror), sans DOM.
 *
 * Le fichier .md de la note est la référence : il doit rester lisible hors de Cadence et
 * reprendre ce que l'IA écrit avec `update_note`. Lecture par le lexer GFM de `marked` ;
 * écriture par ce module (titres `#`, listes `-` / `1.`, cases `- [ ]`, citations `>`, blocs de
 * code ```` ``` ````, séparateur `---`, tableaux GFM, gras, italique, barré, code, liens).
 */
import { marked, type Token, type Tokens } from "marked";
import type { JSONContent } from "@tiptap/core";

type Mark = { type: string; attrs?: Record<string, unknown> };

/* ---------- Markdown → document ---------- */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: String.fromCharCode(0xa0) };

/** Entités HTML laissées telles quelles par le lexer (`&amp;`, `&#39;`…). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

function textNode(text: string, marks: Mark[]): JSONContent[] {
  // Retour à la ligne simple d'un paragraphe Markdown : une espace.
  const clean = text.replace(/\s*\n\s*/g, " ");
  if (!clean) return [];
  return [marks.length ? { type: "text", text: clean, marks: [...marks] } : { type: "text", text: clean }];
}

function inline(tokens: Token[] | undefined, marks: Mark[] = []): JSONContent[] {
  const out: JSONContent[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": {
        const tok = t as Tokens.Text;
        out.push(...(tok.tokens?.length ? inline(tok.tokens, marks) : textNode(decodeEntities(tok.text), marks)));
        break;
      }
      case "escape":
        out.push(...textNode((t as Tokens.Escape).text, marks));
        break;
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, [...marks, { type: "bold" }]));
        break;
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, [...marks, { type: "italic" }]));
        break;
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, [...marks, { type: "strike" }]));
        break;
      case "codespan":
        out.push(...textNode(decodeEntities((t as Tokens.Codespan).text), [...marks, { type: "code" }]));
        break;
      case "link": {
        const link = t as Tokens.Link;
        out.push(...inline(link.tokens, [...marks, { type: "link", attrs: { href: link.href } }]));
        break;
      }
      case "image": {
        // Pas d'images dans les notes : le texte alternatif garde un lien vers l'image.
        const img = t as Tokens.Image;
        out.push(...textNode(img.text || img.href, [...marks, { type: "link", attrs: { href: img.href } }]));
        break;
      }
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "html": {
        const raw = (t as Tokens.HTML).text;
        if (/^<br\s*\/?>$/i.test(raw.trim())) out.push({ type: "hardBreak" });
        else out.push(...textNode(raw, marks));
        break;
      }
      default:
        if ("text" in t && typeof t.text === "string") out.push(...textNode(t.text, marks));
    }
  }
  return out;
}

/** Textes voisins de mêmes marques réunis, comme ProseMirror le fait. */
function merged(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last?.type === "text" && node.type === "text" && JSON.stringify(last.marks) === JSON.stringify(node.marks)) {
      out[out.length - 1] = { ...last, text: (last.text ?? "") + (node.text ?? "") };
    } else {
      out.push(node);
    }
  }
  return out;
}

const paragraph = (content: JSONContent[] = []): JSONContent =>
  content.length ? { type: "paragraph", content: merged(content) } : { type: "paragraph" };

/** Contenu d'un élément de liste : un paragraphe d'abord (schéma `paragraph block*`). */
function itemContent(tokens: Token[]): JSONContent[] {
  const content = blocks(tokens.filter((t) => t.type !== "checkbox"));
  if (content[0]?.type !== "paragraph") content.unshift(paragraph());
  return content;
}

function blocks(tokens: Token[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "space":
      case "def":
        break;
      case "heading": {
        const h = t as Tokens.Heading;
        out.push({ type: "heading", attrs: { level: Math.min(Math.max(h.depth, 1), 6) }, content: merged(inline(h.tokens)) });
        break;
      }
      case "paragraph":
        out.push(paragraph(inline((t as Tokens.Paragraph).tokens)));
        break;
      case "text": {
        const tok = t as Tokens.Text;
        out.push(paragraph(tok.tokens?.length ? inline(tok.tokens) : textNode(decodeEntities(tok.text), [])));
        break;
      }
      case "code": {
        const code = t as Tokens.Code;
        const node: JSONContent = { type: "codeBlock", attrs: { language: code.lang?.trim() || null } };
        if (code.text) node.content = [{ type: "text", text: code.text }];
        out.push(node);
        break;
      }
      case "hr":
        out.push({ type: "horizontalRule" });
        break;
      case "blockquote": {
        const content = blocks((t as Tokens.Blockquote).tokens);
        out.push({ type: "blockquote", content: content.length ? content : [paragraph()] });
        break;
      }
      case "list": {
        const list = t as Tokens.List;
        if (list.items.length && list.items.every((i) => i.task)) {
          out.push({
            type: "taskList",
            content: list.items.map((i) => ({
              type: "taskItem",
              attrs: { checked: !!i.checked },
              content: itemContent(i.tokens),
            })),
          });
        } else {
          const items = list.items.map((i) => {
            const content = itemContent(i.tokens);
            // Case isolée dans une liste ordinaire : gardée en texte.
            if (i.task) content[0]!.content = [{ type: "text", text: i.checked ? "[x] " : "[ ] " }, ...(content[0]!.content ?? [])];
            return { type: "listItem", content };
          });
          const start = typeof list.start === "number" ? list.start : 1;
          out.push(
            list.ordered
              ? { type: "orderedList", attrs: { start }, content: items }
              : { type: "bulletList", content: items },
          );
        }
        break;
      }
      case "table": {
        const table = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[], cellType: string): JSONContent => ({
          type: "tableRow",
          content: cells.map((c) => ({ type: cellType, content: [paragraph(inline(c.tokens))] })),
        });
        out.push({
          type: "table",
          content: [row(table.header, "tableHeader"), ...table.rows.map((r) => row(r, "tableCell"))],
        });
        break;
      }
      case "html": {
        const raw = (t as Tokens.HTML).text.trim();
        if (raw) out.push(paragraph(textNode(raw, [])));
        break;
      }
      default:
        if ("raw" in t && typeof t.raw === "string" && t.raw.trim()) out.push(paragraph(textNode(t.raw.trim(), [])));
    }
  }
  return out;
}

/** Document de l'éditeur pour un Markdown (au moins un paragraphe). */
export function markdownToDoc(markdown: string): JSONContent {
  const tokens = marked.lexer(markdown.replace(/\r\n?/g, "\n"), { gfm: true });
  const content = blocks(tokens);
  return { type: "doc", content: content.length ? content : [paragraph()] };
}

/* ---------- Document → Markdown ---------- */

/** Ordre d'ouverture des marques : lien à l'extérieur, code au plus près du texte. */
const MARK_ORDER = ["link", "bold", "italic", "strike", "code"];
const sameMark = (a: Mark, b: Mark) => a.type === b.type && (a.type !== "link" || a.attrs?.href === b.attrs?.href);

function open(mark: Mark): string {
  switch (mark.type) {
    case "link":
      return "[";
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    default:
      return "";
  }
}

function close(mark: Mark): string {
  if (mark.type === "link") {
    const href = String(mark.attrs?.href ?? "");
    return `](${/[\s()<>]/.test(href) ? `<${href.replace(/>/g, "%3E")}>` : href})`;
  }
  return open(mark);
}

/** Échappe ce que Markdown interpréterait dans du texte ordinaire. */
export function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>~]/g, "\\$&").replace(/&(?=#?[a-z0-9]+;)/gi, "&amp;");
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || /^ .* $/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Texte en ligne d'un bloc (paragraphe, titre, cellule). */
export function inlineMarkdown(nodes: JSONContent[] | undefined, inTable = false): string {
  let out = "";
  let stack: Mark[] = [];
  let pending = ""; // espaces de fin, placées après la fermeture éventuelle des marques
  const closeFrom = (i: number) => {
    for (const m of stack.slice(i).reverse()) {
      if (m.type !== "code") out += close(m);
    }
    stack = stack.slice(0, i);
  };
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") {
      out += pending;
      pending = "";
      out += inTable ? "<br>" : "\\\n";
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const marks = ((node.marks ?? []) as Mark[])
      .filter((m) => MARK_ORDER.includes(m.type))
      .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    const [, lead = "", core = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.text) ?? [];
    let keep = 0;
    while (keep < stack.length && marks.some((m) => sameMark(m, stack[keep]!))) keep++;
    closeFrom(keep);
    out += pending + lead;
    pending = trail;
    if (!core) {
      continue;
    }
    for (const m of marks) {
      if (!stack.some((s) => sameMark(s, m))) {
        out += open(m);
        stack.push(m);
      }
    }
    if (marks.some((m) => m.type === "code")) {
      out += inTable ? codeSpan(core).replace(/\|/g, "\\|") : codeSpan(core);
      stack = stack.filter((m) => m.type !== "code");
    } else {
      let text = escapeText(core);
      if (inTable) text = text.replace(/\|/g, "\\|");
      out += text;
    }
  }
  closeFrom(0);
  return out + pending;
}

/** Échappe un début de ligne qui ouvrirait un bloc (`# `, `- `, `> `, `1. `…). */
function escapeLineStart(text: string): string {
  return text
    .replace(/^(\s*)([#>+-])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])(\s)/, "$1\\$2$3")
    .replace(/^(\s*)(=+\s*$)/, "$1\\$2");
}

const indent = (text: string, prefix: string, first = prefix) =>
  text
    .split("\n")
    .map((line, i) => (i === 0 ? first + line : line ? prefix + line : line))
    .join("\n");

function listItems(items: JSONContent[], marker: (i: number, item: JSONContent) => string): string {
  return items
    .map((item, i) => {
      const m = marker(i, item);
      const body = itemMarkdown(item.content ?? []);
      return indent(body, " ".repeat(m.length), m);
    })
    .join("\n");
}

function blockMarkdown(node: JSONContent): string {
  switch (node.type) {
    case "paragraph":
      // Chaque ligne (après un retour forcé) pourrait ouvrir un bloc.
      return inlineMarkdown(node.content).split("\n").map(escapeLineStart).join("\n");
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      const text = inlineMarkdown(node.content);
      return text.trim() ? `${"#".repeat(level)} ${text}` : "";
    }
    case "bulletList":
      return listItems(node.content ?? [], () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      return listItems(node.content ?? [], (i) => `${start + i}. `);
    }
    case "taskList":
      return listItems(node.content ?? [], (_, item) => (item.attrs?.checked ? "- [x] " : "- [ ] "));
    case "blockquote": {
      const body = blocksMarkdown(node.content ?? []);
      return body
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    }
    case "codeBlock": {
      const text = (node.content ?? []).map((n) => n.text ?? "").join("");
      const longest = Math.max(2, ...(text.match(/^`{3,}/gm) ?? []).map((m) => m.length));
      const fence = "`".repeat(longest + 1);
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    case "table":
      return tableMarkdown(node);
    default:
      return node.content ? blocksMarkdown(node.content) : (node.text ?? "");
  }
}

function tableMarkdown(table: JSONContent): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((p) => inlineMarkdown(p.content, true))
        .filter(Boolean)
        .join("<br>")
        .trim(),
    ),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length), 1);
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] || " ").join(" | ")} |`;
  return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);

/** Contenu d'un élément de liste : une sous-liste suit son paragraphe sans ligne vide (liste serrée). */
function itemMarkdown(nodes: JSONContent[]): string {
  let out = "";
  nodes.forEach((node, i) => {
    const text = blockMarkdown(node);
    if (i === 0) out = text;
    else if (text.trim()) {
      const tight = LISTS.has(node.type ?? "") && nodes[i - 1]?.type === "paragraph";
      out += (tight ? "\n" : "\n\n") + text;
    }
  });
  return out;
}

function blocksMarkdown(nodes: JSONContent[]): string {
  return nodes
    .map(blockMarkdown)
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/** Markdown d'un document de l'éditeur (fin de ligne finale, rien pour une note vide). */
export function docToMarkdown(doc: JSONContent): string {
  const text = blocksMarkdown(doc.content ?? []).replace(/\s+$/, "");
  return text ? `${text}\n` : "";
}
