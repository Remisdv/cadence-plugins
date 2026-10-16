# Gestion de projet

Plugin officiel de Cadence (catégorie **Projet**) : issues GitHub, kanban, roadmap, sprints,
versions et pull requests de vos **dépôts suivis**, et des **skills** qui remplacent les anciens
agents de Cadence.

## Configuration

Le plugin déclare `services = ["repos"]` : Cadence fournit la connexion GitHub, la liste des dépôts
suivis et le sélecteur de dépôt en tête de la barre du plugin. Le plugin n'a plus de secret propre.

- **Connexion GitHub** (gh CLI, navigateur, code d'appairage ou jeton personnel) : gérée par Cadence,
  dans l'onboarding ou les réglages ; le jeton reste au trousseau et arrive au serveur en
  `CADENCE_GITHUB_TOKEN`.
- **Dépôts suivis** (étape de setup `setup-depots`) : l'écran propose les dépôts du compte et ajoute
  ou retire des dépôts avec `cadence.repos.follow` / `unfollow`. Le serveur reçoit la liste en
  `CADENCE_REPOS`, puis `notifications/cadence/repos` à chaque changement.
- **Réglages globaux** (`settings.schema.json`, reçus en `CADENCE_SETTINGS` puis
  `notifications/cadence/settings`) :

  | Clé | Défaut | Rôle |
  | --- | --- | --- |
  | `tag_prefix` | `v` | préfixe des tags de version (`v0.1.2`) |
  | `sprint_length_days` | `14` | durée d'un nouveau sprint |

- **Dépendances externes** : celles du service `repos`, que le plugin ne redéclare pas — `git`
  (requis, pour cloner et préparer les worktrees) et `gh` (optionnel, connecté, pour réutiliser
  une connexion GitHub existante). Cadence les détecte et propose de les installer. Le serveur ne
  lance aucun outil externe (il passe par l'API GitHub) ; s'il devait lancer `git`, il en lirait
  le chemin dans `CADENCE_TOOLS`.

Conventions GitHub reprises de Cadence : labels `type/feat|fix|chore|perf|docs`,
`status/todo|doing|review` (une issue fermée est « faite »), `estimate/S|M|L|XL` ; une version est
un milestone semver, **daté = sprint**, **sans date = palier** de roadmap dont les thèmes sont les
éléments de liste de la description.

## Écrans

Les vues suivent le sélecteur de Cadence (`cadence.repos.selection()` / `onChange`) : un dépôt, ou
« Tous les dépôts » pour une vue agrégée avec une colonne dépôt.

| Vue | Section | État |
| --- | --- | --- |
| Sprint en cours (`sprint`) | Pilotage | à venir (TODO) |
| Issues (`issues`) | Pilotage | liste par état, filtres, mode « Tous les dépôts », boutons « Compléter » et « Implémenter » |
| Roadmap (`roadmap`) | Planification | à venir (TODO) |
| Versions (`versions`) | Planification | à venir (TODO) |
| Pull requests (`pull-requests`) | Code | à venir (TODO) |
| Dépôts suivis (`setup-depots`) | étape de setup | dépôts suivis, dépôts du compte à suivre |

```sh
pnpm --dir plugins/gestion-projet/ui dev   # hors de Cadence, avec des données d'exemple
# ?view=setup-depots : étape de setup ; ?repo=all : « Tous les dépôts »
```

## Actions et skills

Le contexte d'une action porte toujours le dépôt concerné (`repo`, celui de l'issue ou de la
version).

| Action | Skill | Mode | Contexte | Ex-agent |
| --- | --- | --- | --- | --- |
| Compléter l'issue | `completer-issue` | chat | `{ "repo": "me/app", "issue": 42 }` | CTO |
| Découper l'issue | `decouper-issue` | chat | `{ "repo": "me/app", "issue": 42 }` | — |
| Implémenter | `implementer-issue` | fond | `{ "repo": "me/app", "issue": 42 }` | développeur |
| Proposer des issues | `proposer-issues` | chat | `{ "repo": "me/app", "version": "0.2.0" }` | CEO |
| Préparer la release | `preparer-release` | fond | `{ "repo": "me/app", "version": "0.1.2" }` | déploiement |

L'IA tourne toujours dans un dossier neutre de Cadence, jamais dans un dépôt. Les skills qui lisent
ou modifient le code demandent d'abord un worktree avec l'outil du cœur `cadence__repo_checkout`
(`{ "repo", "task" }` → chemin) : Cadence clone le dépôt à la demande et n'ouvre que ce worktree à
l'IA, pour la session. Les écritures GitHub sont directes (outils MCP ci-dessous) ; les garde-fous
sont dans les skills : worktree par tâche, jamais de push sur la branche par défaut, PR et release
en brouillon.

## Outils MCP (`gestion-projet__<outil>`)

Tous les outils de dépôt prennent `repo` (`owner/name`), qui doit être un dépôt suivi.

| Outil | État |
| --- | --- |
| `get_account`, `list_account_repos` (réservés à l'UI) | ✓ compte connecté, dépôts du compte à suivre |
| `get_repository` | ✓ branche par défaut, préfixe de tag |
| `list_issues` | ✓ `repo` absent : tous les dépôts suivis (chaque issue porte `repo`, erreurs par dépôt dans `errors`) |
| `get_issue`, `create_issue`, `update_issue` | ✓ API REST GitHub |
| `add_comment` | ✓ |
| `list_milestones` | ✓ versions (sprint / palier) |
| `create_milestone`, `update_milestone` | TODO |
| `list_pull_requests` (`repo` optionnel), `get_pull_request`, `create_pull_request`, `mark_pull_request_ready` | TODO |
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

Le serveur ne garde rien en local (`CADENCE_DATA_DIR` inutilisé) : tout est lu sur GitHub.
