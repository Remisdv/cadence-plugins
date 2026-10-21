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

  | Clé                  | Défaut   | Rôle                                                              |
  | -------------------- | -------- | ----------------------------------------------------------------- |
  | `tag_prefix`         | `v`      | préfixe des tags de version (`v0.1.2`)                            |
  | `sprint_length_days` | `14`     | durée d'un nouveau sprint                                         |
  | `merge_method`       | `squash` | fusion des PR par l'IA (`squash`, `merge` ou `rebase`), « Relire et valider » compris |

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
| Sprint en cours (`sprint`)      | Pilotage       | « Démarrer le projet », barre des sprints automatiques (pause, durée confirmée — prochain sprint ou sprint en cours —, « Clore le sprint » en avance, capacité), KPI, kanban par état, burndown et progression **en story points**, sprints terminés et leur livraison (`sprint_summary`, `project_*`) ; « Ajouter des issues » (carnet dans l'ordre de la roadmap, cases ou glisser sur le tableau) et retrait d'une carte « À faire » (`sprint_backlog`, `sprint_issues`) ; colonne « En revue » sélectionnable (« Relire », « Relire la sélection (n) »), PR de chaque tâche retrouvée même vers `release/x` ; **Conversations du sprint** ; un sprint par dépôt en mode « Tous les dépôts » (un seul dépôt suivi : il est pris d'office) |
| Issues (`issues`)               | Pilotage       | liste par état, filtres, mode « Tous les dépôts », boutons « Compléter » et « Implémenter »                                                                                                            |
| Roadmap (`roadmap`)             | Planification  | jalons : frise sur les sprints passés et prévus, carte par jalon (avancement, fin estimée et fourchette, issues), nouveau jalon, ranger des issues, « Proposer des issues » ; issues sans jalon |
| Planning (`planning`)           | Planification  | Gantt libre (étude, conception, développement, recette…) : phases, personnes, dépendances, avancement, jalons-dates ; glisser une barre ou ses bords, « Planifier avec l'IA » |
| Versions (`versions`)           | Planification  | liste des versions ouvertes et livrées ; détail : KPI, portée, notes de version, PR, release, burndown, conditions de clôture, « Clôturer la version » (`update_milestone`) et « Préparer la release » |
| Architecture (`architecture`)   | Conception     | système (services et liens, schéma automatique) puis couches d'un service (rôles, dépendances autorisées, règles, conventions) ; modèles prêts ; enregistrement par PR ; « Adapter le code » |
| Designs (`designs`)             | Conception     | designs de Claude Design : ajout par lien claude.ai (import par l'IA), visionneuse des pages, « Créer des issues depuis ce design » |
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
version) et, pour une action qui déclare un type de contexte, `type` égal à ce type (`issue`,
`version`, `jalon`, `design`) : Cadence refuse sinon de la lancer.

| Action              | Skill               | Mode | Contexte                                   | Ex-agent    |
| ------------------- | ------------------- | ---- | ------------------------------------------ | ----------- |
| Créer des issues depuis un document | `extraire-issues` | chat | `{ "repo": "me/app" }` (ou rien depuis la barre du plugin) | — |
| Compléter l'issue   | `completer-issue`   | chat | `{ "type": "issue", "repo", "issue": 42 }` | CTO         |
| Découper l'issue    | `decouper-issue`    | chat | `{ "type": "issue", "repo", "issue": 42 }` | —           |
| Implémenter         | `implementer-issue` | fond | `{ "type": "issue", "repo", "issue": 42 }` | développeur |
| Proposer des issues | `proposer-issues`   | chat | `{ "type": "jalon", "repo", "jalon": "mvp" }` | CEO      |
| Importer un design  | `importer-design`   | chat | `{ "type": "design", "repo", "design", "url", "name" }` | — |
| Planifier avec l'IA | `planifier`         | chat | `{ "repo": "me/app" }`                     | —           |
| Développer le sprint | `developper-sprint` | chat | `{ "repo": "me/app", "group" }` (ou `issues`) | développeur |
| Relire les PR       | `relire-pr`         | chat | `{ "repo", "number" }` (`number` facultatif : tout le sprint) | relecteur |
| Relire et valider   | `relire-valider`    | chat | `{ "type": "review", "repo", "items": [{ "issue": 42, "pr": 51 }], "group" }` | relecteur |
| Créer un design     | `creer-design`      | chat | `{ "repo", "design" }` (`design` pour modifier) | —      |
| Adapter le code à l'architecture | `adapter-architecture` | chat | `{ "repo", "service" }` (service facultatif) | — |
| Préparer la release | `preparer-release`  | fond | `{ "type": "version", "repo", "version" }` | déploiement |

### Conversations du sprint

« Développer le sprint », « Implémenter » sur une issue d'un sprint (milestone daté) et la revue
groupée ajoutent au contexte le champ réservé de Cadence
`group: { "id": "sprint:<repo>:<n° du milestone>", "label": "Sprint <version> · <repo>" }`
(`sprintGroup`, `issueGroup` de `ui/src/domain.ts`) ; sans sprint, pas de groupe (conversation
normale). Cadence masque ces conversations du chat global et de « Conversations » de la barre du
plugin : l'écran « Sprint en cours » les liste dans **Conversations du sprint**
(`cadence.conversations.list({ group })`, rafraîchie à chaque événement `conversations`) avec leur
état, l'action, l'IA, les issues concernées et la date, et les ouvre dans le chat
(`conversations.open`). Le numéro du milestone sert de clé : renommer la version ne sépare pas les
conversations.

### Revue groupée : « Relire et valider »

Dans la colonne « En revue » du sprint, chaque tâche a une case à cocher, sa PR (celle qui déclare
fermer l'issue, avec sa CI) et un bouton **Relire** ; la barre **Relire la sélection (n)** lance la
même action pour toutes les tâches cochées, dans **une seule conversation**. Le skill
`relire-valider` relit chaque PR (diff, CI, critères d'acceptation, architecture), rend un verdict
par tâche et **demande la confirmation explicite** de l'utilisateur ; ensuite seulement, pour chaque
tâche validée : `review_pull_request` (APPROVE), sortie du brouillon, `merge_pull_request` (méthode
du réglage `merge_method`, squash par défaut ; `delete_branch`, `close_issues`), issue fermée et
passée en terminé ; une tâche refusée reçoit une revue « changes requested » et repasse en cours.
Une PR à la CI rouge n'est jamais fusionnée. L'écran Pull requests liste des PR, pas des tâches :
il garde « Relire les PR » (`relire-pr`).

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
| `get_issue`, `create_issue`, `update_issue`           | ✓ API REST GitHub ; une issue porte `sprint` (n° du milestone daté, sinon `null`) ; `update_issue` avec `state: closed` retire le label `status/*` (terminé) |
| `add_comment`                                         | ✓                                                                                                                                                            |
| `list_milestones`                                     | ✓ versions (sprint / palier), nom (`# Nom`) et thèmes (éléments de liste) lus dans la description                                                            |
| `create_milestone`                                    | ✓ échéance `AAAA-MM-JJ` (sprint) ou aucune (palier) ; refuse un titre existant                                                                               |
| `update_milestone`                                    | ✓ titre, description, échéance (`""` la retire), `state: closed` pour clore                                                                                  |
| `list_pull_requests` (`repo` optionnel)               | ✓ GraphQL : ouvertes (50) et/ou 30 dernières fermées, CI du dernier commit, revues ; `closes` (références de GitHub, « Ferme #n » / « Closes #n » du titre ou du corps — GitHub ne les relie pas vers `release/x` —, liens manuels de la timeline) et `issues` (`closes` + issue de la branche `feat/<n>-…`) ; erreurs par dépôt dans `errors` |
| `get_pull_request`                                    | ✓ description, checks détaillés, revues, fichiers (sans patchs)                                                                                              |
| `create_pull_request`                                 | ✓ brouillon par défaut, `base` = branche par défaut ; refuse la branche par défaut comme `head`                                                              |
| `mark_pull_request_ready`                             | ✓ mutation GraphQL `markPullRequestReadyForReview`                                                                                                           |
| `get_pull_request_diff`                               | ✓ patchs par fichier (60 000 caractères au plus, ou un fichier)                                                                                              |
| `review_pull_request`                                 | ✓ `APPROVE`, `REQUEST_CHANGES` ou `COMMENT`, synthèse et remarques sur des lignes ; PR du même compte : verdict publié en commentaire                       |
| `merge_pull_request`                                  | ✓ PR prête et sans conflit ; `method` (absente : réglage `merge_method`, squash), `delete_branch` (jamais la branche par défaut, `release/*` ou un fork), `close_issues` ; issues déclarées (« Ferme #12 ») et demandées fermées comme terminées, label `status/*` retiré |
| `list_releases`                                       | ✓ publiées et brouillons                                                                                                                                     |
| `create_release`                                      | ✓ brouillon par défaut, tag = préfixe réglé + version ; refuse un tag qui a déjà une release                                                                 |
| `sprint_summary`                                      | ✓ milestone daté ouvert le plus proche (ou `version` donnée) : issues par état ; portée, avancement, burndown, rythme et retard **en story points** (3 SP par issue non estimée) ; l'échéance est le dernier jour du sprint, début = échéance − (`sprint_length_days` − 1) ; `started`, `start_defaults` tant que les sprints ne sont pas démarrés |
| `project_start`, `project_pause`, `project_resume`, `project_set_duration` (`apply` : `next` par défaut, `current` après confirmation), `project_close_sprint` (IA : à la demande explicite de l'utilisateur) | ✓ sprints automatiques : issue d'état `cadence/sprints`, milestones, branches `release/x`, remplissage, fusion et tag, clôture anticipée (voir « Sprints automatiques ») |
| `sprint_issues`, `sprint_backlog`                     | ✓ ajouter / retirer des issues du sprint en cours ; carnet (issues sans version) dans l'ordre de remplissage, avec jalon et poids |

## Sprints automatiques

L'écran « Sprint en cours » propose **Démarrer le projet** : on saisit la durée d'un sprint (d'un
jour à quatre semaines, par exemple 1 jour ou 2 semaines), la capacité du premier sprint en story
points et sa version (`0.1.0` par défaut). Un sprint de N jours couvre N jours civils, échéance
comprise : un sprint d'un jour commence et finit le même jour, le suivant part le lendemain. Le
bouton reste proposé tant que l'issue d'état n'a que des jalons (`status: idle`, créée par la
Roadmap) : le démarrage la reprend. Ensuite, Cadence fait tout seul :

- **Un sprint = une version** : milestone daté `0.2.0` et branche `release/0.2.0` (créée depuis la
  branche par défaut, ou depuis la release précédente si elle n'est pas encore fusionnée). Les
  branches `feat/…` partent de la branche de release et y sont fusionnées (skill « Implémenter »).
- **Remplissage selon la roadmap** : les issues ouvertes sans version, celles du premier jalon de
  la Roadmap d'abord, puis du suivant…, puis les issues sans jalon ; dans chaque groupe
  `priority/0` (socle) d'abord puis 1 à 5, sans priorité en dernier ; tant qu'elles tiennent dans
  la capacité (rythme × durée, jamais sous 1 SP) ; une issue dont une
  dépendance (« Dépend de #12 ») est ouverte hors du sprint attend ; une issue sans story points
  compte pour 3. Un sprint vide prend au moins une issue, même plus grosse que sa capacité
  (sprints courts), et une durée réduite n'en retire jamais la dernière.
- **Adaptation** : la capacité suit le rythme réel (story points fermés par jour sur les trois
  derniers sprints, pauses déduites). Un sprint fini en avance tire les issues suivantes. À
  l'échéance, les issues ouvertes passent en tête du sprint suivant et leurs PR visent la nouvelle
  branche de release.
- **Livraison** : à la fin du sprint, PR `release/x` → branche par défaut, fusionnée dès que la CI
  est verte (bloquée et signalée en cas d'échec ou de conflit), puis release `v0.2.0` publiée.
- **Pause** : plus de remplissage ni de clôture ; à la reprise, l'échéance est repoussée d'autant.
  La **durée** se change à tout moment, avec confirmation : par défaut à partir du prochain sprint
  (le sprint en cours garde son échéance) ; ou aussi au sprint en cours, dont l'échéance du
  milestone est recalculée et la portée ajustée (issues ajoutées, ou issues « à faire » les moins
  urgentes retirées).
- **Clore le sprint** en avance (avec confirmation) : comme à l'échéance, issues ouvertes et PR
  reportées au sprint suivant, qui commence le jour même, puis livraison de la branche de release.
- **Portée à la main** : « Ajouter des issues » ouvre le carnet dans l'ordre de remplissage (on
  coche, ou on glisse une issue sur le tableau du sprint) ; une carte « À faire » se retire du
  sprint (elle repart sans version).

L'état est partagé par toute l'équipe dans une issue du dépôt, label `cadence/sprints`, masquée
dans l'écran Issues (texte lisible + bloc JSON). Chaque Cadence ouvert fait avancer les sprints :
à l'ouverture de l'écran Sprint et toutes les dix minutes ; toutes les étapes sont idempotentes.
Outils `project_start`, `project_pause`, `project_resume`, `project_set_duration`,
`project_close_sprint` (l'IA ne s'en sert qu'à la demande explicite de l'utilisateur),
`sprint_issues`, `sprint_backlog` ; `sprint_summary` porte l'état : `started`,
`project` une fois démarrés, sinon `start_defaults` (durée, capacité, version proposées).

## Roadmap par jalons

Un **jalon** est un objectif nommé (« MVP privé », « Bêta publique ») avec une description et des
issues ; il s'atteint en un ou plusieurs sprints. Les jalons vivent dans l'issue d'état (rangés dans
l'ordre de la roadmap, une issue dans un seul jalon) : ni branche ni milestone, mais leur ordre
nourrit les sprints (les issues du jalon de tête passent avant les autres, puis par priorité).

L'écran Roadmap montre une frise (sprints terminés, en cours, puis prévus au rythme moyen) et une
carte par jalon : avancement en story points, sprints concernés, **date de fin estimée** et sa
**fourchette** (rythmes du meilleur et du moins bon des trois derniers sprints ; ±40 % sans
historique, ±25 % après un sprint). La prévision rejoue le remplissage du moteur (ordre des
jalons, priorité, dépendances, capacité) sur les issues sans version ; un jalon finit avec le sprint qui prend sa
dernière issue ouverte. Les dates se précisent à chaque sprint. On y crée, renomme, réordonne et
supprime les jalons, et on y range les issues ; le skill « Créer des issues depuis un document »
range les issues qu'il crée dans un jalon (existant ou nouveau), « Proposer des issues » complète
un jalon. Outils : `roadmap`, `jalon_save`, `jalon_delete`, `jalon_issues`.

## Designs (Claude Design)

« Ajouter un design » prend le lien claude.ai d'un design et ouvre une conversation avec le skill
« Importer un design » : l'IA récupère les fichiers avec l'outil Artifact de Claude Code (ou, sans
accès à claude.ai, depuis l'export que l'utilisateur joint au chat), les commite sous
`design/<id>/` sur une branche `design/<id>` (partant de la release en cours ou de la branche par
défaut) et ouvre la pull request. Le registre des designs (nom, lien, état, branche, dossier) vit
dans l'issue d'état. La page Designs affiche chaque page HTML dans une iframe isolée (`sandbox`),
images et styles relatifs incorporés par le serveur. L'IA les voit avec `list_designs` et
`get_design` : on peut les citer dans le chat, « Créer des issues depuis ce design » en tire les
issues, et « Implémenter » s'y réfère pour les écrans.

## Architecture

L'écran Architecture décrit le projet à deux niveaux : le **système** (services — proxy, front,
back, worker, base, cache, file, service externe — et leurs liens, dessinés automatiquement en
colonnes de l'entrée vers les données), puis, en cliquant sur un service, son **intérieur** :
couches (controller, service, DTO, repository…), emplacement du code de chacune, couches qu'elle
peut utiliser (toute autre dépendance est un écart), règles et conventions. Des **modèles** prêts
s'appliquent au système (web classique, API + cache + tâches, microservices) ou à un service (API
REST en couches, hexagonale, NestJS, Spring Boot, Express, FastAPI, Django, React par
fonctionnalités, Next.js, Tauri) puis s'ajustent par formulaires.

L'architecture vit dans le dépôt : `architecture/architecture.json` (source) et
`architecture/ARCHITECTURE.md` (généré, schéma Mermaid lisible sur GitHub). « Enregistrer » commite
les deux fichiers sur une branche `archi/…` et ouvre la PR (réutilisée tant qu'elle est ouverte) ;
l'écran lit la PR ouverte en priorité. « Implémenter » suit l'architecture et vérifie son diff
avant la PR ; « Adapter le code » (skill `adapter-architecture`) audite le code, liste les écarts,
puis après accord refactore dans une PR ou crée des issues. Outils : `architecture_get`,
`architecture_templates`, `architecture_save`.

## Depuis le chat

Tout se demande aussi dans le chat de Cadence, sans ouvrir les écrans : les skills du plugin sont
dans le menu Skills (`/cadence:gestion-projet-…`) et ses outils sont visibles de l'IA (sauf
`get_account`, `list_account_repos` et `design_delete`, réservés à l'écran). Exemples :
« ajoute une fonctionnalité d'export PDF » (issues), « développe le sprint », « relis les PR et
fusionne ce qui est bon », « décale la recette d'une semaine dans le planning », « passe les sprints
à trois semaines » (`project_set_duration`), « fais-moi le design de l'écran d'accueil »,
« ajoute un worker à l'architecture puis adapte le code ». Les outils qui écrivent (sprints,
planning, architecture, fusion) ne servent qu'à la demande explicite de l'utilisateur.

Revue des PR : `get_pull_request_diff` (patchs), `review_pull_request` (APPROVE /
REQUEST_CHANGES / COMMENT, remarques sur des lignes ; sur une PR du même compte GitHub, le verdict
est publié en commentaire) et `merge_pull_request` (méthode du réglage, squash par défaut ; ferme
comme terminées les issues liées, y compris quand la base est une branche de release, ce que
GitHub ne fait que pour la branche par défaut ; supprime la branche à la demande).

## Planning (Gantt)

Un planning libre, pas seulement du développement : tâches groupées par **phase** (étude,
conception, développement, recette, lancement…), **personnes** affectées, **dépendances**
(flèches), avancement, **jalons-dates** (losanges), issue liée facultative. On glisse une barre
pour la déplacer, ses bords pour changer ses dates ; un clic ouvre la tâche ; zoom jours /
semaines / mois, filtre par personne. « Planifier avec l'IA » (skill `planifier`) propose un
planning à partir des contraintes données et de la roadmap, et ne l'enregistre qu'après accord.
Le planning est partagé dans une seconde issue cachée, label `cadence/planning` ; chaque
enregistrement augmente sa `revision` et une écriture fondée sur une révision dépassée est refusée
(deux personnes qui modifient en même temps). Outils : `planning_get`, `planning_save`.

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
