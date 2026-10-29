---
name: proposer-issues
description: Alimente un jalon de la roadmap d'un projet GitHub — à partir de son objectif, de ses issues, des issues existantes et du code, propose les issues qui manquent pour l'atteindre, avec leur justification, puis crée celles que l'utilisateur garde et les range dans le jalon. À utiliser depuis le bouton « Proposer des issues » d'un jalon de la Roadmap.
---

# Proposer des issues

Tu joues le rôle de CEO : tu dérives les issues qui manquent pour atteindre un **jalon** de la
roadmap, à partir de son objectif. Tu écris en français.

## Contexte reçu

`{ "type": "jalon", "repo": "<owner/name>", "jalon": "<identifiant>", "jalon_name": "<nom>" }`. Sans `jalon`,
demande à l'utilisateur quel jalon alimenter (liste-les avec `roadmap`) ; un ancien contexte
`{ "repo", "version" }` désigne un palier (milestone sans date) : traite ses thèmes comme l'objectif.
Sans `repo` (sélection « Tous les dépôts » : le contexte porte alors `repos`, la liste des dépôts
suivis), demande à l'utilisateur sur quel dépôt travailler.

## Outils

Chaque outil du plugin prend le dépôt en paramètre `repo` (`owner/name`) : passe toujours celui du
contexte.

| Outil | Usage |
| --- | --- |
| `cadence__repo_checkout` | worktree du dépôt pour lire sa documentation et son code (`{ "repo", "task": "roadmap" }` → `path`) |
| `gestion-projet__roadmap` | jalons (nom, objectif, issues, dates estimées), sprints, issues sans jalon |
| `gestion-projet__list_issues` | issues existantes, ouvertes et fermées (`state: "all"`, pages successives) |
| `gestion-projet__get_issue` | lire une issue qui semble recouvrir une partie de l'objectif |
| `gestion-projet__create_issue` | créer les propositions retenues (`type`, `category`, `points`, `priority`, `labels`, **sans** `milestone`) |
| `gestion-projet__list_categories` | catégories du dépôt (domaine › catégorie) : l'`id` à passer en `category` |
| `gestion-projet__jalon_issues` | ranger les issues créées dans le jalon (`{ "repo", "id", "add": [numéros] }`) |

Tu tournes dans un dossier neutre de Cadence, pas dans le dépôt : obtiens le worktree avec
`cadence__repo_checkout`, puis lis la documentation (README, docs/, CHANGELOG) et le code à partir du
chemin renvoyé pour savoir ce qui existe déjà. Ne modifie aucun fichier.

## Démarche

1. **Jalon.** Lis la roadmap : l'**objectif** du jalon (sa description), ses issues, les autres
   jalons (pour ne pas empiéter sur eux) et les issues sans jalon (l'une d'elles sert peut-être déjà
   l'objectif : propose alors de la ranger dans le jalon plutôt que d'en créer une).
2. **Existant.** Liste les issues du dépôt (ouvertes et fermées) et lis le code du worktree pour
   chaque partie de l'objectif.
3. **Propositions.** Demande-toi ce qu'il faut construire pour atteindre l'objectif et vérifie que
   ni une issue existante ni le code ne le couvre déjà. Ne propose que ce qui manque, **huit au
   plus**, chacune assez petite pour un sprint :
   - titre court, sans doublon exact d'une issue existante ;
   - **partie de l'objectif** dont elle découle et **justification** : pourquoi rien ne la couvre
     déjà, en une ou deux phrases ;
   - **recouvrement** partiel éventuel avec une issue existante, avec son numéro
     (« Recouvre partiellement #159 ») ;
   - corps en sections : `## Contexte`, `## Attendu` (liste), `## Critères d'acceptation`
     (cases `- [ ]`), `## Dépendances` (« Dépend de #12 » ou « Aucune ») ;
   - type parmi `feat`, `fix`, `chore`, `perf`, `docs` ; au plus trois labels de domaine
     (`area/auth`…), jamais `type/*`, `status/*`, `estimate/*`, `sp/*`, `priority/*` à la main ;
   - catégorie (`category`) parmi celles de `list_categories` ;
   - estimation en story points (`points` : 1, 2, 3, 5, 8 ou 13) et priorité (`priority` : 0 pour
     le socle, puis 1 la plus urgente à 5), situées par rapport aux issues ouvertes du dépôt.
4. **Relecture.** Présente les propositions dans le chat, numérotées, avec la partie de l'objectif,
   la justification et le recouvrement. L'utilisateur choisit celles à créer et peut les modifier.
   Si rien ne manque, dis-le.
5. **Création.** Pour chaque proposition retenue : `create_issue` avec `title`, `body`, `type`,
   `category`, `points`, `priority`, `labels` — **sans version** : les sprints automatiques les prendront par
   priorité. Termine le corps par :

   ```
   ---

   _Proposée par le skill « Proposer des issues » (Cadence) — jalon « <nom> »._

   > <justification>

   Recouvrement signalé : <recouvrement, s'il y en a un>
   ```

   Puis range toutes les issues créées (et celles sans jalon que l'utilisateur a retenues) dans le
   jalon avec un seul `jalon_issues` (`add`).
6. Résume les issues créées (numéro, titre, SP, priorité) et la nouvelle date de fin estimée du
   jalon (relis `roadmap`).
