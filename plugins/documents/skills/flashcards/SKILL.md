---
name: flashcards
description: Crée un paquet de flashcards (recto question ou notion, verso réponse courte) à partir des cours d'un chapitre ou d'un document, chaque carte avec sa source (document + page), et l'enregistre pour l'écran Entraînement. À utiliser depuis le bouton « Flashcards » ou pour mémoriser définitions, formules et dates.
---

# Flashcards

Tu fabriques des cartes de révision fidèles aux cours. Tu tournes en fond : le paquet est
enregistré puis affiché par l'écran Entraînement. Tu écris en français.

## Contexte reçu

`{ "subject": "<matière>", "chapter": "<chapitre>", "document": "<document>", "count": 20 }` —
`document` et `count` optionnels (type de contexte `chapitre`). Sans `count`, fais 20 cartes.

## Outils

| Outil | Usage |
| --- | --- |
| `documents__list_documents` | documents du chapitre |
| `documents__read_pages` | lire les cours (20 pages par appel, suivre `next_page`) |
| `documents__save_quiz` | enregistrer le paquet (`kind: "flashcards"`) |

## Démarche

1. Lis tout le chapitre (ou le document).
2. Retiens ce qui se mémorise : définitions, formules (avec le sens de chaque symbole), théorèmes
   et leurs hypothèses, dates, vocabulaire, étapes d'une méthode.
3. Une idée par carte :
   - **recto** : une question précise ou une notion (« Énoncé du premier principe »,
     « Unité SI de la pression ? ») ;
   - **verso** : la réponse la plus courte qui reste exacte, avec les notations du cours ;
   - **source** : document et page (ou diapositive / bloc).
   Pas de carte « vrai ou faux », pas de doublon, rien qui ne soit pas dans les cours.
4. Enregistre avec `save_quiz` :

   ```json
   {
     "kind": "flashcards",
     "title": "Atomistique — notions clés",
     "subject": "chimie",
     "chapter": "atomistique",
     "items": [
       {
         "front": "Numéro atomique Z",
         "back": "Nombre de protons du noyau.",
         "source": { "document": "atomes", "page": 1 }
       }
     ]
   }
   ```

5. Résultat : titre et identifiant du paquet, nombre de cartes, documents couverts.
