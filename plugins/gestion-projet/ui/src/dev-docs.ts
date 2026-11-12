/**
 * Documents du projet simulés pour `pnpm dev` (hors de Cadence) : un petit PDF généré, un CSV,
 * un Markdown et un dossier vide, rangés en mémoire comme dans `docs/intern` du dépôt.
 */
import type { DocEntry, DocKind, DocTable } from "./docs";
import { toBase64 } from "./docs";

const enc = new TextEncoder();

/** PDF minimal valide : une page de texte par élément de `pages`. */
function makePdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((lines, i) => {
    const id = pageIds[i]!;
    const text = lines
      .map((l, j) => `BT /F1 ${j === 0 ? 20 : 12} Tf 60 ${760 - j * 26} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`)
      .join("\n");
    objects[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Latin-1 (WinAnsi) : un caractère = un octet.
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}

const files = new Map<string, Uint8Array>([
  [
    "Sujet et cahier des charges/Sujet du projet.pdf",
    makePdf([
      ["Sujet : CRM pour les alternants", "Contexte : suivre les candidatures et les entreprises.", "Public : etudiants en alternance et tuteurs."],
      ["Livrables attendus", "1. Une API REST documentee (OpenAPI).", "2. Un tableau de bord des candidatures.", "3. Un compte-rendu de cloture."],
    ]),
  ],
  [
    "Données/données attendues.csv",
    enc.encode("champ;type;obligatoire\nnom;texte;oui\nemail;texte;oui\nentreprise;texte;non\ndate_candidature;date;oui\n"),
  ],
  [
    "Missions/fiche de mission.md",
    enc.encode("# Fiche de mission\n\n- **Rôle** : développeur back-end\n- **Durée** : 6 semaines\n\nLivrer un POC de l'API des candidatures."),
  ],
  ["Missions/.gitkeep", new Uint8Array()],
  ["Comptes-rendus/.gitkeep", new Uint8Array()],
]);

function kindOf(path: string): DocKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "csv") return "csv";
  if (["xlsx", "xls", "ods"].includes(ext)) return "excel";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["txt", "json"].includes(ext)) return "text";
  if (ext === "docx") return "word";
  if (ext === "pptx") return "powerpoint";
  return "other";
}

function entries(): DocEntry[] {
  const out = new Map<string, DocEntry>();
  for (const [path, bytes] of files) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      out.set(p, { path: p, name: parts[i - 1]!, folder: true, size: 0, sha: "d".repeat(40), kind: null });
    }
    if (parts.at(-1) === ".gitkeep") continue;
    out.set(path, {
      path,
      name: parts.at(-1)!,
      folder: false,
      size: bytes.length,
      sha: `${bytes.length.toString(16).padStart(8, "0")}${"a".repeat(32)}`,
      kind: kindOf(path),
    });
  }
  return [...out.values()];
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function table(path: string): DocTable {
  const text = new TextDecoder().decode(files.get(path));
  const [head = "", ...rows] = text.trim().split("\n");
  return { sheets: [], sheet: null, columns: head.split(";"), rows: rows.map((r) => r.split(";")), total: rows.length };
}

type Args = Record<string, unknown>;

export const docsTools = {
  docs_list: ({ repo }: Args) => {
    const list = entries();
    return {
      repo,
      branch: "main",
      dir: "docs/intern",
      url: `https://github.com/${String(repo)}/tree/main/docs/intern`,
      files: list.filter((e) => !e.folder).length,
      entries: list,
      outline: "",
      templates: ["Sujet et cahier des charges", "Missions", "Données", "Comptes-rendus", "Divers"],
    };
  },
  docs_mkdir: ({ repo, paths }: Args) => {
    for (const p of paths as string[]) files.set(`${p}/.gitkeep`, new Uint8Array());
    return { repo, created: paths };
  },
  docs_upload: ({ repo, folder, files: uploads }: Args) => {
    const added: string[] = [];
    for (const f of uploads as { path?: string; name?: string; content_base64?: string }[]) {
      const name = f.name ?? f.path?.split(/[\\/]/).pop() ?? "fichier";
      const path = folder ? `${String(folder)}/${name}` : name;
      files.set(path, f.content_base64 ? fromB64(f.content_base64) : enc.encode(`(fichier local ${f.path})`));
      added.push(path);
    }
    return { repo, added };
  },
  docs_move: ({ repo, from, to }: Args) => {
    for (const [p, b] of [...files]) {
      if (p === from || p.startsWith(`${String(from)}/`)) {
        files.delete(p);
        files.set(`${String(to)}${p.slice(String(from).length)}`, b);
      }
    }
    return { repo, from, to };
  },
  docs_delete: ({ repo, path }: Args) => {
    for (const p of [...files.keys()]) if (p === path || p.startsWith(`${String(path)}/`)) files.delete(p);
    return { repo, deleted: path };
  },
  docs_bytes: ({ path }: Args) => {
    const bytes = files.get(String(path));
    if (!bytes) throw new Error(`Document introuvable : « ${String(path)} ».`);
    const kind = kindOf(String(path));
    const mime = kind === "pdf" ? "application/pdf" : kind === "image" ? "image/png" : "text/plain";
    return { path, mime, size: bytes.length, offset: 0, next: null, data: toBase64(bytes) };
  },
  docs_table: ({ path }: Args) => table(String(path)),
  docs_read: ({ path }: Args) => ({ path, pages: 1, text: new TextDecoder().decode(files.get(String(path))) }),
  docs_search: ({ query }: Args) => ({ query, hits: [], unreadable: [] }),
};
