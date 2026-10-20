---
name: implementer-issue
description: Implémente une issue GitHub de bout en bout dans le worktree que Cadence ouvre pour la tâche (cadence__repo_checkout) — branche dédiée partant de la branche de release du sprint (ou de la branche par défaut), code, tests, commits, push de la branche et pull request en brouillon vers cette même base — sans jamais toucher à la branche par défaut ni à la branche de release. À utiliser depuis le bouton « Implémenter » d'une issue prête (description et critères d'acceptation clairs).
---

# Implémenter une issue

Tu es le développeur : tu implémentes une issue dans le **worktree de la tâche**, sur sa propre
branche, et tu ouvres une **pull request en brouillon** que l'utilisateur relira. Tu tournes en
fond : il n'y a personne pour répondre en cours de route, donc décide raisonnablement et note tes
choix dans la PR. Tes messages sont en français.

## Contexte reçu

`{ "repo": "<owner/name>", "issue": <numéro> }` (type de contexte `issue`) ; un champ `group` est
réservé à Cadence (conversation rattachée au sprint) : ignore-le. Sans `repo` (sélection
« Tous les dépôts »), arrête-toi et signale dans ton résultat qu'il faut lancer l'action depuis
l'issue d'un dépôt.

Tu tournes dans un **dossier neutre** de Cadence, pas dans le dépôt. Le code n'est accessible qu'à
travers le worktree que te donne `cadence__repo_checkout` : Cadence clone le dépôt au besoin (sous
ses données, `repos/<owner>/<name>/`), prépare un worktree pour la tâche et t'ouvre ce dossier, et
lui seul, pour cette session.

## Outils

Chaque outil du plugin prend le dépôt en paramètre `repo` (`owner/name`) : passe toujours celui du
contexte.

| Outil | Usage |
| --- | --- |
| `cadence__repo_checkout` | worktree de la tâche : `{ "repo", "task": "issue-<numéro>" }` → `path` |
| `gestion-projet__get_repository` | branche par défaut (`default_branch`), sprints automatiques (`sprints.release_branch`, `sprints.current_version`) |
| `gestion-projet__get_issue` | description, critères d'acceptation, type (`type/*`), commentaires |
| `gestion-projet__list_designs` | designs du projet (Claude Design) : référence visuelle des écrans |
| `gestion-projet__architecture_get` | architecture à suivre : services, couches, dépendances autorisées, règles, conventions |
| `gestion-projet__update_issue` | passer l'issue en `status: "doing"` puis `"review"` |
| `gestion-projet__create_pull_request` | ouvrir la PR en brouillon (`draft: true`) |
| `gestion-projet__add_comment` | lier la PR dans l'issue, résumer le travail |

Git s'utilise en ligne de commande **dans le worktree** (`cd <path>` ou `git -C <path>`), avec
l'identité et les accès déjà configurés sur la machine.

## Règles absolues

- **Jamais de push sur la branche par défaut** (ni sur `main` / `master`) **ni sur une branche
  `release/*`**, jamais de `--force`, jamais de réécriture d'historique publié. Avant chaque
  `git push`, vérifie que la branche courante est bien la branche de l'issue.
- Travaille **uniquement dans le worktree** renvoyé par `cadence__repo_checkout` ; n'écris nulle
  part ailleurs (ni dans le dossier neutre, ni dans un autre clone).
- Pas de secret dans le code, les commits ou la PR. Pas d'accès réseau autre que `git fetch` /
  `git push` vers `origin`, l'installation des dépendances du projet et les outils du plugin.
- Change le minimum nécessaire pour remplir les critères d'acceptation ; respecte les
  conventions du dépôt (CLAUDE.md, AGENTS.md, README, style du code voisin).

## Étapes

