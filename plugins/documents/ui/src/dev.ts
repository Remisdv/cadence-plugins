/** Hôte simulé pour `pnpm dev` hors de Cadence (bibliothèque en mémoire). */
import type { MockHostOptions } from "@cadence/plugin-sdk";
import { fileName, qcmItems, type DocumentInfo, type HistoryEntry, type Quiz } from "./domain";

const docs: DocumentInfo[] = [
  {
    id: "atomes",
    title: "Cours 1 — L'atome",
    kind: "pdf",
    source: "C:/etudes/l3/cours/chimie/atomes.pdf",
    pages: 24,
    chars: 41000,
    imported_at: "2026-10-12T08:00:00Z",
    subject: "chimie",
    subject_name: "Chimie",
    chapter: "atomistique",
    chapter_name: "Atomistique",
    page_unit: "page",
  },
  {
    id: "td-1",
    title: "TD 1",
    kind: "pptx",
    source: "C:/etudes/l3/cours/chimie/td1.pptx",
    pages: 12,
    chars: 6000,
    imported_at: "2026-10-13T08:00:00Z",
    subject: "chimie",
    subject_name: "Chimie",
    chapter: "atomistique",
    chapter_name: "Atomistique",
    page_unit: "diapositive",
  },
];

const quizzes: Quiz[] = [
  {
    id: "qcm-atomistique-1",
    kind: "qcm",
    title: "Atomistique — QCM 1",
    subject: "chimie",
    chapter: "atomistique",
    created_at: "2026-10-14T18:00:00Z",
    items: [
      {
        question: "Quelle est la charge du proton ?",
        choices: ["+e", "−e", "0", "+2e"],
        answer: 0,
        explanation: "Le proton porte la charge élémentaire positive ; l'électron porte −e.",
        source: { document: "atomes", page: 2 },
      },
      {
        question: "Que désigne le numéro atomique Z ?",
        choices: ["Le nombre de nucléons", "Le nombre de protons", "Le nombre de neutrons"],
        answer: 1,
        explanation: "Z compte les protons ; A compte les nucléons.",
        source: { document: "atomes", page: 3 },
      },
      {
        question: "Combien d'électrons au plus sur la couche n = 2 ?",
        choices: ["2", "8", "18"],
        answer: 1,
        source: { document: "td-1", page: 4 },
      },
    ],
  },
  {
    id: "flashcards-atomistique",
    kind: "flashcards",
    title: "Atomistique — notions clés",
    subject: "chimie",
    chapter: "atomistique",
    created_at: "2026-10-15T08:00:00Z",
    items: [
      { front: "Numéro atomique Z", back: "Nombre de protons du noyau.", source: { document: "atomes", page: 1 } },
      { front: "Nombre de masse A", back: "Nombre de nucléons (protons + neutrons).", source: { document: "atomes", page: 1 } },
      { front: "Isotopes", back: "Même Z, A différent.", source: { document: "atomes", page: 5 } },
    ],
  },
  {
    id: "questions-premier-principe",
    kind: "questions_ouvertes",
    title: "Atomistique — questions de cours",
    subject: "chimie",
    chapter: "atomistique",
    created_at: "2026-10-15T09:00:00Z",
    items: [
      { question: "Expliquez la règle de Klechkowski.", points: 4, source: { document: "atomes", page: 9 } },
      { question: "Pourquoi les gaz nobles sont-ils peu réactifs ?", points: 3 },
    ],
  },
];

const results: HistoryEntry[] = [];

function record(quiz: string, score: number, total: number, feedback: string) {
  const q = quizzes.find((x) => x.id === quiz)!;
  const result = { id: `${quiz}-${results.length + 1}`, quiz, score, total, feedback, created_at: new Date().toISOString() };
  results.unshift({
    ...result,
    title: q.title,
    kind: q.kind,
    subject: q.subject,
    chapter: q.chapter,
    percent: Math.round((score / total) * 100),
  });
  return result;
}

export const devHost: MockHostOptions = {
  plugin: { id: "documents", version: "0.3.0" },
  settings: { dossier_cours: "C:/etudes/l3/cours", questions_par_qcm: 10, cartes_par_paquet: 20 },
  route: { view: new URLSearchParams(location.search).get("view") ?? "bibliotheque", params: {} },
  pickFiles: () => ["C:/etudes/l3/cours/reseaux/tcp.pdf"],
  tools: {
    list_documents: () => ({ documents: docs }),
    list_quizzes: () => ({
      quizzes: quizzes.map((q) => {
        const last = results.find((r) => r.quiz === q.id);
        return {
          ...q,
          items: q.items.length,
          last_result: last ? { score: last.score, total: last.total, at: last.created_at } : null,
        };
      }),
    }),
    get_quiz: ({ id }) => {
      const quiz = quizzes.find((q) => q.id === id);
      if (!quiz) throw new Error(`Quiz « ${String(id)} » introuvable.`);
      return { quiz };
    },
    submit_qcm: ({ quiz, answers }) => {
      const items = qcmItems(quizzes.find((q) => q.id === quiz)!.items);
      const given = answers as (number | null)[];
      const corrections = items.map((it, i) => ({
        ...it,
        explanation: it.explanation ?? null,
        source: it.source ?? null,
        chosen: given[i] ?? null,
        correct: given[i] === it.answer,
      }));
      const score = corrections.filter((c) => c.correct).length;
      return { result: record(String(quiz), score, items.length, `${score}/${items.length}.`), corrections };
    },
    save_result: ({ quiz, score, total, feedback }) => ({
      result: record(String(quiz), Number(score), Number(total), String(feedback ?? "")),
    }),
    list_results: () => ({ results }),
    import_document: ({ path, subject, chapter }) => {
      const id = fileName(String(path)).replace(/\.[^.]+$/, "");
      const d: DocumentInfo = {
        ...docs[0]!,
        id,
        title: id,
        source: String(path),
        subject: String(subject).toLowerCase(),
        subject_name: String(subject),
        chapter: String(chapter).toLowerCase(),
        chapter_name: String(chapter),
      };
      docs.push(d);
      return { document: d };
    },
  },
};
