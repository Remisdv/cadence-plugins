# Documents

Plugin officiel de Cadence (catégorie **Études**) pour réviser ses cours : PDF, Word (.docx), PowerPoint (.pptx),
Markdown et texte, rangés en **Matière → Chapitre → Documents**. L'IA lit les cours **à la
demande** (pas d'index d'embeddings) et **cite le document et la page** de ce qu'elle avance.
Entraînement : QCM, questions ouvertes corrigées par l'IA, flashcards.

## Configuration

Il n'y a pas d'espace de travail : le plugin a une seule bibliothèque, ses réglages sont globaux et
il gère lui-même son contexte (matières et chapitres).

- **Dossier des cours** (étape de setup `setup-dossier`) : le dossier où sont rangés les cours,
  enregistré en chemin absolu dans le réglage `dossier_cours`. Les chemins relatifs donnés à
  l'import sont lus depuis ce dossier.
- **Réglages globaux** (`settings.schema.json`, reçus en `CADENCE_SETTINGS` puis
  `notifications/cadence/settings`) : `dossier_cours`, `questions_par_qcm` (10),
  `cartes_par_paquet` (20).

## Écrans

| Vue | État |
| --- | --- |
| Bibliothèque (`bibliotheque`) | matières, chapitres, documents ; import de fichiers ; « Poser une question » par chapitre |
| Entraînement (`entrainement`) | entraînements enregistrés, filtrés par type ; **QCM** à passer (une question à la fois, touches 1 à 9, correction par le serveur avec explication et source) ; **flashcards** à retourner (espace, puis 1 « À revoir » / 2 « Je savais »), tour de rattrapage des cartes manquées ; **questions ouvertes** lancées dans le chat ; **historique des scores**. Paramètre de route `quiz` : ouvre un entraînement |

Depuis la bibliothèque, le menu « S'entraîner » d'un chapitre lance « Générer un QCM »,
« Flashcards » ou « Questions ouvertes ». L'écran se met à jour sur les événements du serveur
(`notifications/cadence/event`) : `quiz-saved` (`{ id, kind }`) quand un entraînement est
enregistré, `result-saved` (`{ quiz, score, total }`) quand un score l'est.

## Actions et skills

| Action | Skill | Mode | Contexte |
| --- | --- | --- | --- |
| Poser une question | `repondre-cours` | chat | `{ "subject", "chapter", "document"? }` |
| Générer un QCM | `generer-qcm` | fond | `{ "subject", "chapter", "document"?, "count"? }` |
| Questions ouvertes | `questions-ouvertes` | chat | `{ "subject", "chapter", "count"? }` |
| Flashcards | `flashcards` | fond | `{ "subject", "chapter", "document"?, "count"? }` |

## Outils MCP (`documents__<outil>`)

| Outil | Rôle |
| --- | --- |
| `list_subjects`, `list_chapters`, `list_documents` | parcourir la bibliothèque |
| `import_document` | extraire le texte d'un fichier et le ranger (matière et chapitre créés au besoin) |
| `read_pages` | texte d'une plage de pages depuis le cache (20 par appel) |
| `search` | recherche plein texte sans accents ni casse : quelles pages lire |
| `save_quiz`, `list_quizzes`, `get_quiz` | entraînements générés ; `save_quiz` vérifie le format des éléments (QCM : `question`, `choices`, `answer` ; flashcards : `front`, `back` ; questions ouvertes : `question`) |
| `submit_qcm` | corrige un QCM à partir des indices choisis (1 point par bonne réponse), enregistre le score et renvoie la correction |
| `save_result` | réponses corrigées et score (questions ouvertes, tour de flashcards) |
| `list_results` | historique des scores, les plus récents d'abord |

Pages : une page de PDF ; une **diapositive** de PowerPoint ; pour Word, Markdown et texte, un
**bloc d'environ 3000 caractères** coupé entre deux paragraphes.

## Données

Dans `CADENCE_DATA_DIR` (`<données de l'app>/plugins-data/documents/`) : `library.json`,
`cache/<document>.json` (texte par page), `quizzes/<quiz>.json`, `results/<résultat>.json` (score,
total, réponses ou correction, bilan, rang d'enregistrement `seq`). Les fichiers d'origine ne sont
pas copiés : chaque document garde leur chemin absolu. Aucun accès réseau. L'IA tourne dans un
dossier neutre de Cadence et lit les cours par les outils ci-dessus.

## Développement

```sh
cargo test -p cadence-documents
pnpm --dir plugins/documents/ui dev
pnpm validate documents
```
