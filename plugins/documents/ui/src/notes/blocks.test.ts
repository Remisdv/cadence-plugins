import { describe, expect, it } from "vitest";
import { headingIndexForPage, pageName, pagesLabel } from "../domain";
import { BLOCKS, documentLink, filterBlocks, linkText, pageAbbrev, parseDocumentLink } from "./blocks";

describe("menu « / »", () => {
  it("propose tous les blocs sans requête", () => {
    expect(filterBlocks("")).toBe(BLOCKS);
  });

  it("filtre sans accents ni casse, les débuts de mot d'abord", () => {
    expect(filterBlocks("tit").map((b) => b.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterBlocks("SÉPA").map((b) => b.id)).toEqual(["divider"]);
    expect(filterBlocks("case").map((b) => b.id)).toEqual(["tasks"]);
    expect(filterBlocks("liste").map((b) => b.id)).toEqual(["bullets", "numbers", "tasks"]);
    expect(filterBlocks("lien")[0]!.id).toBe("link");
    expect(filterBlocks("zzz")).toEqual([]);
  });
});

describe("liens vers les documents", () => {
  it("écrit et relit les liens cadence:documents/document", () => {
    expect(documentLink("atomes", 3)).toBe("cadence:documents/document?doc=atomes&page=3");
    expect(documentLink("fiche-atome")).toBe("cadence:documents/document?doc=fiche-atome");
    expect(parseDocumentLink("cadence:documents/document?doc=atomes&page=3")).toEqual({ doc: "atomes", page: 3 });
    expect(parseDocumentLink("cadence:documents/document?doc=atomes&page=x")).toEqual({ doc: "atomes" });
    expect(parseDocumentLink("cadence:documents/entrainement?quiz=a")).toBeNull();
    expect(parseDocumentLink("https://exemple.org")).toBeNull();
  });

  it("donne un texte de lien dans l'unité du document", () => {
    expect(linkText("TD 1", 4, pageAbbrev("pptx"))).toBe("TD 1, diapo 4");
    expect(linkText("Cours 1", 12, pageAbbrev("pdf"))).toBe("Cours 1, p. 12");
    expect(linkText("Fiche", null)).toBe("Fiche");
    expect(pageAbbrev("note")).toBe("section");
  });
});

describe("sections des notes", () => {
  const sections = [
    { page: 1, title: null }, // texte avant le premier titre
    { page: 2, title: "Noyau" },
    { page: 3, title: null }, // suite d'une section trop longue
    { page: 4, title: "Électrons" },
  ];
  it("retrouve le titre d'une page de note", () => {
    expect(headingIndexForPage(sections, 1)).toBe(-1);
    expect(headingIndexForPage(sections, 2)).toBe(0);
    expect(headingIndexForPage(sections, 3)).toBe(0);
    expect(headingIndexForPage(sections, 4)).toBe(1);
    expect(headingIndexForPage(sections, 9)).toBe(1);
  });

  it("nomme les pages et leur nombre", () => {
    expect(pagesLabel("note", 1)).toBe("1 section");
    expect(pagesLabel("note", 3)).toBe("3 sections");
    expect(pagesLabel("pdf", 24)).toBe("24 p.");
    expect(pageName("note", 2)).toBe("Section 2");
    expect(pageName("pptx", 2)).toBe("Diapositive 2");
  });
});
