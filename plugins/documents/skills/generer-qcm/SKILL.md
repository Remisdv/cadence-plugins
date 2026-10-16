---
name: generer-qcm
description: Génère un QCM d'entraînement à partir des cours d'un chapitre (ou d'un document) — questions à choix multiples avec une seule bonne réponse, distracteurs plausibles, explication et source (document + page) — et l'enregistre pour l'écran Entraînement. À utiliser depuis le bouton « Générer un QCM » ou pour réviser un chapitre.
---

# Générer un QCM

Tu prépares un QCM fidèle aux cours de l'étudiant. Tu tournes en fond : pas de questions à
l'utilisateur, le QCM est enregistré puis affiché par l'écran Entraînement. Tu écris en français.

## Contexte reçu

`{ "subject": "<matière>", "chapter": "<chapitre>", "document": "<document>", "count": 10 }` —
`document` et `count` optionnels (type de contexte `chapitre`). Sans `count`, fais 10 questions.

## Outils

| Outil | Usage |
| --- | --- |
| `documents__list_documents` | documents du chapitre (id, titre, nombre de pages) |
| `documents__read_pages` | lire les pages (20 par appel, suivre `next_page`) |
| `documents__save_quiz` | enregistrer le QCM (`kind: "qcm"`) |

## Démarche

1. Liste les documents du chapitre (ou prends le document donné) et **lis-les en entier**.
2. Repère les notions importantes : définitions, propriétés, méthodes, résultats, pièges classiques.
   Répartis les questions sur tout le chapitre, du plus simple au plus exigeant.
3. Rédige chaque question :
   - une seule bonne réponse parmi 4 choix (3 à 5 si nécessaire), distracteurs plausibles, tirés
     d'erreurs fréquentes, jamais absurdes ni « toutes les réponses » ;
   - formulation autonome, sans « selon le document » ; notations du cours ;
   - une explication courte de la bonne réponse et de l'erreur des distracteurs principaux ;
   - la **source** : document et page (ou diapositive / bloc) où la réponse se trouve.
   N'invente rien qui ne soit pas dans les cours.
4. Enregistre avec `save_quiz` :

   ```json
   {
     "kind": "qcm",
     "title": "Atomistique — QCM 1",
     "subject": "chimie",
     "chapter": "atomistique",
     "sources": [{ "document": "atomes", "pages": [1, 2, 3] }],
     "items": [
       {
         "question": "Quelle est la charge du proton ?",
         "choices": ["+e", "−e", "0", "+2e"],
         "answer": 0,
         "explanation": "Le proton porte la charge élémentaire positive ; l'électron porte −e.",
         "source": { "document": "atomes", "page": 2 }
       }
     ]
   }
   ```

   `answer` est l'indice (à partir de 0) de la bonne réponse dans `choices`.
5. Résultat : titre et identifiant du QCM, nombre de questions, documents couverts.
