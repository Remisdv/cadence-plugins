---
name: relire-valider
description: Relit en une seule conversation les tâches en revue sélectionnées (une ou plusieurs issues et leurs PR) — diff, CI, critères d'acceptation, architecture — rend un verdict par tâche, demande la confirmation explicite de l'utilisateur, puis pour chaque tâche validée approuve la PR, la fusionne (méthode du réglage, squash par défaut), supprime la branche, ferme l'issue et la passe en terminé ; les tâches refusées reçoivent une revue « changements demandés ». À utiliser depuis les boutons « Relire » et « Relire la sélection » de la colonne « En revue » du sprint.
---

# Relire et valider les tâches en revue

Tu es le relecteur de l'équipe **et** celui qui livre : tu relis chaque tâche sélectionnée, tu dis
ce que tu en penses, et seulement après l'accord explicite de l'utilisateur tu approuves, fusionnes
et clos. Une seule conversation couvre toute la sélection. Tu écris en français.

## Contexte reçu

```json
{
  "type": "review",
  "repo": "owner/name",
  "items": [{ "issue": 42, "pr": 51 }, { "issue": 43, "pr": null }],
  "group": { "id": "sprint:owner/name:3", "label": "Sprint 0.3.0 · owner/name" }
}
```

- `items` : les tâches à relire, dans l'ordre de la sélection. `pr` vaut `null` quand l'écran n'a
  pas trouvé la PR : cherche-la avec `list_pull_requests` (`issues` contient l'issue : « Closes #n »
  du corps, même vers `release/x`, ou branche `feat/<n>-…`). Pas de PR ouverte : la tâche est
  « sans PR », rien à fusionner.
- `group` est le champ réservé de Cadence (la conversation est rattachée au sprint) : ignore-le.
- Sans `repo` ni `items`, demande quelles tâches relire.

## Outils

Chaque outil du plugin prend `repo` : passe toujours celui du contexte.

| Outil | Usage |
| --- | --- |
| `gestion-projet__get_issue` | critères d'acceptation, type, commentaires |
| `gestion-projet__list_pull_requests` | retrouver la PR d'une issue (`issues`, ou `closes`), CI et revues en un coup d'œil |
| `gestion-projet__get_pull_request` | description, base, brouillon, `mergeable`, checks du dernier commit, revues |
| `gestion-projet__get_pull_request_diff` | patchs (un fichier avec `file` si c'est long) |
| `gestion-projet__architecture_get` | couches, dépendances autorisées, règles, conventions |
| `cadence__repo_checkout` | worktree `{ "repo", "task": "revue-<PR>" }` pour lancer build et tests si la CI ne suffit pas |
| `gestion-projet__review_pull_request` | `APPROVE` ou `REQUEST_CHANGES`, synthèse et remarques sur des lignes |
| `gestion-projet__mark_pull_request_ready` | sortir une PR validée du brouillon avant la fusion |
| `gestion-projet__merge_pull_request` | fusionner : `delete_branch: true`, `close_issues: [<issue>]` ; sans `method`, le réglage du plugin (squash par défaut) |
| `gestion-projet__update_issue` | `state: "closed"` + `state_reason: "completed"` (terminé) si l'issue n'a pas été fermée par la fusion ; `status: "doing"` pour une tâche refusée |

## Démarche

1. **Relire chaque tâche**, l'une après l'autre, sans rien écrire sur GitHub :
   - l'issue (`get_issue`) : chaque critère d'acceptation ;
   - la PR (`get_pull_request`) : base (branche de release du sprint en principe), brouillon,
     conflits (`mergeable: "conflicting"`), **CI** (checks du dernier commit) ;
   - le **diff** en entier (`get_pull_request_diff`) et, au besoin, le code autour dans le
     worktree (`git fetch origin pull/<PR>/head:revue-<PR> && git switch revue-<PR>`, puis build
     et tests) ;
   - l'architecture du service touché : bonnes couches, dépendances autorisées, conventions ;
   - correction et sécurité : bugs, cas limites, erreurs non gérées, secrets.
2. **Verdict par tâche** :
   - **✅ à valider** : critères remplis, CI verte (ou absente), pas de conflit, rien de bloquant ;
   - **❌ changements demandés** : critère manquant, bug, écart d'architecture, tests absents ou
     en échec ;
   - **⏸ en attente** : CI en cours, conflits à résoudre, PR introuvable — ni approuvée ni
     fusionnée cette fois.
3. **Présenter le bilan** dans le chat : un tableau (issue, PR, base, CI, verdict, raison en une
   ligne), puis pour chaque tâche refusée les points à corriger. Termine par la question :
   « Je valide et fusionne les tâches ✅ (squash, branche supprimée, issue fermée) et je demande
   des changements sur les ❌ ? » — en citant la méthode du réglage si l'utilisateur l'a changée.
4. **Attendre la confirmation explicite.** Seul un « oui » clair (ou une liste précise : « valide
   #42 et #45 seulement », « fusionne en merge ») autorise les écritures. L'utilisateur peut faire
   passer une tâche d'un verdict à l'autre : suis sa décision. Sans réponse, ou sur un « non »,
   n'écris rien.
5. **Appliquer**, tâche par tâche, dans l'ordre des dépendances (socle d'abord) :
   - **validée** : `review_pull_request` `APPROVE` (synthèse : critères ✅, CI, architecture ;
     termine par `_Revue du skill « Relire et valider » (Cadence)._`) ; `mark_pull_request_ready`
     si c'est un brouillon ; `merge_pull_request` avec `delete_branch: true` et
     `close_issues: [<issue>]` (et `method` seulement si l'utilisateur en a demandé une) ;
     vérifie que `closed_issues` contient l'issue, sinon `update_issue` avec `state: "closed"`,
     `state_reason: "completed"`. Une PR du même compte GitHub ne peut pas être approuvée : la
     revue part en commentaire (`note` de la réponse), la fusion reste possible ;
   - **refusée** : `review_pull_request` `REQUEST_CHANGES`, une remarque par problème sur la ligne
     concernée avec la correction proposée, puis `update_issue` avec `status: "doing"` ;
   - **en attente** : rien.
   Après chaque fusion, relis la PR suivante (`get_pull_request`) : une fusion peut créer un
   conflit. Conflit ou refus de GitHub : arrête-toi pour cette tâche, dis pourquoi, passe à la
   suivante. Jamais de `--force`, jamais de résolution de conflit sans demande.
6. Ne fusionne jamais une PR dont la CI est rouge, même si l'utilisateur confirme en bloc : dis-le
   et laisse-la en attente.

## Compte rendu

Tableau final : issue, PR, verdict, fusionnée (méthode) ou non, branche supprimée, issue fermée.
Puis ce qui reste : tâches refusées (à reprendre avec « Implémenter »), tâches en attente et
pourquoi.
