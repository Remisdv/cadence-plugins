import { describe, expect, it } from "vitest";
import {
  deckDone,
  deckMissed,
  deckReducer,
  fileName,
  flashcardItems,
  formatScore,
  groupDocuments,
  openQuestionItems,
  percentOf,
  qcmItems,
  scoreTone,
  shuffled,
  sourceLabel,
  startDeck,
  type DocumentInfo,
} from "./domain";

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

describe("entraînement", () => {
  it("garde les questions de QCM bien formées", () => {
    const items = qcmItems([
      { question: "Q1", choices: ["a", "b"], answer: 1, explanation: "car b", source: { document: "atomes", page: 2 } },
      { question: "Q2", choices: ["a"], answer: 0 },
      { question: "Q3", choices: ["a", "b"], answer: 2 },
      { choices: ["a", "b"], answer: 0 },
      "texte",
    ]);
    expect(items).toEqual([
      { question: "Q1", choices: ["a", "b"], answer: 1, explanation: "car b", source: { document: "atomes", page: 2 } },
    ]);
  });

  it("lit les cartes et les questions ouvertes sans le barème", () => {
    expect(flashcardItems([{ front: "Z", back: "Protons" }, { front: "A" }])).toEqual([
      { front: "Z", back: "Protons", source: undefined },
    ]);
    const open = openQuestionItems([
      { question: "Pourquoi ?", points: 4, expected: [{ element: "secret", points: 4 }], source: { document: "cours" } },
    ]);
    expect(open).toEqual([{ question: "Pourquoi ?", points: 4, source: { document: "cours", page: undefined } }]);
    expect(JSON.stringify(open)).not.toContain("secret");
  });

  it("formate sources, scores et couleurs", () => {
    expect(sourceLabel({ document: "atomes", page: 2 })).toBe("atomes, p. 2");
    expect(sourceLabel({ document: "atomes", page: 2 }, { atomes: "Cours 1 — L'atome" })).toBe("Cours 1 — L'atome, p. 2");
    expect(sourceLabel({ document: "notes" })).toBe("notes");
    expect(sourceLabel(null)).toBeNull();
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(1, 0)).toBeNull();
    expect(percentOf(null, 3)).toBeNull();
    expect(formatScore(12, 15)).toBe("12/15");
    expect(formatScore(6.5, 10)).toBe("6,5/10");
    expect(formatScore(null, 10)).toBe("—");
    expect([scoreTone(85), scoreTone(50), scoreTone(49), scoreTone(null)]).toEqual(["green", "amber", "red", "neutral"]);
  });

  it("fait tourner un paquet de flashcards", () => {
    let s = startDeck([0, 1, 2]);
    s = deckReducer(s, { type: "flip" });
    expect(s.flipped).toBe(true);
    s = deckReducer(s, { type: "mark", known: true });
    expect([s.position, s.flipped]).toEqual([1, false]);
    s = deckReducer(s, { type: "mark", known: false });
    expect(deckDone(s)).toBe(false);
    s = deckReducer(s, { type: "mark", known: false });
    expect(deckDone(s)).toBe(true);
    expect(deckMissed(s)).toEqual([1, 2]);
    // Rien à noter après la dernière carte.
    expect(deckReducer(s, { type: "mark", known: true })).toBe(s);
    // Tour de rattrapage sur les cartes manquées.
    const again = deckReducer(s, { type: "restart", order: deckMissed(s) });
    expect([again.order, again.position, again.marks]).toEqual([[1, 2], 0, {}]);
  });

  it("mélange toutes les cartes une fois chacune", () => {
    const order = shuffled(5, () => 0);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(order).toEqual([1, 2, 3, 4, 0]);
    expect(shuffled(0)).toEqual([]);
  });
});
