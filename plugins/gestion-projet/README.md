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

  | Clé                  | Défaut | Rôle                                   |
  | -------------------- | ------ | -------------------------------------- |
  | `tag_prefix`         | `v`    | préfixe des tags de version (`v0.1.2`) |
  | `sprint_length_days` | `14`   | durée d'un nouveau sprint              |

- **Dépendances externes** : celles du service `repos`, que le plugin ne redéclare pas — `git`
  (requis, pour cloner et préparer les worktrees) et `gh` (optionnel, connecté, pour réutiliser
  une connexion GitHub existante). Cadence les détecte et propose de les installer. Le serveur ne
  lance aucun outil externe (il passe par l'API GitHub) ; s'il devait lancer `git`, il en lirait
  le chemin dans `CADENCE_TOOLS`.

Conventions GitHub reprises de Cadence : labels `type/feat|fix|chore|perf|docs`,
`status/todo|doing|review` (une issue fermée est « faite »), story points `sp/1|2|3|5|8|13` (Fibonacci ;
l'ancien `estimate/S|M|L|XL` est encore lu), priorité `priority/0` (socle) puis `priority/1` (la plus
urgente) à `priority/5` ; une version est
un milestone semver, **daté = sprint**, **sans date = palier** de roadmap dont les thèmes sont les
éléments de liste de la description.

## Écrans

Les vues suivent le sélecteur de Cadence (`cadence.repos.selection()` / `onChange`) : un dépôt, ou
« Tous les dépôts » pour une vue agrégée avec une colonne dépôt.

| Vue                             | Section        | État                                                                                                                                                                                                   |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sprint en cours (`sprint`)      | Pilotage       | KPI (portée, avancement, restantes, rythme, retard), kanban par état, burndown, progression (`sprint_summary`) ; un sprint par dépôt en mode « Tous les dépôts »                                       |
| Issues (`issues`)               | Pilotage       | liste par état, filtres, mode « Tous les dépôts », boutons « Compléter » et « Implémenter »                                                                                                            |
| Roadmap (`roadmap`)             | Planification  | versions livrées et en cours, sprints planifiés puis paliers (nom, thèmes, avancement), bouton « Proposer des issues » sur un palier                                                                   |
| Versions (`versions`)           | Planification  | liste des versions ouvertes et livrées ; détail : KPI, portée, notes de version, PR, release, burndown, conditions de clôture, « Clôturer la version » (`update_milestone`) et « Préparer la release » |
| Pull requests (`pull-requests`) | Code           | PR ouvertes / fermées, CI, revues, version ; détail (description, checks, revues, fichiers) et « Prête pour la revue » (`mark_pull_request_ready`)                                                     |
| Dépôts suivis (`setup-depots`)  | étape de setup | dépôts suivis, dépôts du compte à suivre                                                                                                                                                               |

Paramètres de route de `versions` : `{ "repo", "version" }` ouvre le détail d'une version (liens
depuis la Roadmap et le Sprint en cours).

```sh
pnpm --dir plugins/gestion-projet/ui dev   # hors de Cadence, avec des données d'exemple
# ?view=sprint|roadmap|versions|pull-requests|setup-depots ; &version=0.1.2 : détail d'une version
# ?repo=all : « Tous les dépôts »
```

## Actions et skills

Le contexte d'une action porte toujours le dépôt concerné (`repo`, celui de l'issue ou de la
version).

| Action              | Skill               | Mode | Contexte                                   | Ex-agent    |
| ------------------- | ------------------- | ---- | ------------------------------------------ | ----------- |
| Créer des issues depuis un document | `extraire-issues` | chat | `{ "repo": "me/app" }` (ou rien depuis la barre du plugin) | — |
| Compléter l'issue   | `completer-issue`   | chat | `{ "repo": "me/app", "issue": 42 }`        | CTO         |
| Découper l'issue    | `decouper-issue`    | chat | `{ "repo": "me/app", "issue": 42 }`        | —           |
| Implémenter         | `implementer-issue` | fond | `{ "repo": "me/app", "issue": 42 }`        | développeur |
| Proposer des issues | `proposer-issues`   | chat | `{ "repo": "me/app", "version": "0.2.0" }` | CEO         |
| Préparer la release | `preparer-release`  | fond | `{ "repo": "me/app", "version": "0.1.2" }` | déploiement |

