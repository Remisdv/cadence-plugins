import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { buildZip, collectFiles, sha256 } from "./archive";
import {
  catalogEntry,
  isOfficial,
  latestReleases,
  OFFICIAL_PLUGINS,
  parseSha256,
  type GithubRelease,
} from "./catalog";
import { effectiveRequires, listPlugins, parseReleaseTag, readManifest, type Manifest } from "./manifest";
import { compareLooseVersion, compareSemver } from "./semver";
import { checkSkill } from "./skill";
import { exposedTools, scanTools } from "./tools";
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
category = "outils"
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

  it("compare les versions souples des outils", () => {
    expect(compareLooseVersion("2.30", "2.30.0")).toBe(0);
    expect(compareLooseVersion("2.31", "2.30.9")).toBeGreaterThan(0);
    expect(compareLooseVersion("2", "10")).toBeLessThan(0);
    expect(() => compareLooseVersion("v2", "2")).toThrow();
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
category = "outils"
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
category = "outils"
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
category = "outils"
min_cadence = "0.3.0"
permissions = ["reseau"]
`,
    });
    expect(validatePlugin(dir).errors).toEqual(["racine : champ « permissions » inconnu de l'API 1"]);
  });

  it("exige une catégorie de la liste fixe et des services connus", () => {
    const base = `api = 1
id = "exemple"
name = "Exemple"
version = "0.1.0"
description = "x"
authors = ["Test"]
min_cadence = "0.3.0"
`;
    expect(validatePlugin(fixture({ "plugin.toml": base })).errors).toEqual([
      "racine : champ obligatoire « category » absent",
    ]);
    const unknown = validatePlugin(fixture({ "plugin.toml": `${base}category = "jeux"\n` }));
    expect(unknown.errors[0]).toContain("category : valeur parmi");
    const services = (list: string) => `${base}category = "projet"\nservices = ${list}\n`;
    expect(validatePlugin(fixture({ "plugin.toml": services(`["repos"]`) })).errors).toEqual([]);
    expect(validatePlugin(fixture({ "plugin.toml": services(`["calendrier"]`) })).errors).toEqual([
      'services.0 : valeur parmi "repos"',
    ]);
    expect(validatePlugin(fixture({ "plugin.toml": services(`["repos", "repos"]`) })).errors).toEqual([
      "services : valeur en double",
    ]);
    // Couleur de la tuile (révision 1.3) : facultative, prise dans les couleurs du kit.
    const color = (c: string) => `${base}category = "outils"\ncolor = "${c}"\n`;
    expect(validatePlugin(fixture({ "plugin.toml": color("purple") })).errors).toEqual([]);
    expect(validatePlugin(fixture({ "plugin.toml": color("rose") })).errors[0]).toContain("color : valeur parmi");
  });

  it("signale l'usage du service repos sans le déclarer", () => {
    const manifest = `api = 1
id = "exemple"
name = "Exemple"
version = "0.1.0"
description = "x"
authors = ["Test"]
category = "code"
min_cadence = "0.3.0"

[server]
bin = "cadence-exemple"

[ui]
entry = "ui/index.html"

[[ui.views]]
id = "accueil"
title = "Accueil"
`;
    const files = {
      "server/Cargo.toml": `[package]\nname = "cadence-exemple"\nversion = "0.1.0"\n`,
      "server/src/main.rs": `fn main() {\n    let token = std::env::var("CADENCE_GITHUB_TOKEN");\n    let ws = std::env::var("CADENCE_WORKSPACE");\n}\n`,
      "ui/src/main.ts": `export const views = ["accueil"];\nawait cadence.repos.selection();\n`,
      "skills/resumer/SKILL.md":
        "---\nname: resumer\ndescription: Résume.\n---\n\nAppelle `cadence__repo_checkout` avant d'écrire.\n",
    };
    const warnings = validatePlugin(fixture({ "plugin.toml": manifest, ...files })).warnings.join("\n");
    expect(warnings).toContain('server/src/main.rs lit CADENCE_GITHUB_TOKEN sans déclarer services = ["repos"]');
    expect(warnings).toContain("ui/src/main.ts utilise cadence.repos sans déclarer");
    expect(warnings).toContain("skills/resumer/SKILL.md cite cadence__repo_checkout sans déclarer");
    expect(warnings).toContain("server/src/main.rs lit CADENCE_WORKSPACE, supprimée");

    const declared = manifest.replace('min_cadence = "0.3.0"', 'services = ["repos"]\nmin_cadence = "0.3.0"');
    const report = validatePlugin(fixture({ "plugin.toml": declared, ...files }));
    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).not.toContain("sans déclarer");
  });

  it("valide les dépendances externes [[requires]]", () => {
    const base = `api = 1
id = "exemple"
name = "Exemple"
version = "0.1.0"
description = "x"
authors = ["Test"]
category = "code"
min_cadence = "0.3.0"
`;
    const requires = (body: string) => validatePlugin(fixture({ "plugin.toml": `${base}\n${body}` })).errors;
    expect(
      requires(`[[requires]]
tool = "git"
min_version = "2.30"
reason = "Cloner les dépôts"

[[requires]]
tool = "gh"
optional = true
auth = true
reason = "Réutiliser votre connexion GitHub"

[[requires]]
tool = "node"
min_version = "20"
reason = "Lancer les scripts du projet"
`),
    ).toEqual([]);
    expect(requires(`[[requires]]\ntool = "docker"\nreason = "x"\n`)[0]).toContain("requires.0.tool : valeur parmi");
    expect(requires(`[[requires]]\ntool = "git"\nmin_version = "v2.30"\nreason = "x"\n`)[0]).toContain(
      "requires.0.min_version : format invalide",
    );
    expect(requires(`[[requires]]\ntool = "git"\n`)).toEqual(["requires.0 : champ obligatoire « reason » absent"]);
    expect(requires(`[[requires]]\ntool = "git"\nreason = "x"\nurl = "https://git-scm.com"\n`)).toEqual([
      "requires.0 : champ « url » inconnu de l'API 1",
    ]);
    expect(
      requires(`[[requires]]
tool = "git"
auth = true
reason = "Cloner"

[[requires]]
tool = "git"
reason = "  "
`),
    ).toEqual([
      "requires : « git » n'a pas de connexion, retirer auth = true",
      "requires : outil « git » déclaré deux fois",
      "requires : raison vide pour « git »",
    ]);
  });

  it("signale les outils de CADENCE_TOOLS non déclarés", () => {
    const manifest = `api = 1
id = "exemple"
name = "Exemple"
version = "0.1.0"
description = "x"
authors = ["Test"]
category = "code"
min_cadence = "0.3.0"

[server]
bin = "cadence-exemple"
`;
    const cargo = `[package]\nname = "cadence-exemple"\nversion = "0.1.0"\n`;
    const main = `fn main() {
    let tools: HashMap<String, PathBuf> = serde_json::from_str(&std::env::var("CADENCE_TOOLS").unwrap()).unwrap();
    let git = tools.get("git").cloned();
    let gh = tools.get("gh").cloned();
    let status = Command::new("codex").status();
}
`;
    const warnings = (toml: string) =>
      validatePlugin(fixture({ "plugin.toml": toml, "server/Cargo.toml": cargo, "server/src/main.rs": main }))
        .warnings;

    const bare = warnings(manifest).join("\n");
    expect(bare).toContain("server/src/main.rs lit CADENCE_TOOLS pour « git » sans le déclarer dans [[requires]]");
    expect(bare).toContain("server/src/main.rs lit CADENCE_TOOLS pour « gh » sans le déclarer");
    expect(bare).toContain("server/src/main.rs lance « codex » par son nom : prendre son chemin dans CADENCE_TOOLS");
    expect(bare).toContain("server/src/main.rs lance « codex » sans le déclarer");
    expect(bare).not.toContain("CADENCE_TOOLS pour « codex »");

    // git et gh viennent du service repos ; codex est déclaré.
    const withRepos = manifest.replace('min_cadence = "0.3.0"', 'services = ["repos"]\nmin_cadence = "0.3.0"');
    const declared = warnings(`${withRepos}\n[[requires]]\ntool = "codex"\nreason = "Relire le code"\n`);
    expect(declared.join("\n")).not.toContain("sans le déclarer");
    expect(declared.join("\n")).toContain("lance « codex » par son nom");

    // Redéclarer un outil du service passe sans erreur ni avertissement.
    const redeclared = validatePlugin(
      fixture({
        "plugin.toml": `${withRepos}\n[[requires]]\ntool = "git"\nreason = "Cloner les dépôts et préparer les worktrees"\n`,
        "server/Cargo.toml": cargo,
        "server/src/main.rs": `fn main() {\n    let tools = std::env::var("CADENCE_TOOLS");\n    let git = "git";\n}\n`,
      }),
    );
    expect(redeclared.errors).toEqual([]);
    expect(redeclared.warnings.join("\n")).not.toContain("requires");
  });

  it("fusionne les dépendances du plugin et de ses services", () => {
    expect(effectiveRequires({})).toEqual([]);
    expect(
      effectiveRequires({
        services: ["repos"],
        requires: [
          { tool: "node", reason: "Scripts" },
          { tool: "git", min_version: "2.40", reason: "Worktrees" },
          { tool: "gh", reason: "Créer les PR" },
        ],
      }),
    ).toEqual([
      { tool: "git", min_version: "2.40", optional: false, auth: false, reason: "Worktrees", service: "repos" },
      { tool: "gh", min_version: null, optional: false, auth: true, reason: "Créer les PR", service: "repos" },
      { tool: "node", min_version: null, optional: false, auth: false, reason: "Scripts", service: null },
    ]);
  });

  it("vérifie le serveur et les outils cités par les skills", () => {
    const manifest = `api = 1
id = "exemple"
name = "Exemple"
version = "0.1.0"
description = "x"
authors = ["Test"]
category = "outils"
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
      assets: [{ ...asset("documents-0.2.0.zip"), size: 4096 }, asset("documents-0.2.0.zip.sha256")],
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
        zipSize: 4096,
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
      category: "etudes",
      color: "green",
      min_cadence: "0.3.0",
      server: { bin: "cadence-documents" },
      ui: {
        entry: "ui/index.html",
        views: [
          { id: "bibliotheque", title: "Bibliothèque", icon: "book", section: "Cours" },
          { id: "entrainement", title: "Entraînement" },
        ],
      },
      actions: [{ id: "generer-qcm", label: "Générer un QCM", skill: "generer-qcm", mode: "background", context: "chapitre" }],
    } satisfies Manifest;
    const hash = "a".repeat(64);
    const tools = ["list_documents", "read_pages"];
    expect(
      catalogEntry("RemiSDV/cadence-plugins", release!, manifest, parseSha256(`${hash}  documents-0.2.0.zip\n`), tools),
    ).toEqual({
      id: "documents",
      name: "Documents",
      version: "0.2.0",
      description: "Cours.",
      authors: ["Rémi Lhuillier"],
      official: true,
      category: "etudes",
      color: "green",
      icon: "book",
      services: [],
      requires: [],
      views: [
        { id: "bibliotheque", title: "Bibliothèque", icon: "book" },
        { id: "entrainement", title: "Entraînement", icon: "layers" },
      ],
      actions: [{ id: "generer-qcm", label: "Générer un QCM", mode: "background" }],
      tools,
      targets: ["windows-x86_64", "macos-aarch64", "macos-x86_64", "linux-x86_64"],
      icon_url: "https://raw.githubusercontent.com/RemiSDV/cadence-plugins/documents-v0.2.0/plugins/documents/icon.svg",
      url: "https://dl/documents-0.2.0.zip",
      size: 4096,
      sha256: hash,
      min_cadence: "0.3.0",
    });
    expect(() => catalogEntry("r", release!, { ...manifest, version: "0.1.0" }, hash)).toThrow();

    // Sans serveur ni vue : pas d'outils, pas de cible, couleur et icône laissées à Cadence.
    const { server: _server, ui: _ui, color: _color, ...bare } = manifest;
    const entry = catalogEntry("RemiSDV/cadence-plugins", release!, bare, hash, tools);
    expect([entry.tools, entry.targets, entry.color, entry.icon, entry.views]).toEqual([[], null, null, null, []]);
  });

  it("marque officiels les plugins du mainteneur, sur le dépôt officiel seulement", () => {
    expect(OFFICIAL_PLUGINS).toEqual(expect.arrayContaining(["documents", "gestion-projet", "exemple"]));
    expect(isOfficial("RemiSDV/cadence-plugins", "gestion-projet")).toBe(true);
    // GITHUB_REPOSITORY peut changer de casse.
    expect(isOfficial("remisdv/Cadence-Plugins", "documents")).toBe(true);
    expect(isOfficial("RemiSDV/cadence-plugins", "plugin-communaute")).toBe(false);
    expect(isOfficial("quelquun/cadence-plugins", "documents")).toBe(false);

    const [release] = latestReleases(releases, ["documents"]);
    const manifest = {
      api: 1,
      id: "documents",
      name: "Documents",
      version: "0.2.0",
      description: "Cours.",
      authors: ["Test"],
      category: "etudes",
      min_cadence: "0.3.0",
    } satisfies Manifest;
    expect(catalogEntry("quelquun/fork", release!, manifest, "a".repeat(64)).official).toBe(false);
    // Les plugins officiels existent bien dans le dépôt.
    const ids = listPlugins().map((p) => p.id);
    for (const id of OFFICIAL_PLUGINS) expect(ids, id).toContain(id);
  });

  it("lit les outils MCP d'un serveur rmcp, hors outils réservés à l'interface", () => {
    const sources = [
      `#[tool(description = "Incrémente.")]\n    async fn incrementer(&self) {}\n` +
        `#[tool(description = "État pour l'écran.", meta = ui_only())]\n    async fn etat(&self) {}\n`,
      `#[tool(name = "lire", description = "x")]\npub fn read_impl() {}\n`,
    ];
    expect(scanTools(sources)).toEqual([
      { name: "incrementer", ui: false },
      { name: "etat", ui: true },
      { name: "lire", ui: false },
    ]);
    expect(exposedTools(sources)).toEqual(["incrementer", "lire"]);
  });

  it("liste les dépendances externes, services compris", () => {
    const [release] = latestReleases(releases, ["documents"]);
    const manifest = {
      api: 1,
      id: "documents",
      name: "Documents",
      version: "0.2.0",
      description: "Cours.",
      authors: ["Test"],
      category: "etudes",
      services: ["repos"],
      requires: [{ tool: "node", min_version: "20", optional: true, reason: "Convertir les diapositives" }],
      min_cadence: "0.3.0",
    } satisfies Manifest;
    expect(catalogEntry("r", release!, manifest, "a".repeat(64)).requires).toEqual([
      {
        tool: "git",
        min_version: null,
        optional: false,
        auth: false,
        reason: "Cloner les dépôts et préparer les worktrees",
        service: "repos",
      },
      {
        tool: "gh",
        min_version: null,
        optional: true,
        auth: true,
        reason: "Réutiliser votre connexion GitHub existante",
        service: "repos",
      },
      { tool: "node", min_version: "20", optional: true, auth: false, reason: "Convertir les diapositives", service: null },
    ]);
  });
});
