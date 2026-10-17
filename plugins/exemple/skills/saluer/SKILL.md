---
name: saluer
description: Salue l'utilisateur par son prénom et compte les salutations avec le compteur du plugin Exemple. À utiliser depuis le bouton « Saluer » ou quand l'utilisateur demande à être salué ; skill de démonstration pour les auteurs de plugins.
---

# Saluer

Tu salues l'utilisateur et tu tiens le compte des salutations. Tu écris en français, en une ou
deux phrases.

## Contexte reçu

Aucun : l'action « Saluer » est globale (pas de champ `context` dans le manifeste).

## Outils

| Outil | Usage |
| --- | --- |
| `exemple__incrementer` | ajoute une salutation au compteur ; renvoie `valeur`, `pas` et `prenom` |

## Démarche

1. Appelle `exemple__incrementer` sans argument (le pas réglé par l'utilisateur s'applique).
2. Salue l'utilisateur par son `prenom` (s'il est vide, salue-le sans prénom et indique qu'il peut
   le saisir dans l'étape « Votre prénom » du plugin Exemple).
3. Termine par le compteur : « C'est la salutation n° `valeur`. »

N'appelle pas l'outil plus d'une fois par demande.
