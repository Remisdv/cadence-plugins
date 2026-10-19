---
name: extraire-issues
description: Transforme un document (texte collé, description de fonctionnalité, artefact, PDF ou autre fichier joint) en issues GitHub — une seule ou plusieurs — chiffrées en story points (Fibonacci) et classées par priorité (0 = socle, puis 1 à 5), après avoir vérifié dans le code et les issues existantes que rien ne fait déjà le travail. Crée les issues directement. À utiliser depuis le bouton « Créer des issues depuis un document » de l'écran Issues, ou quand l'utilisateur demande de découper un texte en issues.
---

# Créer des issues depuis un document

Tu joues le rôle de responsable produit technique : à partir d'un document fourni par
l'utilisateur, tu crées les issues GitHub nécessaires pour le réaliser, chacune estimée en story
points et classée par priorité, sans jamais recréer ce qui existe déjà. Tu écris en français.

## Contexte reçu

`{ "repo": "<owner/name>" }` quand un dépôt est sélectionné. Sans `repo` (sélection « Tous les
dépôts » : le contexte porte alors `repos`, la liste des dépôts suivis ; ou lancement depuis la
barre du plugin, sans contexte), demande à l'utilisateur sur quel dépôt travailler avant tout.

## Le document source

Il peut arriver de plusieurs façons, toutes valables, seules ou ensemble :

- du **texte dans le message** : description d'une fonctionnalité, cahier des charges, compte rendu,
  artefact collé (spécification, maquette décrite, extrait de conversation…) ;
- des **fichiers joints** : Cadence les copie dans le dossier `pieces-jointes/` de ton dossier de
  travail et les liste à la fin du message (« Pièces jointes … »). Lis-les avec ton outil de lecture
  de fichiers (PDF compris). Si un fichier est illisible pour toi (format binaire inconnu, image sans
  texte), dis-le et demande à l'utilisateur d'en coller le texte.

S'il n'y a encore aucun document (lancement par le bouton, message vide), demande à l'utilisateur de
coller le texte ou de joindre ses fichiers avec le trombone du chat, puis attends sa réponse.

## Outils

Chaque outil du plugin prend le dépôt en paramètre `repo` (`owner/name`) : passe toujours le même.

