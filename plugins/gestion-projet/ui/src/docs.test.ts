import { describe, expect, it } from "vitest";
import {
  buildTree,
  concatChunks,
  fileCount,
  findNode,
  folderPaths,
  fromBase64,
  githubUrl,
  humanSize,
  joinPath,
  parentOf,
  previewOf,
  toBase64,
  validName,
  type DocEntry,
} from "./docs";

const file = (path: string, size = 10): DocEntry => ({
  path,
  name: path.split("/").pop()!,
  folder: false,
  size,
  sha: "a".repeat(40),
  kind: null,
});
const dir = (path: string): DocEntry => ({ ...file(path, 0), folder: true });

describe("arbre des documents", () => {
  const entries = [
    dir("Missions"),
    file("Missions/fiche-2.pdf"),
    file("Missions/fiche-10.pdf"),
    dir("Données"),
    file("sujet.pdf"),
    // Dossier implicite (sans entrée de dossier).
    file("Missions/Livrables/grille.md"),
  ];

  it("range dossiers puis fichiers, en ordre naturel", () => {
    const root = buildTree(entries);
    expect(root.children.map((c) => c.name)).toEqual(["Données", "Missions", "sujet.pdf"]);
    const missions = findNode(root, "Missions")!;
    expect(missions.children.map((c) => c.name)).toEqual(["Livrables", "fiche-2.pdf", "fiche-10.pdf"]);
    expect(fileCount(missions)).toBe(3);
    expect(findNode(root, "Missions/Livrables/grille.md")?.folder).toBe(false);
    expect(findNode(root, "absent")).toBeNull();
  });

  it("liste les dossiers pour « Déplacer vers »", () => {
    expect(folderPaths(buildTree(entries))).toEqual(["", "Données", "Missions", "Missions/Livrables"]);
  });

  it("manipule les chemins", () => {
    expect(parentOf("a/b/c.pdf")).toBe("a/b");
    expect(parentOf("c.pdf")).toBe("");
    expect(joinPath("", "x")).toBe("x");
    expect(joinPath("a", "x")).toBe("a/x");
    expect(validName("Compte-rendu 1.pdf")).toBe(true);
    for (const bad of ["", " ", "..", "a/b", "a:b", "x?"]) expect(validName(bad)).toBe(false);
  });
});

describe("formats", () => {
  it("choisit l'aperçu", () => {
    expect(previewOf("pdf")).toBe("pdf");
    expect(previewOf("excel")).toBe("table");
    expect(previewOf("csv")).toBe("table");
    expect(previewOf("word")).toBe("none");
    expect(previewOf(null)).toBe("none");
  });

  it("écrit les tailles en français", () => {
    expect(humanSize(1_572_864)).toBe("1,5 Mo");
    expect(humanSize(2048)).toBe("2 Ko");
    expect(humanSize(12)).toBe("12 o");
  });

  it("encode et recolle les octets", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(concatChunks([new Uint8Array([1, 2]), new Uint8Array([3])])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("construit les liens GitHub", () => {
    const list = { repo: "me/app", branch: "main", dir: "docs/intern" };
    expect(githubUrl(list, "Données/attendus.csv", false)).toBe(
      "https://github.com/me/app/blob/main/docs/intern/Donn%C3%A9es/attendus.csv",
    );
    expect(githubUrl(list, "", true)).toBe("https://github.com/me/app/tree/main/docs/intern");
  });
});
