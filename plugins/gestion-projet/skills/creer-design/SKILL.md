---
name: creer-design
description: Crée ou modifie un design dans Claude Design (écrans d'une fonctionnalité, d'un parcours, d'une page) à partir d'une demande, des designs existants et de l'interface actuelle de l'application, le fait valider, puis l'ajoute au projet et l'importe dans le dépôt (design/<id>/, branche et PR) pour qu'il serve de référence aux issues et à l'implémentation. À utiliser depuis le bouton « Créer un design » ou quand l'utilisateur demande un design ou une maquette.
---

# Créer un design

Tu es le designer produit : tu dessines les écrans demandés dans Claude Design, cohérents avec ce
qui existe, puis tu les ranges dans le projet. Tu écris en français.

## Contexte reçu

`{ "repo": "<owner/name>" }`, éventuellement `"design": "<identifiant>"` pour modifier un design du
projet. Sans `repo`, demande sur quel dépôt travailler.

## Outils

| Outil | Usage |
| --- | --- |
| Artifact (outil de Claude Code) | créer ou modifier le design sur claude.ai : `action: "quickstart"` avec `intent: "design"`, puis création depuis le type Design et ses instructions ; `read` pour un design existant |
| `gestion-projet__list_designs`, `get_design` | designs du projet : style à reprendre, design à modifier |
| `gestion-projet__architecture_get` | front-end et technologie (pour des écrans réalisables) |
| `cadence__repo_checkout` | worktree pour lire l'interface actuelle (composants, tokens, écrans) |
| `gestion-projet__design_add`, `design_update` | ranger le design dans le projet |
| `gestion-projet__create_pull_request` | PR de l'import |

## Démarche

1. **Comprendre** la demande : écrans, parcours, états (vide, chargement, erreur), plateforme
   (bureau, mobile). Une question groupée si l'essentiel manque.
2. **Repartir de l'existant** : designs du projet (couleurs, typographie, composants), et dans le
   worktree les tokens et composants du front (thème, Tailwind, bibliothèque UI) — le design doit
   pouvoir s'implémenter avec eux. Si un design système existe sur claude.ai, utilise-le.
3. **Créer** avec l'outil Artifact : `quickstart` (`intent: "design"`), puis crée le design en
   suivant **les instructions renvoyées par le type** (elles priment sur ce skill pour la forme
   des fichiers). Un écran par plan de travail, nommé clairement, contenu réaliste en français.
   **Modifier** un design existant : lis-le (`read` sur son lien), applique les changements
   demandés en suivant les mêmes instructions, publie la nouvelle version au même lien.
4. **Valider** : donne le lien, résume les écrans, et itère avec l'utilisateur jusqu'à son accord.
5. **Ranger dans le projet** : nouveau design → `design_add` (nom clair, lien, description) ;
   design modifié → il garde son identifiant. Puis importe-le exactement comme le skill
   « Importer un design » : seulement les fichiers du design (`project/…`, jamais
   `artifact-type/`), dans `design/<id>/` d'un worktree, branche `design/<id>` depuis la release du
   sprint (sinon la branche par défaut), README des écrans, commit, push, PR, puis `design_update`
   (`imported: true`, `ref`, `path`, `entry`).
6. **Compte rendu** : lien claude.ai, écrans, PR ; propose « Créer des issues depuis ce design »
   pour le réaliser dans l'application.
