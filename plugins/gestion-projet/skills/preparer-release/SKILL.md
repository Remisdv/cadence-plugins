---
name: preparer-release
description: Prépare la release d'une version close — build au tag dans un worktree détaché, un test d'acceptation par issue livrée (dérivé de ses critères), notes de version regroupées par type, puis release GitHub en brouillon avec le rapport de vérification. À utiliser depuis le bouton « Préparer la release » d'une version dont toutes les issues sont fermées.
---

# Préparer une release

Tu livres une version et tu vérifies ce qu'elle promet, sur ce que tu as construit. Tu tournes en
fond : décide seul, consigne tout dans ton rapport. Tu écris en français.

## Contexte reçu

`{ "version": "<titre du milestone>" }` (type de contexte `version`), ex. `{ "version": "0.1.2" }`.

## Outils

| Outil | Usage |
| --- | --- |
| `gestion-projet__get_repository` | branche par défaut et `tag_prefix` (préfixe des tags, `v` par défaut) |
| `gestion-projet__list_milestones` | retrouver la version, son nom et son état |
| `gestion-projet__list_issues` | issues de la version (`milestone`, `state: "all"`) |
| `gestion-projet__get_issue` | description et critères d'acceptation de chaque issue |
| `gestion-projet__create_release` | créer la release en brouillon avec les notes |
| `gestion-projet__add_comment` | signaler un test d'acceptation en échec sur son issue |

## Règles

- **Ne modifie pas le code source** : tu construis et tu vérifies seulement.
- Ne pousse rien, ne crée pas de tag à la main, ne publie pas la release : elle reste en
  **brouillon**, l'utilisateur la publie après lecture du rapport.
- Pas de réseau hors installation des dépendances du build et outils du plugin.

## Étapes

1. **Pré-vol.**
   - Retrouve la version (`list_milestones`, `state: "all"`) et ses issues (`list_issues` avec
     `milestone` et `state: "all"`).
   - S'il reste des issues **ouvertes**, arrête-toi : rapporte-les (numéro, titre) et explique qu'il
     faut les fermer ou les reporter avant la release.
   - Tag : `<tag_prefix><version>` (ex. `v0.1.2`). `git fetch --tags origin`. S'il existe, le build
     se fait sur ce tag ; sinon sur `origin/<branche par défaut>` et la release créera le tag sur ce
     commit (note son SHA).
2. **Build** dans un worktree détaché :
   ```sh
   echo ".cadence/" >> .git/info/exclude
   git worktree add --detach .cadence/releases/<tag> <tag ou origin/branche>
   ```
   Construis le livrable selon les conventions du dépôt (README, CLAUDE.md, scripts du
   gestionnaire de paquets) ; s'il ne produit pas de binaire, lance son build de production
   habituel. Note les commandes, plateformes et artefacts produits (chemins relatifs). Un build en
   échec arrête la préparation : rapporte l'erreur.
3. **Tests d'acceptation**, un par issue fermée de la version :
   - critères = cases à cocher (`- [ ]`, `- [x]`) de la section « Critères d'acceptation » de la
     description ; sans cette section, toutes les cases de la description ; sans case, le titre ;
   - vérifie chaque critère sur ce que tu viens de construire (lance le binaire, les tests ou les
     commandes utiles ; lis le code seulement si rien d'autre n'est possible). Ne corrige rien ;
   - verdict : **réussi**, **échec** ou **non vérifiable**, avec ce que tu as constaté en une ou deux
     phrases.
4. **Notes de version** en markdown, sans les issues en échec :

   ```
   ## <tag> — <nom de la version, s'il y en a un>

   ### Nouveautés          (type/feat)
   - Titre (#12)
   ### Corrections         (type/fix)
   ### Performances        (type/perf)
   ### Documentation       (type/docs)
   ### Maintenance         (type/chore et issues sans type)
   ```

   N'écris que les sections non vides ; sans aucune issue livrée : « Aucune issue livrée sur cette
   version. »
5. **Release** : `create_release` avec `version`, `notes`, `draft: true` (et `target` = SHA si le
   tag n'existait pas). Si l'outil répond qu'il n'est pas disponible, utilise
   `gh release create <tag> --draft --notes-file <fichier>` s'il est installé et authentifié ;
   sinon mets les notes dans ton rapport.
6. **Échecs** : pour chaque test en échec, `add_comment` sur l'issue :
   `**Test d'acceptation en échec** pour <tag> · skill « Préparer la release » (Cadence)` + le
   critère et ce que tu as constaté. Ne rouvre pas l'issue : l'utilisateur tranche.
7. **Nettoyage** : `git worktree remove .cadence/releases/<tag>` (garde-le si le build a échoué).
8. **Rapport final** : tag, commit, build (commandes, artefacts), tableau des tests
   (`#n · titre · verdict · détail`), lien de la release en brouillon, et ce qui reste à décider.
