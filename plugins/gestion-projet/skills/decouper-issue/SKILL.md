---
name: decouper-issue
description: Découpe une issue GitHub trop grosse (plus de 13 story points, ou 8 et 13 quand elle regroupe plusieurs livrables) en sous-issues tenant chacune dans un sprint, créées dans la même version et reliées à l'issue d'origine par une liste de tâches. À utiliser depuis le bouton « Découper l'issue » ou quand une issue mélange plusieurs changements indépendants.
---

# Découper une issue

Tu découpes une issue en sous-issues livrables séparément. Tu écris en français.

## Contexte reçu

`{ "repo": "<owner/name>", "issue": <numéro> }` (type de contexte `issue`). Sans `repo` (sélection « Tous les dépôts » : le contexte porte alors `repos`, la liste des dépôts
suivis), demande à l'utilisateur sur quel dépôt travailler.
Les sous-issues sont créées dans le même dépôt que l'issue d'origine.

## Outils

Chaque outil du plugin prend le dépôt en paramètre `repo` (`owner/name`) : passe toujours celui du
contexte.

| Outil | Usage |
| --- | --- |
| `cadence__repo_checkout` | si besoin, worktree du dépôt pour lire le code (`{ "repo", "task": "issue-<numéro>" }` → `path`) |
| `gestion-projet__get_issue` | lire l'issue d'origine (description, critères, version, type) |
| `gestion-projet__list_issues` | vérifier qu'aucune issue existante ne couvre déjà une partie |
| `gestion-projet__create_issue` | créer chaque sous-issue (`type`, `category`, `milestone`, `labels`) |
| `gestion-projet__update_issue` | ajouter la liste des sous-issues à l'issue d'origine |
| `gestion-projet__add_comment` | commenter le découpage |

Tu tournes dans un dossier neutre de Cadence, pas dans le dépôt. Si tu dois lire le code, demande le
worktree avec `cadence__repo_checkout` et lis-le à partir du chemin renvoyé, sans rien modifier.

## Démarche

1. Lis l'issue et repère les livrables indépendants : chacun doit pouvoir être relu, testé et
   fusionné seul, et tenir en 8 story points au plus.
2. Propose le découpage dans le chat (titres, une phrase chacun, ordre conseillé, dépendances) et
   laisse l'utilisateur l'ajuster. Deux à six sous-issues ; si l'issue est déjà petite, dis-le et
   arrête-toi.
3. Crée chaque sous-issue avec `create_issue` :
   - même version (`milestone`), même type et même catégorie (`category`) que l'issue
     d'origine, sauf raison claire ;
   - description en trois sections `## Contexte` (avec « Partie de #<origine> »), `## Attendu`,
     `## Critères d'acceptation` (cases `- [ ]`), reprenant les critères d'origine qui la
     concernent ;
   - les labels de domaine de l'origine, `points` (1, 2, 3, 5 ou 8) et `priority` : celle de
     l'origine, ou 0 pour une sous-issue dont les autres dépendent.
4. Ajoute à la fin de la description d'origine (`update_issue`, `body` complet) :

   ```
   ## Découpage
   - [ ] #201 Titre
   - [ ] #202 Titre
   ```

   puis un commentaire signé « skill « Découper l'issue » (Cadence) ».
5. Résume dans le chat les issues créées avec leurs numéros.

Ne ferme pas l'issue d'origine : elle sert de suivi.
