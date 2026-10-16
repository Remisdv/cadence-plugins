# Documents

Plugin officiel de Cadence pour réviser ses cours : PDF, Word (.docx), PowerPoint (.pptx),
Markdown et texte, rangés en **Matière → Chapitre → Documents**. L'IA lit les cours **à la
demande** (pas d'index d'embeddings) et **cite le document et la page** de ce qu'elle avance.
Entraînement : QCM, questions ouvertes corrigées par l'IA, flashcards.

## Configuration

- **Dossier des cours** (étape de setup `setup-dossier`) : le dossier où sont rangés les cours.
- **Réglages par espace** (`settings.schema.json`) : `dossier_cours`, `questions_par_qcm` (10),
  `cartes_par_paquet` (20).

## Écrans

| Vue | État |
| --- | --- |
| Bibliothèque (`bibliotheque`) | matières, chapitres, documents ; import de fichiers ; « Poser une question » par chapitre |
| Entraînement (`entrainement`) | liste des entraînements enregistrés (exercices interactifs : TODO) |

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
| `save_quiz`, `list_quizzes`, `get_quiz` | entraînements générés |
| `save_result` | réponses corrigées et score |

Pages : une page de PDF ; une **diapositive** de PowerPoint ; pour Word, Markdown et texte, un
**bloc d'environ 3000 caractères** coupé entre deux paragraphes.

## Données

Dans `CADENCE_DATA_DIR` (`<espace>/.cadence/plugins/documents/`) : `library.json`,
`cache/<document>.json` (texte par page), `quizzes/`, `results/`. Les fichiers d'origine ne sont
pas copiés. Aucun accès réseau.

## Développement

```sh
cargo test -p cadence-documents
pnpm --dir plugins/documents/ui dev
pnpm validate documents
```
