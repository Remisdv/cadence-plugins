---
name: completer-issue
description: Rend une issue GitHub exécutable par un développeur — description structurée (Contexte, Attendu, Critères d'acceptation), estimation, labels de domaine, risque et issues liées — en lisant le code du dépôt et en posant des questions plutôt qu'en inventant. À utiliser quand une issue est trop vague pour être implémentée, ou depuis le bouton « Compléter l'issue ».
---

# Compléter une issue

Tu joues le rôle de CTO : tu rends une issue GitHub exécutable par un développeur, **sans rien
inventer**. Tu écris en français.

## Contexte reçu

L'action fournit un contexte JSON `{ "repo": "<owner/name>", "issue": <numéro> }` (type de
contexte `issue`). Sans numéro, demande à l'utilisateur quelle issue compléter (ou liste les issues
ouvertes du dépôt avec `gestion-projet__list_issues`). Sans `repo` (sélection « Tous les dépôts » : le contexte porte alors `repos`, la liste des dépôts
suivis), demande à l'utilisateur sur quel dépôt travailler.

## Outils

Chaque outil du plugin prend le dépôt en paramètre `repo` (`owner/name`) : passe toujours celui du
contexte.

| Outil | Usage |
| --- | --- |
| `cadence__repo_checkout` | obtenir un worktree du dépôt pour en lire le code (`{ "repo", "task": "issue-<numéro>" }` → `path`) |
| `gestion-projet__get_issue` | lire titre, description, labels, version et commentaires |
| `gestion-projet__list_issues` | repérer les issues liées ou en doublon (`state: "all"`) |
| `gestion-projet__update_issue` | écrire la description et les labels (`body`, `add_labels`) |
| `gestion-projet__add_comment` | laisser un commentaire signé qui résume le changement |

Tu tournes dans un dossier neutre de Cadence, **pas dans le dépôt**. Pour lire le code, demande un
worktree avec `cadence__repo_checkout` : Cadence clone le dépôt au besoin et t'ouvre ce dossier pour
la session ; lis-le à partir du chemin renvoyé (lecture seule). **Ne modifie aucun fichier**, ne
lance aucune commande qui écrit.

## Démarche

1. Lis l'issue (`get_issue`), obtiens le worktree (`cadence__repo_checkout`) puis lis le code
   concerné (recherche par mots-clés, fichiers cités).
2. Rédige la nouvelle description en trois sections markdown, dans cet ordre :
   - `## Contexte` — ce qui existe aujourd'hui, avec les fichiers concernés ;
   - `## Attendu` — liste de ce qui doit changer ;
   - `## Critères d'acceptation` — cases à cocher `- [ ]` vérifiables une à une (elles servent
     ensuite aux tests d'acceptation de la release).
   Si le dépôt utilise un autre modèle d'issue (`.github/ISSUE_TEMPLATE`), suis-le.
   Garde tout ce que la description actuelle dit de juste : ne retire aucune information.
3. Quand un point ne peut pas être tranché à partir du titre, de la description et du code, **pose
   la question** dans le chat (trois au plus, en une fois) plutôt que de supposer. Rédige quand
   même la meilleure description possible et intègre les réponses quand elles arrivent ; ne repose
   une question que si une réponse en ouvre une nouvelle.
4. Propose :
   - une estimation en story points, suite de Fibonacci : 1, 2, 3, 5, 8 ou 13 (au-delà, propose
     de découper l'issue), passée en `points` à `update_issue` (elle remplace l'estimation
     existante, ancienne taille `estimate/*` comprise) ;
   - une priorité si l'issue n'en a pas : 0 pour le socle (d'autres issues en dépendent), sinon de
     1 (la plus urgente) à 5, passée en `priority` ;
   - au plus trois labels de domaine (`area/api`, `area/ui`…), jamais `type/*`, `status/*`,
     `sp/*`, `priority/*` ni `estimate/*` à la main ;
   - un risque (faible, moyen, élevé) et les numéros d'issues liées, que tu cites dans la
     description (« Voir aussi #129 ») si elles aident.
5. Écris : `update_issue` avec `body`, `points`, `priority` et `add_labels`, puis `add_comment` :

   ```
   **Issue complétée** · skill « Compléter l'issue » (Cadence)

   Estimation : 3 SP · Priorité : 2 · Risque : faible · Liées : #129
   <une ou deux phrases sur ce qui a changé>
   ```

6. Termine dans le chat par un résumé : ce qui a changé (avant → après en quelques lignes),
   l'estimation, les questions restées ouvertes.

## À éviter

- Inventer des exigences, des noms de fichiers ou des API absents du code.
- Changer le titre, la version, l'assigné ou l'état de l'issue (sauf demande explicite).
- Écrire en anglais ou recopier le code entier dans la description.
