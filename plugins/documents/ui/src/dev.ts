/** Hôte simulé pour `pnpm dev` hors de Cadence (bibliothèque en mémoire). */
import type { MockHostOptions } from "@cadence/plugin-sdk";
import { fileName, qcmItems, type DocumentInfo, type HistoryEntry, type NoteDoc, type Quiz } from "./domain";

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

/** Notes simulées : Markdown en mémoire, découpé par titres comme le serveur. */
const notes = new Map<string, string>([
  [
    "fiche-atome",
    [
      "Résumé du cours, à compléter.",
      "",
      "# Le noyau",
      "",
      "> **Numéro atomique Z** : nombre de protons du noyau ([Cours 1 — L'atome, p. 3](cadence:documents/document?doc=atomes&page=3)).",
      "",
      "- Protons : charge +e",
      "- Neutrons : charge nulle",
      "",
      "# Les électrons",
      "",
      "1. Règle de Klechkowski",
      "2. Principe de Pauli",
      "",
      "| Couche | Électrons max |",
      "| --- | --- |",
      "| K | 2 |",
      "| L | 8 |",
      "",
      "- [x] Relire le TD 1",
      "- [ ] Refaire l'exercice 4",
      "",
    ].join("\n"),
  ],
]);

docs.push({
  id: "fiche-atome",
  title: "Fiche — l'atome",
  kind: "note",
  source: "C:/etudes/l3/cours/Notes/Chimie/Atomistique/Fiche — l'atome.md",
  pages: 3,
  chars: 400,
  imported_at: "2026-10-16T08:00:00Z",
  updated_at: "2026-10-18T17:20:00Z",
  revision: 1,
  subject: "chimie",
  subject_name: "Chimie",
  chapter: "atomistique",
  chapter_name: "Atomistique",
  page_unit: "section",
});

function sections(markdown: string) {
  const pages: string[] = [];
  let current = "";
  let code = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) code = !code;
    else if (!code && /^#{1,3}\s+\S/.test(line) && current.trim()) {
      pages.push(current.trim());
      current = "";
    }
    current += `${line}\n`;
  }
  if (current.trim() || !pages.length) pages.push(current.trim());
  return pages.map((text, i) => ({
    page: i + 1,
    title: /^#{1,3}\s+(.+)$/.exec(text.split("\n")[0] ?? "")?.[1] ?? null,
    text,
  }));
}

function noteDoc(id: string): NoteDoc {
  const d = docs.find((x) => x.id === id && x.kind === "note");
  if (!d) throw new Error(`Note « ${id} » introuvable.`);
  const markdown = notes.get(id) ?? "";
  const s = sections(markdown);
  return {
    ...d,
    kind: "note",
    revision: d.revision ?? 1,
    pages: s.length,
    markdown,
    sections: s.map(({ page, title }) => ({ page, title })),
    missing_file: false,
    link: `cadence:documents/document?doc=${id}`,
  };
}

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
  plugin: { id: "documents", version: "0.4.0" },
  settings: { dossier_cours: "C:/etudes/l3/cours", questions_par_qcm: 10, cartes_par_paquet: 20 },
  route: {
    view: new URLSearchParams(location.search).get("view") ?? "bibliotheque",
    params: Object.fromEntries([...new URLSearchParams(location.search)].filter(([k]) => k !== "view")),
  },
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
    read_pages: ({ document, from }) => {
      const d = docs.find((x) => x.id === document);
      if (!d) throw new Error(`Document « ${String(document)} » introuvable.`);
      const page = Number(from ?? 1);
      const text =
        d.kind === "note"
          ? (sections(notes.get(d.id) ?? "")[page - 1]?.text ?? "")
          : `Texte simulé de « ${d.title} », ${d.page_unit} ${page}.\n\nLe noyau atomique contient Z protons et N neutrons ; A = Z + N.`;
      return {
        document: d.id,
        title: d.title,
        kind: d.kind,
        subject: d.subject_name,
        chapter: d.chapter_name,
        page_unit: d.page_unit,
        total_pages: d.pages,
        pages: [{ page, text, link: `cadence:documents/document?doc=${d.id}&page=${page}` }],
        next_page: page < d.pages ? page + 1 : null,
      };
    },
    list_notes: () => ({
      notes_dir: "C:/etudes/l3/cours/Notes",
      notes: docs
        .filter((d) => d.kind === "note")
        .map((d) => {
          const n = noteDoc(d.id);
          return { ...n, path: n.source, updated_at: n.updated_at ?? null };
        }),
    }),
    get_note: ({ note }) => ({ note: noteDoc(String(note)) }),
    create_note: ({ subject, chapter, title, content }) => {
      const name = String(title ?? "").trim() || "Sans titre";
      let id = name
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "sans-titre";
      while (docs.some((d) => d.id === id)) id += "-2";
      const ref = docs.find((d) => d.subject === subject || d.subject_name === subject);
      const now = new Date().toISOString();
      docs.push({
        ...docs[0]!,
        id,
        title: name,
        kind: "note",
        source: `C:/etudes/l3/cours/Notes/${String(subject)}/${String(chapter)}/${name}.md`,
        pages: 1,
        chars: 0,
        imported_at: now,
        updated_at: now,
        revision: 1,
        subject: ref?.subject ?? String(subject).toLowerCase(),
        subject_name: ref?.subject_name ?? String(subject),
        chapter: String(chapter).toLowerCase(),
        chapter_name: docs.find((d) => d.chapter === chapter)?.chapter_name ?? String(chapter),
        page_unit: "section",
      });
      notes.set(id, String(content ?? ""));
      return { note: noteDoc(id) };
    },
    update_note: ({ note, content, title, append, revision }) => {
      const d = docs.find((x) => x.id === note && x.kind === "note");
      if (!d) throw new Error(`Note « ${String(note)} » introuvable.`);
      if (revision != null && revision !== d.revision) {
        throw new Error(`La note a été enregistrée depuis la révision ${String(revision)} (révision actuelle : ${d.revision}).`);
      }
      if (typeof content === "string") notes.set(d.id, append ? `${notes.get(d.id) ?? ""}\n\n${content}` : content);
      if (typeof title === "string" && title.trim()) d.title = title.trim();
      d.revision = (d.revision ?? 1) + 1;
      d.updated_at = new Date().toISOString();
      d.pages = sections(notes.get(d.id) ?? "").length;
      return { note: noteDoc(d.id) };
    },
    delete_note: ({ note }) => {
      const i = docs.findIndex((x) => x.id === note && x.kind === "note");
      if (i < 0) throw new Error(`Note « ${String(note)} » introuvable.`);
      const [d] = docs.splice(i, 1);
      notes.delete(String(note));
      return { deleted: d };
    },
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