L'IA tourne toujours dans un dossier neutre de Cadence, jamais dans un dépôt. Les skills qui lisent
ou modifient le code demandent d'abord un worktree avec l'outil du cœur `cadence__repo_checkout`
(`{ "repo", "task" }` → chemin) : Cadence clone le dépôt à la demande et n'ouvre que ce worktree à
l'IA, pour la session. Les écritures GitHub sont directes (outils MCP ci-dessous) ; les garde-fous
sont dans les skills : worktree par tâche, jamais de push sur la branche par défaut, PR et release
en brouillon.

## Outils MCP (`gestion-projet__<outil>`)

Tous les outils de dépôt prennent `repo` (`owner/name`), qui doit être un dépôt suivi.

| Outil                                                 | État                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_account`, `list_account_repos` (réservés à l'UI) | ✓ compte connecté, dépôts du compte à suivre                                                                                                                 |
| `get_repository`                                      | ✓ branche par défaut, préfixe de tag                                                                                                                         |
| `list_issues`                                         | ✓ `repo` absent : tous les dépôts suivis (chaque issue porte `repo`, erreurs par dépôt dans `errors`)                                                        |
| `get_issue`, `create_issue`, `update_issue`           | ✓ API REST GitHub                                                                                                                                            |
| `add_comment`                                         | ✓                                                                                                                                                            |
| `list_milestones`                                     | ✓ versions (sprint / palier), nom (`# Nom`) et thèmes (éléments de liste) lus dans la description                                                            |
| `create_milestone`                                    | ✓ échéance `AAAA-MM-JJ` (sprint) ou aucune (palier) ; refuse un titre existant                                                                               |
| `update_milestone`                                    | ✓ titre, description, échéance (`""` la retire), `state: closed` pour clore                                                                                  |
| `list_pull_requests` (`repo` optionnel)               | ✓ GraphQL : ouvertes (50) et/ou 30 dernières fermées, CI du dernier commit, revues, issues fermées ; erreurs par dépôt dans `errors`                         |
| `get_pull_request`                                    | ✓ description, checks détaillés, revues, fichiers (sans patchs)                                                                                              |
| `create_pull_request`                                 | ✓ brouillon par défaut, `base` = branche par défaut ; refuse la branche par défaut comme `head`                                                              |
| `mark_pull_request_ready`                             | ✓ mutation GraphQL `markPullRequestReadyForReview`                                                                                                           |
| `list_releases`                                       | ✓ publiées et brouillons                                                                                                                                     |
| `create_release`                                      | ✓ brouillon par défaut, tag = préfixe réglé + version ; refuse un tag qui a déjà une release                                                                 |
| `sprint_summary` (réservé à l'UI)                     | ✓ milestone daté ouvert le plus proche (ou `version` donnée) : issues par état, burndown, rythme, retard ; début du sprint = échéance − `sprint_length_days` |

Les échéances sont envoyées à midi UTC pour que GitHub garde le même jour. Le burndown compte la
portée actuelle du milestone dès le premier jour (GitHub ne date pas l'entrée d'une issue).

Réseau : `api.github.com` uniquement (REST et `/graphql` ; ou `GITHUB_API_URL`, GraphQL sur
`…/api/graphql` pour GitHub Enterprise).

## Développement

```sh
cargo test -p cadence-gestion-projet
pnpm --dir plugins/gestion-projet/ui build
pnpm validate gestion-projet
```

Le serveur ne garde rien en local (`CADENCE_DATA_DIR` inutilisé) : tout est lu sur GitHub.