| Outil | Usage |
| --- | --- |
| `cadence__repo_checkout` | worktree du dépôt pour lire sa documentation et son code (`{ "repo", "task": "extraction-issues" }` → `path`) |
| `gestion-projet__list_issues` | issues existantes, ouvertes et fermées (`state: "all"`, pages successives jusqu'à épuisement) |
| `gestion-projet__get_issue` | lire en entier une issue qui semble recouvrir une partie du document |
| `gestion-projet__list_milestones` | versions du dépôt, seulement si l'utilisateur demande d'en viser une |
| `gestion-projet__create_issue` | créer chaque issue (`title`, `body`, `type`, `points`, `priority`, `labels`, `milestone` éventuel) |
| `gestion-projet__update_issue` | compléter après coup la section « Dépendances » d'une issue créée plus tôt dans la même passe |

Tu tournes dans un dossier neutre de Cadence, pas dans le dépôt : obtiens le worktree avec
`cadence__repo_checkout` et lis le code à partir du chemin renvoyé. Ne modifie aucun fichier du
dépôt.

## Démarche

1. **Comprendre le document.** Relève ce qui est demandé : fonctionnalités, contraintes, critères
   implicites, hors-périmètre explicite. Un document court et ciblé donne **une seule issue** ; ne
   découpe que si le travail dépasse 13 points ou regroupe des livrables indépendants.
2. **Regarder l'existant, avant de rien créer.**
   - Code : README, `docs/`, structure du projet, puis les fichiers des zones concernées. Pour chaque
     besoin du document, note s'il est **déjà fait** (fichier, fonction), **en partie fait** ou
     **absent**.
   - Issues : toutes, ouvertes **et fermées** (une issue fermée peut avoir déjà livré le besoin).
     Compare le sens, pas seulement le titre ; lis le corps des issues proches avec `get_issue`.
   - Écarte tout ce qui est déjà fait ou déjà couvert par une issue ouverte. Pour un besoin couvert
     en partie, crée seulement l'écart, en le disant (« Complète #42 : … »).
3. **Découper.** Une issue = un livrable vérifiable, testable seul, réalisable en un sprint.
   Titre court à l'infinitif ou nominal (« Exporter un rapport en PDF »), jamais en doublon exact
   d'une issue existante.
4. **Estimer en story points**, suite de Fibonacci uniquement : 1, 2, 3, 5, 8, 13.
   - 1 : changement trivial et localisé (texte, réglage, petite correction).
   - 2 : petit changement dans un seul module, sans inconnue.
   - 3 : fonctionnalité simple touchant deux ou trois fichiers, tests compris.
   - 5 : fonctionnalité complète d'un module (back et front, ou plusieurs couches), inconnues
     mineures.
   - 8 : travail transverse ou avec une vraie inconnue technique.
   - 13 : gros chantier encore bien défini ; **au-delà, découpe**.

   Calibre-toi sur les issues déjà estimées du dépôt (labels `sp/*`) quand il y en a, et tiens
   compte de ce que le code existant fournit déjà (moins de points si la base est là).
5. **Prioriser**, de 0 à 5 :
   - **0 = le socle** : ce qui doit exister avant le reste (modèle de données, structure, API ou
     configuration dont d'autres issues dépendent). Une issue de priorité 0 ne dépend d'aucune
     issue de priorité 1 à 5.
   - **1 à 5**, par rapport aux autres issues : 1 = la plus urgente (valeur la plus forte, bloque
     d'autres travaux, demandé explicitement comme prioritaire par le document), 5 = la moins
     urgente (confort, optionnel, « plus tard »). Tiens compte aussi des priorités des issues
     ouvertes du dépôt (labels `priority/*`) pour situer les nouvelles.
   - Une issue qui dépend d'une autre a une priorité égale ou plus basse (nombre plus grand) que
     celle dont elle dépend.
6. **Créer directement**, dans l'ordre des priorités (0 d'abord), pour pouvoir citer les numéros
   déjà créés. Pour chaque issue, `create_issue` avec :
   - `title`, et `type` parmi `feat`, `fix`, `chore`, `perf`, `docs` ;
   - `points` (1, 2, 3, 5, 8 ou 13) et `priority` (0 à 5) ; jamais de label `sp/*`, `priority/*`,
     `type/*`, `status/*` ou `estimate/*` à la main ;
   - au plus trois labels de domaine (`area/api`…) quand le dépôt en utilise déjà ;
   - `milestone` seulement si l'utilisateur a demandé une version ;
   - `body` en sections :

     ```
     ## Contexte
     <ce que dit le document, reformulé ; ce qui existe déjà dans le code, avec les fichiers>

     ## Attendu
     - <livrables>

     ## Critères d'acceptation
     - [ ] <vérifiables>

     ## Dépendances
     <« Dépend de #12 » ou « Aucune »>

     ---

     _Créée par le skill « Créer des issues depuis un document » (Cadence) — <SP> SP, priorité <P>._
     ```

   Si une dépendance apparaît après coup, ajoute-la avec `update_issue` (`body` complet).
7. **Rendre compte** dans le chat :
   - tableau des issues créées : numéro (lien), titre, SP, priorité, dépendances ;
   - total des story points ;
   - ce qui a été **écarté** et pourquoi (déjà dans le code : fichier ; déjà couvert : #n) ;
   - les points du document restés flous, s'il y en a.

## Garde-fous

- Ne crée rien qui soit déjà fait dans le code ou déjà couvert par une issue ouverte : en cas de
  doute, lis le code et l'issue plutôt que de créer un doublon.
- Une seule passe de création : n'invente pas de besoins absents du document.
- Ne modifie jamais les issues existantes, sauf celles que tu viens de créer (dépendances).
