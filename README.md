# Plugins Cadence

Dépôt public des plugins de [Cadence](https://github.com/RemiSDV), l'hôte de bureau qui relie les IA
de code (Claude Code, Codex CLI, OpenCode) à des **plugins** : écrans, skills et outils MCP. On y
trouve les deux plugins officiels, le SDK des écrans de plugin, le kit UI de Cadence et l'outillage
qui publie chaque plugin et le catalogue lu par l'app.

Les plugins officiels vivent ici comme n'importe quel plugin tiers et utilisent la même API ;
ils ne sont pas livrés dans l'app.

## Installer un plugin depuis Cadence

1. Dans Cadence, ouvrez **Réglages › Plugins** (ou l'étape « Plugins » de l'onboarding) : la liste
   vient du catalogue
   [`catalog.json`](https://github.com/RemiSDV/cadence-plugins/releases/download/catalog/catalog.json).
2. Choisissez un plugin et cliquez sur **Installer** : Cadence télécharge l'archive de sa dernière
   release, vérifie son empreinte sha256 et l'extrait dans `<données de l'app>/plugins/<id>/<version>/`.
3. Le plugin est **activé globalement** dès l'installation (on peut le désactiver sans le
   désinstaller) et prend place dans le rail de Cadence, dans le groupe de sa catégorie. Suivez ses
   étapes de configuration : pour Gestion de projet, la connexion GitHub du service `repos` puis le
   choix des dépôts suivis.

Chaque plugin a sa propre release GitHub (tag `<id>-v<version>`) : le lien de l'archive peut aussi
être partagé tel quel.

## Plugins

| Plugin | Dossier | Ce qu'il apporte |
| --- | --- | --- |
| **Gestion de projet** | [`plugins/gestion-projet`](plugins/gestion-projet) | issues GitHub, kanban, roadmap, sprints, versions, pull requests ; skills « Compléter l'issue », « Implémenter », « Proposer des issues », « Préparer la release » |
| **Documents** | [`plugins/documents`](plugins/documents) | cours PDF, Word, PowerPoint et Markdown rangés par matière et chapitre ; réponses citées (document + page), QCM, questions ouvertes corrigées, flashcards |

## Contenu du dépôt

```
plugins/<id>/            un dossier par plugin : plugin.toml, README.md, ui/, skills/, server/
packages/sdk/            @cadence/plugin-sdk — SDK postMessage des écrans de plugin
packages/ui/             @cadence/ui — tokens CSS et composants React du kit Cadence
schema/plugin.schema.json  JSON Schema du manifeste plugin.toml (API 1)
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

| Variable | Contenu |
| --- | --- |
| `CADENCE_API` | `1` |
| `CADENCE_DATA_DIR` | dossier de données du plugin, `<données de l'app>/plugins-data/<id>/` |
| `CADENCE_SETTINGS` | réglages globaux du plugin (JSON) ; ensuite `notifications/cadence/settings` |
| `CADENCE_SECRET_<ID_MAJUSCULE>` | chaque secret déclaré dans `[[secrets]]` |
| `CADENCE_GITHUB_TOKEN`, `CADENCE_REPOS` | service `repos` activé (voir plus bas) |

Les outils sont exposés aux IA préfixés `<plugin>__<outil>`. L'IA tourne toujours dans un dossier
neutre de Cadence, jamais dans un dépôt de l'utilisateur : elle accède aux données par les outils
MCP. Chaque plugin gère son propre contexte (dépôts suivis, matières…).

Le manifeste est décrit par [`schema/plugin.schema.json`](schema/plugin.schema.json) ; un exemple
complet : [`plugins/gestion-projet/plugin.toml`](plugins/gestion-projet/plugin.toml).

### Catégories

`category` est obligatoire et prise dans une liste fixe ; elle range le plugin dans le rail de
Cadence, dans cet ordre :

| `category` | Libellé |
| --- | --- |
| `projet` | Projet |
| `etudes` | Études |
| `code` | Code |
| `donnees` | Données |
| `outils` | Outils |

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
  `checkout()` (voir [`packages/sdk`](packages/sdk)). Le contexte d'une action reçoit la sélection
  courante (`repo` ou `repos`).

`pnpm validate` avertit quand un plugin lit `CADENCE_GITHUB_TOKEN` ou `CADENCE_REPOS`, appelle
`cadence.repos` ou cite `cadence__repo_checkout` sans déclarer `repos`.

## Développer

Prérequis : Node ≥ 20, pnpm 10, Rust stable.

```sh
pnpm install
pnpm validate                 # manifestes, catégories, services, skills, vues, réglages
pnpm typecheck && pnpm test   # SDK, kit UI, scripts, écrans
pnpm build                    # build des UI de plugins (plugins/*/ui/dist)
cargo test --workspace        # serveurs MCP Rust
pnpm --dir plugins/gestion-projet/ui dev   # écran hors de Cadence, avec un hôte simulé
pnpm package documents --allow-missing-targets   # archive locale dans out/
```

## Publication

Sur `main`, la CI publie chaque plugin dont la version du manifeste n'a pas encore de tag
`<id>-v<version>` : build des serveurs sur les quatre plateformes, assemblage de
`<id>-<version>.zip` + `.sha256`, release GitHub, puis régénération de `catalog.json` sur la
release fixe `catalog`. Pour proposer un plugin, voir [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[MIT](LICENSE), sauf mention contraire dans le dossier d'un plugin.
