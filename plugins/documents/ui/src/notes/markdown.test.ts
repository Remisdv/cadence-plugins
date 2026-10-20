import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { decodeEntities, docToMarkdown, escapeText, inlineMarkdown, markdownToDoc } from "./markdown";

const t = (text: string, ...marks: (string | { type: string; attrs?: Record<string, unknown> })[]): JSONContent => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

/** Markdown → éditeur → Markdown doit rendre le même texte. */
const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));

describe("Markdown → éditeur", () => {
  it("lit titres, paragraphes et marques", () => {
    const doc = markdownToDoc("# Atome\n\nLe **noyau** et les *électrons*, `Z` et ~~faux~~.\nSuite &amp; fin.");
    expect(doc.content).toEqual([
      { type: "heading", attrs: { level: 1 }, content: [t("Atome")] },
      p(
        t("Le "),
        t("noyau", "bold"),
        t(" et les "),
        t("électrons", "italic"),
        t(", "),
        t("Z", "code"),
        t(" et "),
        t("faux", "strike"),
        t(". Suite & fin."),
      ),
    ]);
  });

  it("lit listes, cases à cocher, citations, code, séparateur et tableaux", () => {
    const doc = markdownToDoc(
      [
        "- un",
        "  - sous",
        "- deux",
        "",
        "3. trois",
        "4. quatre",
        "",
        "- [ ] à faire",
        "- [x] fait",
        "",
        "> Citation",
        "",
        "```python",
        "print('# pas un titre')",
        "```",
        "",
        "---",
        "",
        "| Grandeur | Unité |",
        "| --- | --- |",
        "| Force | N |",
      ].join("\n"),
    );
    const types = doc.content!.map((n) => n.type);
    expect(types).toEqual(["bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "horizontalRule", "table"]);
    const [bullets, ordered, tasks, quote, code, , table] = doc.content!;
    expect(bullets!.content![0]!.content!.map((n) => n.type)).toEqual(["paragraph", "bulletList"]);
    expect(ordered!.attrs).toEqual({ start: 3 });
    expect(tasks!.content!.map((i) => i.attrs?.checked)).toEqual([false, true]);
    expect(tasks!.content![0]!.content).toEqual([p(t("à faire"))]);
    expect(quote!.content).toEqual([p(t("Citation"))]);
    expect(code).toEqual({
      type: "codeBlock",
      attrs: { language: "python" },
      content: [t("print('# pas un titre')")],
    });
    expect(table!.content![0]!.content!.map((c) => c.type)).toEqual(["tableHeader", "tableHeader"]);
    expect(table!.content![1]!.content![1]).toEqual({ type: "tableCell", content: [p(t("N"))] });
  });

  it("lit les liens vers d'autres documents et les retours forcés", () => {
    const doc = markdownToDoc("Voir [Cours 1, p. 3](cadence:documents/document?doc=atomes&page=3)\\\nensuite");
    expect(doc.content).toEqual([
      p(
        t("Voir "),
        t("Cours 1, p. 3", { type: "link", attrs: { href: "cadence:documents/document?doc=atomes&page=3" } }),
        { type: "hardBreak" },
        t("ensuite"),
      ),
    ]);
  });

  it("donne un paragraphe vide pour une note vide", () => {
    expect(markdownToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(markdownToDoc("\n\n   \n").content).toHaveLength(1);
  });

  it("décode les entités HTML", () => {
    expect(decodeEntities("a &lt; b &amp;&amp; c &#39;d&#x27; &inconnu;")).toBe("a < b && c 'd' &inconnu;");
  });
});

describe("éditeur → Markdown", () => {
  it("écrit les marques sans espace à l'intérieur des délimiteurs", () => {
    expect(inlineMarkdown([t("très ", "bold"), t("important", "bold", "italic"), t(" ici")])).toBe(
      "**très *important*** ici",
    );
    expect(inlineMarkdown([t("lien ", { type: "link", attrs: { href: "https://exemple.org/a b" } })])).toBe(
      "[lien](<https://exemple.org/a b>) ",
    );
    expect(inlineMarkdown([t("a`b", "code")])).toBe("``a`b``");
    expect(inlineMarkdown([t("x", "bold"), t("y", "bold", "code")])).toBe("**x`y`**");
  });

  it("échappe ce que Markdown interpréterait", () => {
    expect(escapeText("2 * 3 = [6] <b> a_b ~x~ &amp;")).toBe("2 \\* 3 = \\[6\\] \\<b\\> a\\_b \\~x\\~ &amp;amp;");
    expect(docToMarkdown({ type: "doc", content: [p(t("# pas un titre")), p(t("1. pas une liste")), p(t("- non"))] })).toBe(
      "\\# pas un titre\n\n1\\. pas une liste\n\n\\- non\n",
    );
  });

  it("écrit listes imbriquées, cases, citations, code et tableaux", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [t("Plan")] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [p(t("un")), { type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [p(t("a"))] }] }] },
            { type: "listItem", content: [p(t("deux"))] },
          ],
        },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: true }, content: [p(t("relire"))] },
            { type: "taskItem", attrs: { checked: false }, content: [p(t("ficher"))] },
          ],
        },
        { type: "blockquote", content: [p(t("Ligne 1")), p(t("Ligne 2"))] },
        { type: "codeBlock", attrs: { language: null }, content: [t("```\nx")] },
        { type: "paragraph" },
        { type: "horizontalRule" },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [p(t("a|b"))] }, { type: "tableHeader", content: [p()] }] },
            { type: "tableRow", content: [{ type: "tableCell", content: [p(t("1"))] }, { type: "tableCell", content: [p(t("2", "bold"))] }] },
          ],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe(
      [
        "## Plan",
        "",
        "- un",
        "  1. a",
        "- deux",
        "",
        "- [x] relire",
        "- [ ] ficher",
        "",
        "> Ligne 1",
        ">",
        "> Ligne 2",
        "",
        "````",
        "```",
        "x",
        "````",
        "",
        "---",
        "",
        "| a\\|b |   |",
        "| --- | --- |",
        "| 1 | **2** |",
        "",
      ].join("\n"),
    );
  });

  it("rend une note vide vide", () => {
    expect(docToMarkdown({ type: "doc", content: [{ type: "paragraph" }] })).toBe("");
  });
});

describe("aller-retour", () => {
  const samples = [
    "# Thermodynamique\n\nPremier **principe** : $\\Delta U = W + Q$.\n",
    "## Liste\n\n- un\n  - un bis\n- deux\n\n1. a\n2. b\n",
    "- [ ] relire le chapitre 2\n- [x] fiche du chapitre 1\n",
    "> Une citation\n> sur deux lignes\n",
    "```rust\nfn main() {}\n```\n",
    "| Grandeur | Unité |\n| --- | --- |\n| Force | N |\n| Énergie | J |\n",
    "Voir [Cours 1, p. 3](cadence:documents/document?doc=atomes&page=3) et `code`.\n",
    "Ligne\\\nretour forcé\n\n---\n\nFin *italique* ~~barré~~.\n",
  ];
  it.each(samples)("garde le texte : %j", (md) => {
    const once = roundTrip(md);
    expect(roundTrip(once)).toBe(once);
    expect(markdownToDoc(once)).toEqual(markdownToDoc(md));
  });

  it("garde à l'identique le Markdown déjà normalisé", () => {
    for (const md of [samples[1]!, samples[2]!, samples[4]!, samples[5]!, samples[6]!]) {
      expect(roundTrip(md)).toBe(md);
    }
  });
});
