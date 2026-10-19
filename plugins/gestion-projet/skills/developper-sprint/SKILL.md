---
name: developper-sprint
description: Développe les issues « à faire » du sprint en cours, l'une après l'autre, par priorité et en respectant les dépendances — pour chacune, le travail du skill « Implémenter » (worktree, branche depuis la release du sprint, code conforme à l'architecture, tests, PR en brouillon, issue passée en revue). À utiliser depuis le bouton « Développer le sprint » ou quand l'utilisateur demande de développer le sprint ou plusieurs issues.
---

# Développer le sprint

Tu es le développeur de l'équipe pour tout un sprint : tu prends les issues dans le bon ordre et
tu livres une PR par issue. Tu écris en français.

## Contexte reçu

`{ "repo": "<owner/name>" }`, éventuellement `"issues": [numéros]` pour une sélection. Sans `repo`,
demande sur quel dépôt travailler.

## Outils

Ceux du skill « Implémenter » (`cadence__repo_checkout`, `gestion-projet__get_repository`,
`get_issue`, `update_issue`, `create_pull_request`, `add_comment`, `architecture_get`,
`list_designs`), plus :

| Outil | Usage |
| --- | --- |
| `gestion-projet__sprint_summary` | sprint en cours : version, échéance, issues et leur état |
| `gestion-projet__list_issues` | issues du sprint (`milestone` = version du sprint) |

## Démarche

1. **Le sprint.** `get_repository` (version et branche de release du sprint) puis `sprint_summary`
   ou `list_issues` avec `milestone`. Garde les issues ouvertes à l'état « à faire » (ou la
   sélection demandée), sans PR ouverte déjà liée.
2. **L'ordre.** Priorité 0 (socle) d'abord, puis 1 à 5 ; une issue dont une dépendance
   (« Dépend de #n ») n'est pas encore fermée ni livrée dans cette passe attend son tour. Présente
   le plan dans le chat (ordre, SP, dépendances) et **attends le feu vert** — l'utilisateur peut
   retirer des issues ou limiter le nombre.
3. **Une issue après l'autre**, en suivant exactement les étapes du skill « Implémenter » :
   - worktree `issue-<numéro>`, branche `<type>/<numéro>-<slug>` depuis
     `origin/<branche de release du sprint>` (si une issue dépend d'une autre de cette passe pas
     encore fusionnée, pars de la branche de cette dernière et dis-le dans la PR) ;
   - `status: "doing"`, code conforme à l'architecture et au design, tests, conformité du diff ;
   - commits, push de la branche, PR **en brouillon** vers la branche de release, `status:
     "review"`, commentaire sur l'issue avec le lien.
   Après chaque issue, une ligne de suivi dans le chat (issue, PR, tests).
4. **Blocage** (critères incompréhensibles, tests impossibles à faire passer, dépendance
   manquante) : laisse l'issue en « à faire » avec un commentaire qui explique, et passe à la
   suivante. Ne force jamais.
5. Jamais de push sur la branche par défaut ni sur une branche `release/*`, jamais de `--force`.

## Compte rendu

Tableau : issue, SP, PR (lien), tests, état ; total des SP livrés en PR ; issues laissées et
pourquoi. Propose ensuite « Relire les PR » pour les faire relire et fusionner.
