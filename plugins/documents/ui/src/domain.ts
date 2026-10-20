/** Données rendues par le serveur `cadence-documents`. */
import type { BadgeTone, IconName, ProgressTone } from "@cadence/ui";

export type DocKind = "pdf" | "docx" | "pptx" | "markdown" | "text" | "note";
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
  /** Note : dernière modification et révision. */
  updated_at?: string;
  revision?: number;
}

/** Section d'une note (une page pour `read_pages`). */
export interface NoteSection {
  page: number;
  title: string | null;
}

/** Note complète (`get_note`, `create_note`, `update_note`). */
export interface NoteDoc extends DocumentInfo {
  kind: "note";
  revision: number;
  markdown: string;
  sections: NoteSection[];
  missing_file: boolean;
  link: string;
}

/** Ligne de `list_notes`. */
export interface NoteSummary {
  id: string;
  title: string;
  subject: string;
  subject_name: string;
  chapter: string;
  chapter_name: string;
  revision: number;
  updated_at: string | null;
  path: string;
  sections: NoteSection[];
  chars: number;
  link: string;
}

/** Pages lues (`read_pages`). */
export interface PagesRead {
  document: string;
  title: string;
  kind: DocKind;
  subject: string;
  chapter: string;
  page_unit: string;
  total_pages: number;
  pages: { page: number; text: string; link: string; section?: string | null }[];
  next_page: number | null;
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
  note: { label: "Note", tone: "green" },
};

/** Nombre de pages d'un document, dans son unité : « 24 p. », « 12 diapo. », « 3 sections ». */
export function pagesLabel(kind: DocKind, pages: number): string {
  switch (kind) {
    case "pdf":
      return `${pages} p.`;
    case "pptx":
      return `${pages} diapo.`;
    case "note":
      return pages > 1 ? `${pages} sections` : "1 section";
    default:
      return `${pages} blocs`;
  }
}

/** Unité d'une page à l'écran : « Page 3 », « Diapositive 3 », « Section 3 », « Bloc 3 ». */
export function pageName(kind: DocKind, page: number): string {
  const unit = kind === "pdf" ? "Page" : kind === "pptx" ? "Diapositive" : kind === "note" ? "Section" : "Bloc";
  return `${unit} ${page}`;
}

/**
 * Titre de section à afficher pour une page de note : celui de la page, ou de la dernière page
 * titrée avant elle (section trop longue redécoupée). Renvoie son rang parmi les titres de
 * niveau 1 à 3 de la note (0 pour le premier), ou -1 pour le début de la note.
 */
export function headingIndexForPage(sections: NoteSection[], page: number): number {
  let index = -1;
  let titled = -1;
  for (const s of sections) {
    if (s.title != null) titled++;
    if (s.page > page) break;
    if (s.title != null) index = titled;
  }
  return index;
}

export const quizMeta: Record<QuizKind, { label: string; action: string; tone: BadgeTone; start: string }> = {
  qcm: { label: "QCM", action: "generer-qcm", tone: "clay", start: "Commencer" },
  questions_ouvertes: { label: "Questions ouvertes", action: "questions-ouvertes", tone: "purple", start: "Ouvrir" },
  flashcards: { label: "Flashcards", action: "flashcards", tone: "blue", start: "Réviser" },
};

/* ---------- Entraînement ---------- */

/** Document et page d'où vient une question ou une carte. */
export interface ItemSource {
  document: string;
  page?: number;
}

export interface QcmItem {
  question: string;
  choices: string[];
  /** Indice de la bonne réponse, à partir de 0. */
  answer: number;
  explanation?: string;
  source?: ItemSource;
}

export interface FlashcardItem {
  front: string;
  back: string;
  source?: ItemSource;
}

export interface OpenQuestionItem {
  question: string;
  points?: number;
  source?: ItemSource;
}

/** Entraînement complet (`get_quiz`). */
export interface Quiz {
  id: string;
  kind: QuizKind;
  title: string;
  subject: string | null;
  chapter: string | null;
  items: unknown[];
  created_at: string;
}

/** Correction d'une question renvoyée par `submit_qcm`. */
export interface QcmCorrection {
  question: string;
  choices: string[];
  chosen: number | null;
  answer: number;
  correct: boolean;
  explanation: string | null;
  source: ItemSource | null;
}

export interface QuizResult {
  id: string;
  quiz: string;
  score: number | null;
  total: number | null;
  feedback: string | null;
  created_at: string;
}

