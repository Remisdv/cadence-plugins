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
3. Activez-le dans un espace de travail et suivez ses étapes de configuration (ex. connexion GitHub
   pour Gestion de projet). L'activation est enregistrée dans `<espace>/.cadence/workspace.toml`.

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

Cibles : `windows-x86_64`, `macos-aarch64`, `macos-x86_64`, `linux-x86_64`. Cadence lance un
processus serveur par plugin et par espace (MCP sur stdio) avec `CADENCE_API=1`,
`CADENCE_WORKSPACE`, `CADENCE_DATA_DIR`, `CADENCE_GLOBAL_DIR` et chaque secret déclaré en
`CADENCE_SECRET_<ID_MAJUSCULE>`. Les outils sont exposés aux IA préfixés `<plugin>__<outil>`.

Le manifeste est décrit par [`schema/plugin.schema.json`](schema/plugin.schema.json) ; un exemple
complet : [`plugins/gestion-projet/plugin.toml`](plugins/gestion-projet/plugin.toml).

## Développer

Prérequis : Node ≥ 20, pnpm 10, Rust stable.

```sh
pnpm install
pnpm validate                 # manifestes, skills, vues, réglages
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
