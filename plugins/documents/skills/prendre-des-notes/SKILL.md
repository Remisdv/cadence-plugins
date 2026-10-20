---
name: prendre-des-notes
description: Résume un chapitre ou un document de la bibliothèque en une note de cours structurée (titres, listes, définitions, formules), chaque idée liée à sa source (document + page), enregistrée comme note Markdown dans le chapitre. À utiliser depuis le bouton « Résumer en note » ou quand l'étudiant demande une fiche, un résumé ou des notes sur un cours.
---

# Prendre des notes

Tu rédiges une **fiche de révision** fidèle aux cours de l'étudiant, en français, et tu
l'enregistres comme **note** de la bibliothèque (fichier Markdown du dossier des cours, que
l'étudiant retouche ensuite dans l'éditeur de Cadence). Tu tournes souvent en fond : la note est
le résultat.

## Contexte reçu

`{ "subject": "<matière>", "chapter": "<chapitre>", "document": "<document>", "note": "<note>" }`,
`document` et `note` optionnels (type de contexte `chapitre`). Avec `note`, complète cette note
existante au lieu d'en créer une.

## Outils

| Outil | Usage |
| --- | --- |
| `documents__list_documents` | documents du chapitre (les notes ont `kind: "note"`) |
| `documents__read_pages` | lire les cours (20 pages par appel, suivre `next_page`) ; chaque page a son `link` |
| `documents__list_notes` | notes existantes du chapitre (éviter un doublon) |
| `documents__get_note` | lire une note et sa `revision` |
| `documents__create_note` | créer la note (`subject`, `chapter`, `title`, `content` en Markdown) |
| `documents__update_note` | remplacer ou compléter (`append: true`) une note, avec la `revision` lue |

## Démarche

1. Lis tout le chapitre (ou le document), pas seulement le début. Ne résume pas les autres notes
   de l'étudiant : elles ne sont pas des sources.
2. Structure la fiche avec des titres `#` à `###` : chaque titre ouvre une **section**, que l'IA
   et la recherche citent ensuite (une page de la note = une section). Un titre par grande notion
   du cours, dans l'ordre du cours.
3. Sous chaque titre : l'essentiel en listes courtes, les **définitions** en citation `>`, les
   formules avec le sens de chaque symbole, les méthodes en liste numérotée, une comparaison en
   tableau quand elle s'y prête. Termine par une liste de cases `- [ ]` « À revoir » si des
   points restent obscurs.
4. **Lie chaque idée à sa source** avec le `link` de la page lue :
   `[Cours 1, p. 12](cadence:documents/document?doc=atomes&page=12)` (« diapo » pour un
   PowerPoint, « bloc » pour Word, Markdown et texte). Rien qui ne soit pas dans les cours ; un
   complément général se signale « (hors cours) ».
5. Enregistre :
   - sans `note` : `create_note` dans le chapitre, titre « Fiche — <chapitre> » (ou
     « Fiche — <document> ») ; si une fiche de ce titre existe déjà (`list_notes`), complète-la ;
   - avec `note` : `get_note`, puis `update_note` avec sa `revision` (`append: true` si elle
     contient déjà du texte de l'étudiant, à ne jamais effacer).
6. Résultat : titre de la note, sections créées, documents et pages couverts, et le lien de la
   note (`cadence:documents/document?doc=<id>`).

N'accède aux cours que par les outils `documents__*` et ne modifie aucun autre fichier.
