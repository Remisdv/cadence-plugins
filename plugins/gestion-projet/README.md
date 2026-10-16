# Gestion de projet

Plugin officiel de Cadence : issues GitHub, kanban, roadmap, sprints, versions et pull requests du
dépôt de l'espace, et des **skills** qui remplacent les anciens agents de Cadence.

## Configuration

- **Compte GitHub** (étape de setup `setup-github`) : un jeton GitHub (droits `repo`, `read:org`),
  rangé par Cadence dans le trousseau du système et passé au serveur en
  `CADENCE_SECRET_GITHUB_TOKEN`. L'écran ne fait que l'écrire, puis vérifie la connexion.
- **Réglages par espace** (`settings.schema.json`) :

  | Clé | Défaut | Rôle |
  | --- | --- | --- |
  | `repository` | remote `origin` du dossier | dépôt suivi, `owner/name` |
  | `tag_prefix` | `v` | préfixe des tags de version (`v0.1.2`) |
  | `sprint_length_days` | `14` | durée d'un nouveau sprint |

Conventions GitHub reprises de Cadence : labels `type/feat|fix|chore|perf|docs`,
`status/todo|doing|review` (une issue fermée est « faite »), `estimate/S|M|L|XL` ; une version est
un milestone semver, **daté = sprint**, **sans date = palier** de roadmap dont les thèmes sont les
éléments de liste de la description.

## Écrans

| Vue | Section | État |
| --- | --- | --- |
| Sprint en cours (`sprint`) | Pilotage | à venir (TODO) |
| Issues (`issues`) | Pilotage | liste par état, filtres, boutons « Compléter » et « Implémenter » |
| Roadmap (`roadmap`) | Planification | à venir (TODO) |
| Versions (`versions`) | Planification | à venir (TODO) |
| Pull requests (`pull-requests`) | Code | à venir (TODO) |

```sh
pnpm --dir plugins/gestion-projet/ui dev   # hors de Cadence, avec des données d'exemple
```

## Actions et skills

| Action | Skill | Mode | Contexte | Ex-agent |
| --- | --- | --- | --- | --- |
| Compléter l'issue | `completer-issue` | chat | `{ "issue": 42 }` | CTO |
| Découper l'issue | `decouper-issue` | chat | `{ "issue": 42 }` | — |
| Implémenter | `implementer-issue` | fond | `{ "issue": 42 }` | développeur |
| Proposer des issues | `proposer-issues` | chat | `{ "version": "0.2.0" }` | CEO |
| Préparer la release | `preparer-release` | fond | `{ "version": "0.1.2" }` | déploiement |

Les écritures GitHub sont directes (outils MCP ci-dessous) ; les garde-fous sont dans les skills :
worktree isolé, jamais de push sur la branche par défaut, PR et release en brouillon.

## Outils MCP (`gestion-projet__<outil>`)

| Outil | État |
| --- | --- |
| `get_account` (réservé à l'UI) | ✓ compte du jeton |
| `get_repository` | ✓ branche par défaut, préfixe de tag |
| `list_issues`, `get_issue`, `create_issue`, `update_issue` | ✓ API REST GitHub |
| `add_comment` | ✓ |
| `list_milestones` | ✓ versions (sprint / palier) |
| `create_milestone`, `update_milestone` | TODO |
| `list_pull_requests`, `get_pull_request`, `create_pull_request`, `mark_pull_request_ready` | TODO |
| `list_releases`, `create_release` | TODO |
| `sprint_summary` (réservé à l'UI) | TODO |

Les outils TODO répondent par une erreur d'outil explicite ; les skills prévoient un repli
(`gh`, URL de comparaison).

Réseau : `api.github.com` uniquement (ou `GITHUB_API_URL`).

## Développement

```sh
cargo test -p cadence-gestion-projet
pnpm --dir plugins/gestion-projet/ui build
pnpm validate gestion-projet
```

Le serveur lit ses réglages dans `CADENCE_SETTINGS` (JSON) ou `<CADENCE_DATA_DIR>/settings.json`.
