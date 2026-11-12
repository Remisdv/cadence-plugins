/**
 * Documents du projet (écran « Documents ») : types des outils `docs_*` du serveur, arbre des
 * dossiers, formats et aperçus. Les fichiers vivent dans le dépôt, sous `docs/intern` (réglage
 * `documents_dir`) : toute l'équipe les voit, et l'IA y pioche (`docs_list`, `docs_read`,
 * `docs_search`) pour rédiger des issues pertinentes.
 */
import type { IconName } from "@cadence/ui";

export type DocKind =
  | "pdf"
  | "word"
  | "powerpoint"
  | "markdown"
  | "text"
  | "csv"
  | "excel"
  | "image"
  | "other";

/** Entrée de `docs_list` ; `path` relatif au dossier des documents. */
export interface DocEntry {
  path: string;
  name: string;
  folder: boolean;
  size: number;
  sha: string;
  kind: DocKind | null;
}

export interface DocList {
  repo: string;
  branch: string;
  dir: string;
  url: string;
  files: number;
  entries: DocEntry[];
  templates: string[];
}

/** Tableau d'un CSV ou d'une feuille Excel (`docs_table`). */
export interface DocTable {
  sheets: string[];
  sheet: string | null;
  columns: string[];
  rows: string[][];
  total: number;
}

/** Morceau d'un fichier (`docs_bytes`). */
export interface DocChunk {
  path: string;
  mime: string;
  size: number;
  offset: number;
  next: number | null;
  data: string;
}

/** Nœud de l'arborescence : un dossier et ses enfants (dossiers d'abord, puis fichiers). */
export interface DocNode {
  path: string;
  name: string;
  folder: boolean;
  entry: DocEntry | null;
  children: DocNode[];
}

const byName = (a: DocNode, b: DocNode) =>
  a.folder === b.folder ? a.name.localeCompare(b.name, "fr", { numeric: true }) : a.folder ? -1 : 1;

/** Arbre à partir de la liste plate (dossiers implicites créés au besoin). */
export function buildTree(entries: DocEntry[]): DocNode {
  const root: DocNode = { path: "", name: "", folder: true, entry: null, children: [] };
  const folders = new Map<string, DocNode>([["", root]]);
  const folder = (path: string): DocNode => {
    const found = folders.get(path);
    if (found) return found;
    const cut = path.lastIndexOf("/");
    const parent = folder(cut < 0 ? "" : path.slice(0, cut));
    const node: DocNode = { path, name: path.slice(cut + 1), folder: true, entry: null, children: [] };
    parent.children.push(node);
    folders.set(path, node);
    return node;
  };
  for (const e of entries) {
    if (e.folder) {
      folder(e.path).entry = e;
      continue;
    }
    const cut = e.path.lastIndexOf("/");
    folder(cut < 0 ? "" : e.path.slice(0, cut)).children.push({
      path: e.path,
      name: e.name,
      folder: false,
      entry: e,
      children: [],
    });
  }
  const sort = (n: DocNode) => {
    n.children.sort(byName);
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** Nœud au chemin donné (`""` : racine). */
export function findNode(root: DocNode, path: string): DocNode | null {
  if (!path) return root;
  for (const child of root.children) {
    if (child.path === path) return child;
    if (child.folder && path.startsWith(`${child.path}/`)) return findNode(child, path);
  }
  return null;
}

/** Nombre de fichiers sous un dossier (sous-dossiers compris). */
export function fileCount(node: DocNode): number {
  return node.folder ? node.children.reduce((n, c) => n + fileCount(c), 0) : 1;
}

/** Chemins de tous les dossiers (pour « Déplacer vers »), racine comprise (`""`). */
export function folderPaths(root: DocNode): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.folder) {
      out.push(n.path);
      n.children.forEach(walk);
    }
  };
  walk(root);
  return out;
}

export const parentOf = (path: string) => {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
};

export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** Nom de fichier ou de dossier accepté (pas de « / », ni de caractère interdit par Windows). */
export function validName(name: string): boolean {
  const n = name.trim();
  return n !== "" && n !== "." && n !== ".." && n.length <= 200 && !/[\\/:*?"<>|]/.test(n);
}

export const KIND_LABEL: Record<DocKind, string> = {
  pdf: "PDF",
  word: "Word",
  powerpoint: "PowerPoint",
  markdown: "Markdown",
  text: "Texte",
  csv: "CSV",
  excel: "Excel",
  image: "Image",
  other: "Fichier",
};

export const KIND_ICON: Record<DocKind, IconName> = {
  pdf: "book",
  word: "file",
  powerpoint: "file",
  markdown: "pen",
  text: "file",
  csv: "layers",
  excel: "layers",
  image: "eye",
  other: "file",
};

/** Comment l'écran affiche un document. */
export type Preview = "pdf" | "table" | "image" | "markdown" | "text" | "none";

export function previewOf(kind: DocKind | null): Preview {
  switch (kind) {
    case "pdf":
      return "pdf";
    case "csv":
    case "excel":
      return "table";
    case "image":
      return "image";
    case "markdown":
      return "markdown";
    case "text":
      return "text";
    default:
      return "none";
  }
}

/** Taille lisible : « 1,5 Mo », « 340 Ko ». */
export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)} Ko`;
  return `${bytes} o`;
}

/** Fichiers glissés au-delà de cette taille : passer par « Déposer » (fichier lu par Cadence). */
export const DROP_MAX = 25 * 1024 * 1024;

/** Octets → base64, par tranches (pas de dépassement de pile sur un gros fichier). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Morceaux lus bout à bout en un seul tableau d'octets. */
export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Lien GitHub d'un document ou d'un dossier. */
export function githubUrl(list: Pick<DocList, "repo" | "branch" | "dir">, path: string, folder: boolean): string {
  const segs = [list.dir, path].filter(Boolean).join("/").split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${list.repo}/${folder ? "tree" : "blob"}/${encodeURIComponent(list.branch)}/${segs}`;
}
