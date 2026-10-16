/** Hôte simulé pour `pnpm dev` hors de Cadence (bibliothèque en mémoire). */
import type { MockHostOptions } from "@cadence/plugin-sdk";
import { fileName, type DocumentInfo } from "./domain";

const docs: DocumentInfo[] = [
  {
    id: "atomes",
    title: "Cours 1 — L'atome",
    kind: "pdf",
    source: "cours/chimie/atomes.pdf",
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
    source: "cours/chimie/td1.pptx",
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

export const devHost: MockHostOptions = {
  plugin: { id: "documents", version: "0.1.0" },
  workspace: { name: "L3 Info", path: "C:/etudes/l3", ai: "claude-code" },
  route: { view: new URLSearchParams(location.search).get("view") ?? "bibliotheque", params: {} },
  pickFiles: () => ["C:/etudes/l3/cours/reseaux/tcp.pdf"],
  tools: {
    list_documents: () => ({ documents: docs }),
    list_quizzes: () => ({ quizzes: [] }),
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