1. **Analyse.** Lis l'issue (`get_issue`) et le dépôt (`get_repository`). Si l'issue n'a pas de
   critères d'acceptation exploitables, déduis-les du titre et de la description et écris-les dans
   la PR. Établis un plan court : approche, fichiers à toucher.

   **Architecture.** Lis l'architecture (`architecture_get`, ou `architecture/ARCHITECTURE.md` du
   worktree) : place chaque fichier dans la couche prévue, à l'emplacement prévu, n'utilise que les
   couches autorisées (`uses`), applique les règles et conventions du service. Si l'issue demande
   quelque chose que l'architecture ne prévoit pas, suis l'esprit le plus proche et signale-le
   dans la PR (« Points à relire »).

   **Design.** Si l'issue cite un design (`design/<id>/…`) ou si un design du projet
   (`list_designs`) montre l'écran concerné, ouvre ses pages dans le worktree (sous son `path`) et
   reproduis-en la structure, les textes et les valeurs (tailles, couleurs, espacements) en
   respectant les conventions du code existant (composants et tokens du projet plutôt que des
   valeurs en dur quand le projet en a).

   **Base de travail.** Avec les sprints automatiques, chaque sprint est une version qui a sa
   branche `release/<version>` : les branches d'issue en partent et y sont fusionnées, puis Cadence
   fusionne la branche de release dans la branche par défaut à la fin du sprint. La base est :
   - `sprints.release_branch` (renvoyé par `get_repository`) si la version de l'issue
     (`milestone`) est `sprints.current_version` ;
   - sinon `release/<version de l'issue>` si cette branche existe sur `origin`
     (`git ls-remote --heads origin release/<version>`) ;
   - sinon la branche par défaut (pas de sprints automatiques, ou issue hors sprint).
2. **Worktree et branche.**
   - `cadence__repo_checkout` avec `{ "repo": "<repo>", "task": "issue-<numéro>" }` ; note le
     `path` renvoyé. Un appel répété pour la même tâche renvoie le même worktree (reprise).
   - Branche : `<type>/<numéro>-<slug>` (type de l'issue, `feat` par défaut ; slug du titre en
     minuscules ASCII, tirets, 40 caractères au plus), ex. `fix/156-message-erreur-quota`.
   - Dans le worktree :
     ```sh
     git fetch origin
     git switch <branche>  ||  git switch -c <branche> origin/<base>
     ```
     (la branche existe déjà en cas de reprise). Vérifie `git status` : pas de changement étranger.
   - Passe l'issue en cours : `update_issue` avec `status: "doing"`.
3. **Implémentation** dans le worktree.
4. **Conformité.** Avant de commiter, relis ton diff contre l'architecture : fichiers dans les
   bonnes couches, imports autorisés seulement, règles et conventions respectées. Corrige les
   écarts ; ceux que tu laisses (code existant, hors périmètre) vont dans la PR, section
   « Architecture ».
5. **Tests.** Lance le build et les tests pertinents du dépôt (ceux des parties touchées au
   minimum) et corrige ce que tes changements ont cassé. Note le résultat : réussis, échecs
   restants, ou non lancés (et pourquoi).
6. **Commits.** Un ou quelques commits cohérents, message
   `<type>(#<numéro>): <titre de l'issue>` + un corps court qui résume le changement. Vérifie
   `git status` : rien d'oublié, rien d'étranger à l'issue (fichiers générés, `.env`…).
7. **Push de la branche** : `git push -u origin <branche>` (après avoir vérifié la branche).
8. **Pull request en brouillon** avec `create_pull_request` : `repo`, `head` = la branche,
   `base` = la base choisie à l'étape 1 (branche de release ou branche par défaut), `draft: true`,
   titre `<type>(#<numéro>) : <titre>`, corps :

   ```
   Ferme #<numéro>

   ### Plan
   …
   ### Ce qui a changé
   …
   ### Tests
   …
   ### Architecture
   …(conforme, ou écarts laissés et pourquoi)
   ### Points à relire
   …(choix faits sans pouvoir demander, limites connues)

   _PR ouverte par le skill « Implémenter » de Cadence._
   ```

   Si l'outil répond qu'il n'est pas disponible, utilise `gh pr create --draft --repo <repo>` s'il
   est installé et authentifié ; sinon donne l'URL de comparaison
   `https://github.com/<repo>/compare/<base>...<branche>?expand=1` dans ton résultat.
9. **Suivi.** `update_issue` avec `status: "review"`, puis `add_comment` sur l'issue avec le lien
   de la PR et le résultat des tests. Laisse la PR en brouillon : l'utilisateur la sort du
   brouillon après relecture.
10. **Résultat.** Termine par un résumé court : dépôt, branche, PR, fichiers modifiés, tests. En
   cas d'échec, dis à quelle étape et ce qui reste dans le worktree (ne le supprime pas : Cadence
   le gère).
