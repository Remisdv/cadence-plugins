/** Données rendues par le serveur `cadence-documents`. */
import type { BadgeTone, IconName } from "@cadence/ui";

export type DocKind = "pdf" | "docx" | "pptx" | "markdown" | "text";
export type QuizKind = "qcm" | "questions_ouvertes" | "flashcards";

export interface SubjectSummary {
  id: string;
  name: string;
  chapters: number;
  documents: number;
}

export interface DocumentInfo {
  id: string;
  title: string;
  kind: DocKind;
  source: string;
  pages: number;
  chars: number;
  imported_at: string;
  subject: string;
  subject_name: string;
  chapter: string;
  chapter_name: string;
  page_unit: string;
}

export interface QuizSummary {
  id: string;
  kind: QuizKind;
  title: string;
  subject: string | null;
  chapter: string | null;
  items: number;
  created_at: string;
  last_result: { score: number | null; total: number | null; at: string } | null;
}

export const kindMeta: Record<DocKind, { label: string; tone: BadgeTone }> = {
  pdf: { label: "PDF", tone: "red" },
  docx: { label: "Word", tone: "blue" },
  pptx: { label: "PowerPoint", tone: "amber" },
  markdown: { label: "Markdown", tone: "muted" },
  text: { label: "Texte", tone: "neutral" },
};

export const quizMeta: Record<QuizKind, { label: string; action: string }> = {
  qcm: { label: "QCM", action: "generer-qcm" },
  questions_ouvertes: { label: "Questions ouvertes", action: "questions-ouvertes" },
  flashcards: { label: "Flashcards", action: "flashcards" },
};

export const ACCEPTED_EXTENSIONS = ["pdf", "docx", "pptx", "md", "markdown", "txt"];

export const views = {
  bibliotheque: { title: "Bibliothèque", icon: "book" },
  entrainement: { title: "Entraînement", icon: "sparkle" },
  "setup-dossier": { title: "Dossier des cours", icon: "folder" },
} satisfies Record<string, { title: string; icon: IconName }>;

/** Documents groupés par matière puis chapitre, dans l'ordre de la bibliothèque. */
export function groupDocuments(docs: DocumentInfo[]) {
  const subjects = new Map<string, { name: string; chapters: Map<string, { name: string; docs: DocumentInfo[] }> }>();
  for (const d of docs) {
    let s = subjects.get(d.subject);
    if (!s) subjects.set(d.subject, (s = { name: d.subject_name, chapters: new Map() }));
    let c = s.chapters.get(d.chapter);
    if (!c) s.chapters.set(d.chapter, (c = { name: d.chapter_name, docs: [] }));
    c.docs.push(d);
  }
  return subjects;
}

/** Nom de fichier sans dossier, pour proposer un titre. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
