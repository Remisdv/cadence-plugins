/** Blocs de l'éditeur de notes (menu « / ») et liens vers les documents, sans dépendance à l'éditeur. */

export type BlockId =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "bullets"
  | "numbers"
  | "tasks"
  | "quote"
  | "code"
  | "divider"
  | "table"
  | "link";

export interface BlockChoice {
  id: BlockId;
  label: string;
  hint: string;
  /** Repère visuel du menu (texte, pas d'icône d'une autre bibliothèque). */
  glyph: string;
  /** Raccourci Markdown équivalent, tapé en début de ligne. */
  markdown?: string;
  keywords: string[];
}

export const BLOCKS: BlockChoice[] = [
  { id: "paragraph", label: "Texte", hint: "Paragraphe simple", glyph: "T", keywords: ["paragraphe", "texte"] },
  { id: "h1", label: "Titre 1", hint: "Grand titre de section", glyph: "H1", markdown: "#", keywords: ["titre", "heading", "h1"] },
  { id: "h2", label: "Titre 2", hint: "Titre de sous-section", glyph: "H2", markdown: "##", keywords: ["titre", "heading", "h2", "sous-titre"] },
  { id: "h3", label: "Titre 3", hint: "Petit titre", glyph: "H3", markdown: "###", keywords: ["titre", "heading", "h3"] },
  { id: "bullets", label: "Liste à puces", hint: "Liste simple", glyph: "•", markdown: "-", keywords: ["liste", "puces", "bullet"] },
  { id: "numbers", label: "Liste numérotée", hint: "Étapes dans l'ordre", glyph: "1.", markdown: "1.", keywords: ["liste", "numerotee", "ordonnee", "numero"] },
  { id: "tasks", label: "Cases à cocher", hint: "Liste de choses à faire", glyph: "☐", markdown: "[]", keywords: ["tache", "todo", "case", "cocher", "checklist"] },
  { id: "quote", label: "Citation", hint: "Définition, extrait du cours", glyph: "❝", markdown: ">", keywords: ["citation", "quote", "definition"] },
  { id: "code", label: "Code", hint: "Bloc de code ou formule brute", glyph: "</>", markdown: "```", keywords: ["code", "programme", "formule"] },
  { id: "divider", label: "Séparateur", hint: "Ligne horizontale", glyph: "—", markdown: "---", keywords: ["separateur", "ligne", "divider", "hr"] },
  { id: "table", label: "Tableau", hint: "Tableau de 3 × 3", glyph: "▦", keywords: ["tableau", "table", "grille"] },
  { id: "link", label: "Lien vers un document", hint: "Un cours, une page, une autre note", glyph: "↗", keywords: ["lien", "document", "page", "cours", "note", "reference"] },
];

/** Minuscules sans accents, pour filtrer le menu. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Blocs qui correspondent à ce qui suit « / » (libellé ou mot-clé, sans accents ni casse). */
export function filterBlocks(query: string): BlockChoice[] {
  const q = foldText(query.trim());
  if (!q) return BLOCKS;
  const starts = BLOCKS.filter((b) => [b.label, ...b.keywords].some((w) => foldText(w).startsWith(q)));
  const contains = BLOCKS.filter(
    (b) => !starts.includes(b) && [b.label, b.hint, ...b.keywords].some((w) => foldText(w).includes(q)),
  );
  return [...starts, ...contains];
}

/* ---------- Liens ---------- */

export interface DocumentTarget {
  doc: string;
  page?: number;
}

/** Lien Cadence qui ouvre un document (et une page) : `cadence:documents/document?doc=…&page=…`. */
export function documentLink(doc: string, page?: number | null): string {
  const params = new URLSearchParams({ doc });
  if (page != null && page > 0) params.set("page", String(page));
  return `cadence:documents/document?${params.toString()}`;
}

/** Document visé par un lien `cadence:documents/document?…` ; `null` pour un autre lien. */
export function parseDocumentLink(href: string): DocumentTarget | null {
  const m = /^cadence:documents\/document\?(.*)$/.exec(href.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const doc = params.get("doc");
  if (!doc) return null;
  const page = Number(params.get("page"));
  return Number.isInteger(page) && page > 0 ? { doc, page } : { doc };
}

/** Texte d'un lien vers un document : « Cours 1 — L'atome, p. 3 ». */
export function linkText(title: string, page?: number | null, unit = "p."): string {
  return page ? `${title}, ${unit} ${page}` : title;
}

/** Abréviation de l'unité de page d'un document pour un lien. */
export function pageAbbrev(kind: string): string {
  switch (kind) {
    case "pptx":
      return "diapo";
    case "pdf":
      return "p.";
    case "note":
      return "section";
    default:
      return "bloc";
  }
}
