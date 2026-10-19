import { describe, expect, it } from "vitest";
import type { ArchiService, Architecture } from "./domain";
import {
  BOX_H,
  BOX_W,
  archiId,
  entryLayers,
  layoutSystem,
  linkPath,
  lines,
  removeLayer,
  removeService,
} from "./archi";

const service = (id: string, kind: string): ArchiService => ({
  id,
  name: id,
  kind,
  tech: "",
  path: "",
  description: "",
  layers: [],
  rules: [],
  conventions: [],
});

const arch: Architecture = {
  version: 1,
  services: [
    service("db", "database"),
    service("api", "backend"),
    service("nginx", "proxy"),
    service("worker", "worker"),
    service("web", "frontend"),
  ],
  links: [
    { from: "nginx", to: "api", label: "proxy" },
    { from: "api", to: "db", label: "SQL" },
  ],
  rules: [],
};

describe("architecture", () => {
  it("range les services en colonnes, de l'entrée vers les données", () => {
    const { boxes, width, height } = layoutSystem(arch);
    const x = (id: string) => boxes.find((b) => b.service.id === id)!.x;
    expect([x("nginx"), x("web"), x("api"), x("db")]).toEqual([0, 306, 612, 918]);
    // Back-end et tâches de fond partagent une colonne.
    expect(x("worker")).toBe(x("api"));
    expect(width).toBe(4 * BOX_W + 3 * 96);
    expect(height).toBe(2 * BOX_H + 28);
    expect(layoutSystem({ services: [] }).width).toBe(0);
  });

  it("trace les liens d'un bord à l'autre", () => {
    const { boxes } = layoutSystem(arch);
    const at = (id: string) => boxes.find((b) => b.service.id === id)!;
    // Colonnes voisines : du bord droit au bord gauche.
    expect(linkPath(at("nginx"), at("web")).d.startsWith(`M${BOX_W},`)).toBe(true);
    expect(linkPath(at("nginx"), at("web")).below).toBe(false);
    // Une colonne sautée : arc par-dessous, du bas de l'une au bas de l'autre.
    const skip = linkPath(at("nginx"), at("api"));
    expect(skip.below).toBe(true);
    expect(skip.d.startsWith(`M${BOX_W / 2},`)).toBe(true);
    expect(linkPath(at("api"), at("worker")).d).toContain("C");
  });

  it("modifie sans laisser de référence orpheline", () => {
    const a = removeService(arch, "api");
    expect(a.services.map((s) => s.id)).not.toContain("api");
    expect(a.links).toEqual([]);
    const s = {
      ...service("api", "backend"),
      layers: [
        { id: "controller", name: "Controller", path: "", role: "", uses: ["service"] },
        { id: "service", name: "Service", path: "", role: "", uses: [] },
      ],
    };
    expect(entryLayers(s.layers)).toEqual(["controller"]);
    expect(removeLayer(s, "service").layers).toEqual([
      { id: "controller", name: "Controller", path: "", role: "", uses: [] },
    ]);
  });

  it("fabrique identifiants et listes", () => {
    expect(archiId("Base de données", [], "service")).toBe("base-de-donnees");
    expect(archiId("API", ["api"], "service")).toBe("api-2");
    expect(lines(" a \n\n b ")).toEqual(["a", "b"]);
  });
});
