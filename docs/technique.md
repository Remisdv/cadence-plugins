# Plugins Cadence — documentation technique

Pour les auteurs et mainteneurs de plugins : structure d'un plugin, manifeste, services et outils
fournis par Cadence, développement et publication. Présentation : [README](../README.md) ·
utilisation : [guide](utilisation.md) · proposer un plugin : [CONTRIBUTING.md](../CONTRIBUTING.md).

Chaque plugin a sa page de présentation (`README.md`, avec captures et cas d'usage) et documente
ses écrans, ses actions, ses outils MCP et ses données dans son `TECHNIQUE.md` :
[Gestion de projet](../plugins/gestion-projet/TECHNIQUE.md),
[Documents](../plugins/documents/TECHNIQUE.md), [Exemple](../plugins/exemple/TECHNIQUE.md) (point de
départ pour écrire le vôtre).

## Contenu du dépôt

```
plugins/<id>/            un dossier par plugin : plugin.toml, README.md, TECHNIQUE.md, ui/, skills/, server/
packages/sdk/            @cadence/plugin-sdk — SDK postMessage des écrans de plugin
packages/ui/             @cadence/ui — tokens CSS et composants React du kit Cadence
schema/plugin.schema.json  JSON Schema du manifeste plugin.toml (API 1, révision 1.3)
scripts/                 validate.ts, package.ts, catalog.ts, pending.ts
.github/workflows/       ci.yml (pull requests) et release.yml (main)
```

## Anatomie d'un plugin

Archive installée (à plat, sans dossier racine) :

```
plugin.toml          manifeste (obligatoire)
icon.svg             optionnel
ui/                  écrans web : index.html + assets, servis dans un iframe isolé
skills/<skill>/SKILL.md   skills au format « Agent Skills » (frontmatter name/description)
bin/<cible>/<exe>    serveur MCP natif par plateforme (optionnel)
README.md
```

Cibles : `windows-x86_64`, `macos-aarch64`, `macos-x86_64`, `linux-x86_64`.

Il n'y a pas d'espace de travail : Cadence lance **un seul processus serveur par plugin** (MCP sur
stdio), avec l'environnement :

| Variable                                | Contenu                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `CADENCE_API`                           | `1`                                                                                 |
| `CADENCE_DATA_DIR`                      | dossier de données du plugin, `<données de l'app>/plugins-data/<id>/`               |
| `CADENCE_SETTINGS`                      | réglages globaux du plugin (JSON) ; ensuite `notifications/cadence/settings`        |
| `CADENCE_SECRET_<ID_MAJUSCULE>`         | chaque secret déclaré dans `[[secrets]]`                                            |
| `CADENCE_GITHUB_TOKEN`, `CADENCE_REPOS` | service `repos` activé (voir plus bas)                                              |
| `CADENCE_TOOLS`                         | outils externes détectés (JSON : id → chemin absolu de l'exécutable, voir plus bas) |

Les outils sont exposés aux IA préfixés `<plugin>__<outil>`. L'IA tourne toujours dans un dossier
neutre de Cadence, jamais dans un dépôt de l'utilisateur : elle accède aux données par les outils
MCP. Chaque plugin gère son propre contexte (dépôts suivis, matières…).

Le manifeste est décrit par [`schema/plugin.schema.json`](../schema/plugin.schema.json) ; un exemple
complet : [`plugins/gestion-projet/plugin.toml`](../plugins/gestion-projet/plugin.toml).

### Catégories

`category` est obligatoire et prise dans une liste fixe ; elle range le plugin dans le rail de
Cadence, dans cet ordre :

| `category` | Libellé |
| ---------- | ------- |
| `projet`   | Projet  |
| `etudes`   | Études  |
| `code`     | Code    |
| `donnees`  | Données |
| `outils`   | Outils  |

`color` (révision 1.3, facultative) fixe la couleur de la tuile du plugin dans le rail, parmi les
couleurs du kit : `clay`, `blue`, `green`, `purple`, `amber`, `red`. Sans elle, Cadence tire une
couleur stable de l'identifiant.

### Services fournis par Cadence

Un plugin active dans son manifeste les briques que l'app embarque :

```toml
services = ["repos"]
```

**`repos`** — dépôts GitHub :

- Cadence gère la **connexion GitHub** (gh CLI, navigateur, code d'appairage ou jeton personnel,
  rangé au trousseau) : le plugin ne déclare pas de secret pour son jeton.
- Le plugin a une liste de **dépôts suivis** et un **sélecteur** en tête de sa barre : un dépôt, ou
  « Tous les dépôts » pour les vues agrégées.
- Le serveur reçoit `CADENCE_GITHUB_TOKEN` (si GitHub est connecté) et `CADENCE_REPOS` (JSON des
  dépôts suivis), puis `notifications/cadence/repos` à chaque changement de la liste.
- La lecture passe par l'API GitHub ; le **clone** n'a lieu qu'à la demande, quand un skill doit
  toucher au code : l'outil du cœur `cadence__repo_checkout` (ou `cadence.repos.checkout` côté UI)
  prépare un worktree par tâche sous `<données de l'app>/repos/<owner>/<name>/` et l'ouvre à l'IA
  pour cette session seulement.
- Écrans : `cadence.repos.list()`, `selection()`, `onChange()`, `follow()`, `unfollow()`,
  `checkout()` (voir [`packages/sdk`](../packages/sdk)). Le contexte d'une action reçoit la sélection
  courante (`repo` ou `repos`).

`pnpm validate` avertit quand un plugin lit `CADENCE_GITHUB_TOKEN` ou `CADENCE_REPOS`, appelle
`cadence.repos` ou cite `cadence__repo_checkout` sans déclarer `repos`.

### Dépendances externes

Cadence connaît une liste fermée d'**outils externes** (enrichie à chaque version de l'app). Il les
détecte, les installe et les connecte pour l'utilisateur, toujours sur un clic : il affiche la
commande exacte qu'il va lancer et pourquoi, la lance dans un terminal intégré, puis revérifie.
Les identifiants de connexion restent dans le stockage propre de chaque outil.

| `tool`     | Outil                                     | Connexion             |
| ---------- | ----------------------------------------- | --------------------- |
| `git`      | Git                                       | —                     |
| `gh`       | GitHub CLI                                | `gh auth login`       |
| `claude`   | Claude Code                               | `claude auth login`   |
| `codex`    | Codex CLI                                 | `codex login`         |
| `opencode` | OpenCode                                  | `opencode auth login` |
| `node`     | Node.js (prérequis des installations npm) | —                     |

Un plugin déclare les outils dont il a besoin :

```toml
[[requires]]
tool = "git"                # id du registre
min_version = "2.30"        # optionnel, semver souple : 2, 2.30 ou 2.30.1
reason = "Cloner les dépôts et préparer les worktrees"   # obligatoire, en français

[[requires]]
tool = "gh"
optional = true             # le plugin fonctionne sans, en mode dégradé
auth = true                 # l'outil doit aussi être connecté
reason = "Réutiliser votre connexion GitHub existante"
```

- Un **service** déclare lui-même ses outils : `repos` apporte `git` (requis) et `gh` (optionnel,
  connecté). Un plugin qui active `repos` n'a pas à les redéclarer (il peut le faire, par exemple
  pour exiger une version plus récente).
