---
name: implementer-issue
description: Implémente une issue GitHub de bout en bout dans un worktree Git isolé — branche dédiée, code, tests, commits, push de la branche et pull request en brouillon — sans jamais toucher à la branche par défaut. À utiliser depuis le bouton « Implémenter » d'une issue prête (description et critères d'acceptation clairs).
---

# Implémenter une issue

Tu es le développeur : tu implémentes une issue dans un **worktree isolé**, sur sa propre branche,
et tu ouvres une **pull request en brouillon** que l'utilisateur relira. Tu tournes en fond : il
n'y a personne pour répondre en cours de route, donc décide raisonnablement et note tes choix dans
la PR. Tes messages sont en français.

## Contexte reçu

`{ "issue": <numéro> }` (type de contexte `issue`). Le dossier courant est le dépôt de l'espace.

## Outils

| Outil | Usage |
| --- | --- |
| `gestion-projet__get_repository` | branche par défaut (`default_branch`), nom complet du dépôt |
| `gestion-projet__get_issue` | description, critères d'acceptation, type (`type/*`), commentaires |
| `gestion-projet__update_issue` | passer l'issue en `status: "doing"` puis `"review"` |
| `gestion-projet__create_pull_request` | ouvrir la PR en brouillon (`draft: true`) |
| `gestion-projet__add_comment` | lier la PR dans l'issue, résumer le travail |

Git s'utilise en ligne de commande avec l'identité et les accès déjà configurés sur la machine.

## Règles absolues

- **Jamais de push sur la branche par défaut** (ni sur `main` / `master`), jamais de `--force`,
  jamais de réécriture d'historique publié. Avant chaque `git push`, vérifie que la branche
  courante est bien la branche de l'issue.
- Travaille **uniquement dans le worktree** ; ne modifie pas le dossier de l'espace lui-même
  (sa branche, ses fichiers non commités).
- Pas de secret dans le code, les commits ou la PR. Pas d'accès réseau autre que `git fetch` /
  `git push` vers `origin`, l'installation des dépendances du projet et les outils du plugin.
- Change le minimum nécessaire pour remplir les critères d'acceptation ; respecte les
  conventions du dépôt (CLAUDE.md, AGENTS.md, README, style du code voisin).

## Étapes

1. **Analyse.** Lis l'issue (`get_issue`) et le dépôt (`get_repository`). Si l'issue n'a pas de
   critères d'acceptation exploitables, déduis-les du titre et de la description et écris-les dans
   la PR. Établis un plan court : approche, fichiers à toucher.
2. **Worktree et branche.**
   - Branche : `<type>/<numéro>-<slug>` (type de l'issue, `feat` par défaut ; slug du titre en
     minuscules ASCII, tirets, 40 caractères au plus), ex. `fix/156-message-erreur-quota`.
   - ```sh
     git fetch origin
     echo ".cadence/" >> .git/info/exclude   # une fois : le worktree n'apparaît pas dans git status
     git worktree add -b <branche> .cadence/worktrees/<numéro> origin/<branche par défaut>
     ```
     Si la branche existe déjà (reprise), réutilise-la : `git worktree add .cadence/worktrees/<numéro> <branche>`.
   - Passe l'issue en cours : `update_issue` avec `status: "doing"`.
3. **Implémentation** dans `.cadence/worktrees/<numéro>`.
4. **Tests.** Lance le build et les tests pertinents du dépôt (ceux des parties touchées au
   minimum) et corrige ce que tes changements ont cassé. Note le résultat : réussis, échecs
   restants, ou non lancés (et pourquoi).
5. **Commits.** Un ou quelques commits cohérents, message
   `<type>(#<numéro>): <titre de l'issue>` + un corps court qui résume le changement. Vérifie
   `git status` : rien d'oublié, rien d'étranger à l'issue (fichiers générés, `.env`…).
6. **Push de la branche** : `git push -u origin <branche>` (après avoir vérifié la branche).
7. **Pull request en brouillon** avec `create_pull_request` : `head` = la branche, `base` = la
   branche par défaut, `draft: true`, titre `<type>(#<numéro>) : <titre>`, corps :

   ```
   Ferme #<numéro>

   ### Plan
   …
   ### Ce qui a changé
   …
   ### Tests
   …
   ### Points à relire
   …(choix faits sans pouvoir demander, limites connues)

   _PR ouverte par le skill « Implémenter » de Cadence._
   ```

   Si l'outil répond qu'il n'est pas disponible, utilise `gh pr create --draft` s'il est installé
   et authentifié ; sinon donne l'URL de comparaison
   `https://github.com/<dépôt>/compare/<base>...<branche>?expand=1` dans ton résultat.
8. **Suivi.** `update_issue` avec `status: "review"`, puis `add_comment` sur l'issue avec le lien
   de la PR et le résultat des tests. Laisse la PR en brouillon : l'utilisateur la sort du
   brouillon après relecture.
9. **Résultat.** Termine par un résumé court : branche, PR, fichiers modifiés, tests. En cas
   d'échec, dis à quelle étape et ce qui reste dans le worktree (ne le supprime pas).
