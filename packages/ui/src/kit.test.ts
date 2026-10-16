import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cn } from "./lib/cn";
import { iconNames } from "./icons/Icon";
import { ICON_NAMES } from "./icons/names";
import { initialsOf } from "./components/Avatar";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Variables `--nom: valeur;` d'un bloc CSS, commentaires retirés. */
function vars(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

describe("tokens", () => {
  it("theme.css et tokens.css exposent les mêmes variables, aux mêmes valeurs", () => {
    const theme = vars(read("./styles/theme.css"));
    const tokens = vars(read("./styles/tokens.css"));
    expect(Object.keys(theme).length).toBeGreaterThan(50);
    expect(tokens).toEqual(theme);
  });

  it("reprend les valeurs des maquettes", () => {
    const theme = vars(read("./styles/theme.css"));
    expect(theme["--color-clay"]).toBe("#d97757");
    expect(theme["--text-body"]).toBe("13px");
    expect(theme["--radius-card"]).toBe("12px");
  });
});

describe("icônes", () => {
  it("la liste sans React suit le jeu d'icônes", () => {
    expect([...ICON_NAMES]).toEqual(iconNames);
  });
});

describe("cn", () => {
  it("garde une taille de texte du thème et une couleur ensemble", () => {
    expect(cn("text-caption", "text-tx3")).toBe("text-caption text-tx3");
    expect(cn("text-caption", "text-body")).toBe("text-body");
    expect(cn("rounded-card", "rounded-modal")).toBe("rounded-modal");
  });
});

describe("initialsOf", () => {
  it("tire deux initiales d'un nom ou d'un login", () => {
    expect(initialsOf("Rémi Lhuillier")).toBe("RL");
    expect(initialsOf("cadence-app")).toBe("CA");
    expect(initialsOf("octocat")).toBe("OC");
  });
});