/** Ligne de l'historique des scores (`list_results`). */
export interface HistoryEntry {
  id: string;
  quiz: string;
  title: string | null;
  kind: QuizKind | null;
  subject: string | null;
  chapter: string | null;
  score: number | null;
  total: number | null;
  percent: number | null;
  created_at: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function readSource(v: unknown): ItemSource | undefined {
  if (!isObject(v) || !isText(v.document)) return undefined;
  return { document: v.document, page: typeof v.page === "number" ? v.page : undefined };
}

/** Questions de QCM bien formées (les autres sont écartées, le serveur les refuse déjà). */
export function qcmItems(items: unknown[]): QcmItem[] {
  return items.flatMap((it) => {
    if (!isObject(it) || !isText(it.question) || !Array.isArray(it.choices)) return [];
    const choices = it.choices.filter(isText);
    const answer = it.answer;
    if (choices.length < 2 || typeof answer !== "number" || answer < 0 || answer >= choices.length) return [];
    return [
      {
        question: it.question,
        choices,
        answer,
        explanation: isText(it.explanation) ? it.explanation : undefined,
        source: readSource(it.source),
      },
    ];
  });
}

export function flashcardItems(items: unknown[]): FlashcardItem[] {
  return items.flatMap((it) =>
    isObject(it) && isText(it.front) && isText(it.back)
      ? [{ front: it.front, back: it.back, source: readSource(it.source) }]
      : [],
  );
}

/** Questions ouvertes, sans le barème (`expected`), que l'étudiant ne doit pas voir. */
export function openQuestionItems(items: unknown[]): OpenQuestionItem[] {
  return items.flatMap((it) =>
    isObject(it) && isText(it.question)
      ? [{ question: it.question, points: typeof it.points === "number" ? it.points : undefined, source: readSource(it.source) }]
      : [],
  );
}

/** « atomes, p. 2 » ; titre du document à la place de son identifiant quand on le connaît. */
export function sourceLabel(source: ItemSource | null | undefined, titles: Record<string, string> = {}): string | null {
  if (!source) return null;
  const name = titles[source.document] ?? source.document;
  return source.page != null ? `${name}, p. ${source.page}` : name;
}

/** Pourcentage arrondi, `null` sans total. */
export function percentOf(score: number | null, total: number | null): number | null {
  if (score == null || total == null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((score / total) * 100)));
}

/** « 12/15 » ; nombres décimaux gardés tels quels (barème des questions ouvertes). */
export function formatScore(score: number | null, total: number | null): string {
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(".", ","));
  if (score == null) return "—";
  return total == null ? n(score) : `${n(score)}/${n(total)}`;
}

/** Couleur d'un score : vert à partir de 80 %, ambre à partir de 50 %, rouge en dessous. */
export function scoreTone(percent: number | null): "green" | "amber" | "red" | "neutral" {
  if (percent == null) return "neutral";
  return percent >= 80 ? "green" : percent >= 50 ? "amber" : "red";
}

/** Barre de progression d'un score (le kit n'a pas de barre rouge : clay pour un score faible). */
export const SCORE_BAR = { green: "green", amber: "amber", red: "clay", neutral: "neutral" } as const satisfies Record<
  ReturnType<typeof scoreTone>,
  ProgressTone
>;

/** Date courte en français : « 16 oct. 2026, 09:30 ». */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** Paquet de flashcards en cours de révision. */
export interface DeckState {
  /** Indices des cartes de ce tour, dans l'ordre de passage. */
  order: number[];
  position: number;
  flipped: boolean;
  /** Carte → sue (vrai) ou à revoir (faux), pour ce tour. */
  marks: Record<number, boolean>;
}

export type DeckAction =
  | { type: "flip" }
  | { type: "mark"; known: boolean }
  | { type: "restart"; order: number[] };

export function startDeck(order: number[]): DeckState {
  return { order, position: 0, flipped: false, marks: {} };
}

/** Retourne la carte, ou la note (sue / à revoir) et passe à la suivante. */
export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "flip":
      return { ...state, flipped: !state.flipped };
    case "mark": {
      const card = state.order[state.position];
      if (card === undefined) return state;
      return { ...state, marks: { ...state.marks, [card]: action.known }, position: state.position + 1, flipped: false };
    }
    case "restart":
      return startDeck(action.order);
  }
}

/** Tour terminé : toutes les cartes du tour sont notées. */
export const deckDone = (s: DeckState) => s.position >= s.order.length;
/** Cartes à revoir du tour, dans l'ordre de passage. */
export const deckMissed = (s: DeckState) => s.order.filter((i) => s.marks[i] === false);

/** Mélange de Fisher-Yates (aléatoire injectable pour les tests). */
export function shuffled(n: number, random: () => number = Math.random): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const ACCEPTED_EXTENSIONS = ["pdf", "docx", "pptx", "md", "markdown", "txt"];

export const views = {
  bibliotheque: { title: "Bibliothèque", icon: "book" },
  entrainement: { title: "Entraînement", icon: "sparkle" },
  document: { title: "Notes", icon: "pen" },
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