- Les IA de code (`claude`, `codex`, `opencode`) sont gérées par l'étape « IA de code » de
  l'onboarding ; un plugin ne les déclare que s'il lance lui-même une CLI précise.
- Un outil requis manquant met le plugin « à configurer » : bandeau dans sa barre avec « Installer ».
  Les outils apparaissent aussi dans l'étape « Outils nécessaires » de l'onboarding, dans
  **Réglages › Outils** et dans la section « Dépendances » du catalogue (champ `requires` de
  `catalog.json`, services compris).
- Le **serveur** ne lance jamais un outil par son nom : il lit son chemin dans `CADENCE_TOOLS`
  (`{ "git": "/usr/bin/git", "gh": "/opt/homebrew/bin/gh" }`), qui tient compte des chemins
  personnalisés des réglages.
- Les **écrans** consultent l'état d'un outil avec `cadence.tools.status(id)`
  (`{ installed, version, authenticated }`) et ouvrent la boîte d'installation de Cadence avec
  `cadence.tools.ensure(id)`.

`pnpm validate` refuse un outil déclaré deux fois ou `auth = true` sur un outil sans connexion
(`git`, `node`), et avertit quand un serveur lit dans `CADENCE_TOOLS` un outil que ni le plugin ni
ses services ne déclarent, ou lance un outil du registre par son nom.

## Développer

Prérequis : Node ≥ 20, pnpm 10, Rust stable.

```sh
pnpm install
pnpm validate                 # manifestes, catégories, services, dépendances, skills, vues, réglages
pnpm typecheck && pnpm test   # SDK, kit UI, scripts, écrans
pnpm build                    # build des UI de plugins (plugins/*/ui/dist)
cargo test --workspace        # serveurs MCP Rust
pnpm --dir plugins/gestion-projet/ui dev   # écran hors de Cadence, avec un hôte simulé
pnpm package documents --allow-missing-targets   # archive locale dans out/
```

## Publication

Sur une pull request, la CI (`ci.yml`) valide les manifestes (version incrémentée comprise),
vérifie les types et lance les tests, construit les UI, assemble l'archive de chaque plugin (sans
binaires) et teste puis construit les serveurs sur les quatre cibles (`macos-x86_64` en
compilation croisée, sans tests).

Sur `main`, la release (`release.yml`) refait ces vérifications puis publie chaque plugin dont la
version du manifeste n'a pas encore de tag `<id>-v<version>` : tests et build des serveurs sur les
quatre plateformes (Linux sur Ubuntu 22.04, pour la glibc), assemblage de `<id>-<version>.zip` +
`.sha256` avec un binaire par cible, release GitHub. `catalog.json` est ensuite régénéré à chaque
push sur `main` et téléversé sur la release fixe `catalog` ; `workflow_dispatch` relance le tout à
la main. Pour proposer un plugin, voir [CONTRIBUTING.md](../CONTRIBUTING.md).

Chaque entrée de `catalog.json` décrit le plugin sans qu'il faille télécharger son archive :
`category`, `color`, `icon` (icône du kit de la tuile), `services`, `requires`, `views`,
`actions`, `tools` (outils MCP exposés aux IA, lus dans les sources du serveur au tag ; les outils
`meta = ui_only()` en sont exclus), `targets`, `size`, et `official`. Ce dernier marque les
plugins publiés par le mainteneur (liste `OFFICIAL_PLUGINS` de
[`scripts/lib/catalog.ts`](../scripts/lib/catalog.ts)) : badge « Officiel » dans Cadence et
présélection à l'onboarding. Il n'est posé que pour le catalogue de ce dépôt, pas pour un fork.
