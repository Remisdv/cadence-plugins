# Documents

**Vos cours rangés par matière et chapitre, vos notes prises dans Cadence, et l'IA pour répondre en
citant la page, générer des QCM, poser des questions ouvertes et faire des flashcards.**

> **Captures bientôt.** Les écrans de Documents sont en cours de finition : les captures arriveront
> avec la prochaine version du plugin.

Plugin officiel, groupe **Études** du rail. Version 0.4.0.

## Un cas réel : réviser un partiel de réseaux

Une étudiante prépare son partiel de **Réseaux**. Elle a le polycopié du cours en PDF, les
diapositives en PowerPoint et quelques notes en Markdown.

1. **Ranger ses cours.** Dans **Bibliothèque**, « Importer » ajoute les fichiers et les range en
   **Matière → Chapitre** : « Réseaux » › « Routage IP ». Les fichiers restent dans son dossier de
   cours : Cadence ne les copie pas.
2. **Lire et prendre des notes.** Un clic ouvre le polycopié page par page. « Nouvelle note » ouvre un
   éditeur par blocs, façon Notion : `/` pour insérer un titre, une liste, un tableau, un bloc de code
   ou un **lien vers une page précise du cours**. Les notes sont de simples fichiers Markdown,
   modifiables aussi hors de Cadence. Sur une note vide, « Résumer en note » demande à l'IA d'en
   rédiger une première version à partir du chapitre.
3. **Poser ses questions.** « Poser une question » ouvre le chat sur le chapitre : « Quelle différence
   entre RIP et OSPF ? ». L'IA lit le cours et répond en **citant le document et la page**. Les
   citations sont cliquables et ouvrent la bonne page.
4. **S'entraîner.** « Générer un QCM » prépare en fond un QCM sur le chapitre. On le passe dans
   **Entraînement**, une question à la fois (touches 1 à 9) ; chaque correction donne l'explication et
   la source. « Flashcards » crée un paquet de cartes à retourner (espace, puis 1 « À revoir » ou 2
   « Je savais »), avec un tour de rattrapage des cartes manquées. « Questions ouvertes » fait poser
   les questions par l'IA, qui corrige les réponses dans le chat.
5. **Suivre sa progression.** L'historique des scores, dans Entraînement, montre ce qu'il reste à
   revoir avant le partiel.

## Les écrans

| Écran            | À quoi il sert                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| **Bibliothèque** | matières, chapitres, documents et notes ; import ; « Nouvelle note » et « Poser une question » par chapitre |
| **Notes**        | notes récentes, éditeur de notes, lecture d'un cours page par page                                          |
| **Entraînement** | QCM, flashcards et questions ouvertes enregistrés, historique des scores                                    |

Formats lus : PDF, Word (.docx), PowerPoint (.pptx), Markdown et texte.

## Ce que fait l'IA

| Action                 | Mode    | Ce qu'elle fait                                                      |
| ---------------------- | ------- | -------------------------------------------------------------------- |
| **Poser une question** | chat    | répond à partir des cours, en citant le document et la page          |
| **Générer un QCM**     | en fond | crée un QCM corrigé, avec une explication et une source par question |
| **Questions ouvertes** | chat    | pose des questions et corrige vos réponses                           |
| **Flashcards**         | en fond | crée un paquet de cartes à réviser                                   |
| **Résumer en note**    | en fond | rédige une note à partir d'un chapitre ou d'un document              |

L'IA lit les cours **à la demande**, sans index ni envoi de vos fichiers à un service tiers : elle
passe par votre IA de code habituelle.

## Démarrer

1. Dans Cadence, ouvrez le **catalogue** (icône en grille en bas du rail) et installez **Documents**.
2. Choisissez le **dossier des cours**, celui où vous rangez vos fichiers.
3. Dans **Bibliothèque**, importez un premier cours, ou commencez par une note.

## Données et réseau

Aucun accès réseau. La bibliothèque (matières, chapitres, entraînements) est enregistrée dans le
dossier de données du plugin ; vos cours et vos notes restent dans votre dossier des cours.

## Pour aller plus loin

- [Guide d'utilisation](../../docs/utilisation.md#3-documents).
- [Référence technique](TECHNIQUE.md) : écrans, éditeur de notes, actions et skills, outils MCP,
  données, développement du plugin.
