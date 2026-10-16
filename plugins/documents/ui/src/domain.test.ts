import { describe, expect, it } from "vitest";
import { fileName, groupDocuments, type DocumentInfo } from "./domain";

const doc = (id: string, subject: string, chapter: string): DocumentInfo => ({
  id,
  title: id,
  kind: "pdf",
  source: `cours/${id}.pdf`,
  pages: 3,
  chars: 900,
  imported_at: "2026-10-16T09:00:00Z",
  subject,
  subject_name: subject.toUpperCase(),
  chapter,
  chapter_name: chapter,
  page_unit: "page",
});

describe("bibliothèque", () => {
  it("groupe par matière puis chapitre", () => {
    const groups = groupDocuments([doc("a", "chimie", "atomes"), doc("b", "chimie", "liaisons"), doc("c", "chimie", "atomes")]);
    const chimie = groups.get("chimie")!;
    expect(chimie.name).toBe("CHIMIE");
    expect([...chimie.chapters.keys()]).toEqual(["atomes", "liaisons"]);
    expect(chimie.chapters.get("atomes")!.docs.map((d) => d.id)).toEqual(["a", "c"]);
  });

  it("tire le nom de fichier d'un chemin Windows ou POSIX", () => {
    expect(fileName("C:\\cours\\TD 1.pdf")).toBe("TD 1.pdf");
    expect(fileName("/home/me/notes.md")).toBe("notes.md");
  });
});
