import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHref } from "./markdown";

describe("markdown des issues", () => {
  it("découpe titres, paragraphes, listes, cases, citations, code et séparateurs", () => {
    const blocks = parseMarkdown(
      [
        "## Contexte",
        "Une ligne",
        "suite du paragraphe.",
        "",
        "- un",
        "- deux",
        "  continuation",
        "1. premier",
        "",
        "- [x] fait",
        "- [ ] à faire",
        "> citée",
        "```ts",
        "const a = 1;",
        "```",
        "---",
      ].join("\r\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Contexte" },
      { kind: "paragraph", text: "Une ligne suite du paragraphe." },
      { kind: "list", ordered: false, items: ["un", "deux continuation"] },
      { kind: "list", ordered: true, items: ["premier"] },
      {
        kind: "tasks",
        items: [
          { done: true, text: "fait" },
          { done: false, text: "à faire" },
        ],
      },
      { kind: "quote", text: "citée" },
      { kind: "code", text: "const a = 1;" },
      { kind: "rule" },
    ]);
  });

  it("rend le code dans du gras sans accents graves littéraux", () => {
    expect(parseInline("voir **`me/app`** et `x`")).toEqual([
      { kind: "text", text: "voir " },
      { kind: "strong", children: [{ kind: "code", text: "me/app" }] },
      { kind: "text", text: " et " },
      { kind: "code", text: "x" },
    ]);
    expect(parseInline("*penché* et `**pas gras**`")).toEqual([
      { kind: "em", children: [{ kind: "text", text: "penché" }] },
      { kind: "text", text: " et " },
      { kind: "code", text: "**pas gras**" },
    ]);
  });

  it("garde les liens http(s) et laisse en texte les autres schémas", () => {
    expect(parseInline("[doc](https://docs.github.com)")).toEqual([
      { kind: "link", href: "https://docs.github.com", children: [{ kind: "text", text: "doc" }] },
    ]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[x](javascript:alert(1))" },
    ]);
    expect(safeHref("mailto:moi@exemple.fr")).toBe("mailto:moi@exemple.fr");
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });

  it("n'interprète pas le HTML brut", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([
      { kind: "paragraph", text: "<script>alert(1)</script>" },
    ]);
    expect(parseInline("snake_case_name")).toEqual([{ kind: "text", text: "snake_case_name" }]);
  });
});
