import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { buildZip, collectFiles, sha256 } from "./archive";
import { catalogEntry, latestReleases, parseSha256, type GithubRelease } from "./catalog";
import { listPlugins, parseReleaseTag, readManifest, type Manifest } from "./manifest";
import { compareSemver } from "./semver";
import { checkSkill } from "./skill";
import { validatePlugin } from "./validate";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Plugin minimal valide dans un dossier temporaire ; `edit` modifie les fichiers avant écriture. */
function fixture(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cadence-plugin-"));
  temps.push(root);
  const dir = join(root, "exemple");
  const all: Record<string, string> = {
    "plugin.toml": `api = 1
id = "exemple"
name = "Exemple"
version = "0.1.0"
description = "Plugin d'exemple."
authors = ["Test"]
min_cadence = "0.3.0"

[ui]
entry = "ui/index.html"

[[ui.views]]
id = "accueil"
title = "Accueil"
icon = "sprint"

[[actions]]
id = "resumer"
label = "Résumer"
skill = "resumer"
mode = "chat"
`,
    "README.md": "# Exemple\n",
    "ui/index.html": `<!doctype html><script>const view = "accueil";</script>`,
    "ui/src/main.ts": `export const views = ["accueil"];`,
    "skills/resumer/SKILL.md": "---\nname: resumer\ndescription: Résume le document courant.\n---\n\n# Résumer\n",
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("semver et tags", () => {
  it("compare les versions", () => {
    expect(compareSemver("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
  });

  it("lit les tags de release", () => {
    expect(parseReleaseTag("gestion-projet-v0.1.0")).toEqual({ id: "gestion-projet", version: "0.1.0" });
    expect(parseReleaseTag("documents-v1.2.3-beta.1")).toEqual({ id: "documents", version: "1.2.3-beta.1" });
    expect(parseReleaseTag("catalog")).toBeNull();
  });
});

describe("skills", () => {
  it("exige name (égal au dossier) et description", () => {
    expect(checkSkill("a", "---\nname: a\ndescription: Fait a.\n---\n")).toEqual([]);
    expect(checkSkill("a", "# sans frontmatter")).toHaveLength(1);
    expect(checkSkill("a", "---\nname: b\n---\n")).toEqual([
      "`name` « b » différent du dossier « a »",
      "champ `description` absent",
    ]);
    expect(checkSkill("A_b", "---\nname: A_b\ndescription: x\n---\n")[0]).toContain("invalide");
  });
});

describe("validation", () => {
  it("accepte un plugin minimal", () => {
    const report = validatePlugin(fixture());
    expect(report.errors).toEqual([]);
  });

  it("signale schéma, références et binaires", () => {
    const dir = fixture({
      "plugin.toml": `api = 1
id = "exemple"
name = "Exemple"
version = "0.1"
description = "x"
authors = ["Test"]
min_cadence = "0.3.0"
`,
    });
    expect(validatePlugin(dir).errors[0]).toContain("version : format invalide");

    const broken = fixture({
      "plugin.toml": `api = 1
id = "autre"
name = "Exemple"
version = "0.1.0"
description = "x"
authors = ["Test"]
min_cadence = "0.3.0"

[ui]
entry = "ui/index.html"

[[ui.views]]
id = "absente"
title = "Absente"
icon = "inconnue"

[[actions]]
id = "faire"
label = "Faire"
skill = "inexistant"
mode = "background"
`,
      "bin/linux-x86_64/serveur": "ELF",
    });
    const errors = validatePlugin(broken).errors.join("\n");
    expect(errors).toContain("id « autre » différent du dossier « exemple »");
    expect(errors).toContain("icône « inconnue » absente du kit");
    expect(errors).toContain("vue « absente » déclarée mais introuvable dans ui/src");
    expect(errors).toContain("skill « inexistant » introuvable");
    expect(errors).toContain("bin/linux-x86_64/serveur : pas de binaire commité");
  });

  it("refuse un champ hors API 1", () => {
    const dir = fixture({
      "plugin.toml": `api = 1
id = "exemple"
name = "Exemple"
version = "0.1.0"
description = "x"
authors = ["Test"]
min_cadence = "0.3.0"
permissions = ["reseau"]
`,
    });
    expect(validatePlugin(dir).errors).toEqual(["racine : champ « permissions » inconnu de l'API 1"]);
  });

  it("vérifie le serveur et les outils cités par les skills", () => {
    const manifest = `api = 1
id = "exemple"
name = "Exemple"
version = "0.1.0"
description = "x"
authors = ["Test"]
min_cadence = "0.3.0"

[server]
bin = "cadence-exemple"
`;
    const dir = fixture({
      "plugin.toml": manifest,
      "server/Cargo.toml": `[package]\nname = "cadence-exemple"\nversion = "0.1.0"\n`,
      "server/src/main.rs": `#[tool(description = "Connu.")]\n    async fn connu(&self) {}\n#[tool(name = "renomme", description = "x")]\nfn interne() {}\n`,
      "skills/resumer/SKILL.md":
        "---\nname: resumer\ndescription: Résume.\n---\n\nUtilise `exemple__connu`, `exemple__renomme` et `exemple__absent`.\n",
    });
    const report = validatePlugin(dir);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toContain("skills/resumer cite exemple__absent, absent du serveur");
    expect(report.warnings.join("\n")).not.toContain("exemple__connu");
    expect(report.warnings.join("\n")).not.toContain("exemple__renomme");

    const wrongBin = fixture({
      "plugin.toml": manifest.replace("cadence-exemple", "autre-binaire"),
      "server/Cargo.toml": `[package]\nname = "cadence-exemple"\nversion = "0.1.0"\n`,
    });
    expect(validatePlugin(wrongBin).errors[0]).toContain("server.bin « autre-binaire »");
  });

  it("valide les plugins du dépôt", () => {
    const plugins = listPlugins();
    expect(plugins.length).toBeGreaterThan(0);
    for (const p of plugins) expect(validatePlugin(p.dir, p.id).errors, p.id).toEqual([]);
  });
});

describe("archive", () => {
  it("assemble une archive à plat, reproductible", () => {
    const dir = fixture();
    const manifest = readManifest(join(dir, "plugin.toml"));
    const { files } = collectFiles(dir, manifest);
    const zip = buildZip(files);
    const entries = Object.keys(unzipSync(zip)).sort();
    expect(entries).toEqual([
      "README.md",
      "plugin.toml",
      "skills/resumer/SKILL.md",
      "ui/index.html",
      "ui/src/main.ts",
    ]);
    expect(sha256(buildZip(collectFiles(dir, manifest).files))).toBe(sha256(zip));
  });

  it("exige un binaire par plateforme", () => {
    const dir = fixture();
    const manifest = { ...readManifest(join(dir, "plugin.toml")), server: { bin: "srv" } } as Manifest;
    expect(() => collectFiles(dir, manifest)).toThrow(/binaire srv manquant/);
    const bins = join(dir, "..", "bins");
    for (const t of ["windows-x86_64", "macos-aarch64", "macos-x86_64", "linux-x86_64"]) {
      mkdirSync(join(bins, t), { recursive: true });
      writeFileSync(join(bins, t, t.startsWith("windows") ? "srv.exe" : "srv"), t);
    }
    const { files } = collectFiles(dir, manifest, { binsDir: bins });
    expect(files.get("bin/windows-x86_64/srv.exe")?.executable).toBe(true);
    expect(files.has("bin/linux-x86_64/srv")).toBe(true);
  });
});

describe("catalogue", () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://dl/${name}` });
  const releases: GithubRelease[] = [
    { tag_name: "catalog", draft: false, prerelease: false, assets: [asset("catalog.json")] },
    {
      tag_name: "documents-v0.1.0",
      draft: false,
      prerelease: false,
      assets: [asset("documents-0.1.0.zip"), asset("documents-0.1.0.zip.sha256")],
    },
    {
      tag_name: "documents-v0.2.0",
      draft: false,
      prerelease: false,
      assets: [asset("documents-0.2.0.zip"), asset("documents-0.2.0.zip.sha256")],
    },
    { tag_name: "documents-v0.3.0", draft: true, prerelease: false, assets: [] },
    { tag_name: "retire-v1.0.0", draft: false, prerelease: false, assets: [asset("retire-1.0.0.zip")] },
  ];

  it("garde la dernière release complète de chaque plugin présent", () => {
    const latest = latestReleases(releases, ["documents", "gestion-projet"]);
    expect(latest).toEqual([
      {
        id: "documents",
        version: "0.2.0",
        tag: "documents-v0.2.0",
        zipUrl: "https://dl/documents-0.2.0.zip",
        shaUrl: "https://dl/documents-0.2.0.zip.sha256",
      },
    ]);
  });

  it("produit une entrée au format du contrat", () => {
    const [release] = latestReleases(releases, ["documents"]);
    const manifest = {
      api: 1,
      id: "documents",
      name: "Documents",
      version: "0.2.0",
      description: "Cours.",
      authors: ["Rémi Lhuillier"],
      icon: "icon.svg",
      min_cadence: "0.3.0",
    } satisfies Manifest;
    const hash = "a".repeat(64);
    expect(catalogEntry("RemiSDV/cadence-plugins", release!, manifest, parseSha256(`${hash}  documents-0.2.0.zip\n`))).toEqual({
      id: "documents",
      name: "Documents",
      version: "0.2.0",
      description: "Cours.",
      authors: ["Rémi Lhuillier"],
      icon_url: "https://raw.githubusercontent.com/RemiSDV/cadence-plugins/documents-v0.2.0/plugins/documents/icon.svg",
      url: "https://dl/documents-0.2.0.zip",
      sha256: hash,
      min_cadence: "0.3.0",
    });
    expect(() => catalogEntry("r", release!, { ...manifest, version: "0.1.0" }, hash)).toThrow();
  });
});
