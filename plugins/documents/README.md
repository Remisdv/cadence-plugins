# Documents

Plugin officiel de Cadence (catégorie **Études**) pour réviser ses cours : PDF, Word (.docx), PowerPoint (.pptx),
Markdown et texte, rangés en **Matière → Chapitre → Documents**, et **notes** prises dans Cadence
(éditeur par blocs façon Notion, fichiers Markdown du dossier des cours). L'IA lit les cours et les
notes **à la demande** (pas d'index d'embeddings) et **cite le document et la page** de ce qu'elle
avance. Entraînement : QCM, questions ouvertes corrigées par l'IA, flashcards.

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
| Bibliothèque (`bibliotheque`) | matières, chapitres, documents et notes ; import de fichiers ; « Nouvelle note » et « Poser une question » par chapitre ; un clic ouvre le document |
| Notes (`document`) | sans paramètre : notes récentes et « Nouvelle note ». Paramètres `doc` (et `page`) : **éditeur** d'une note (la page désigne une section) ou **lecture** d'un cours page par page. Cible des liens `cadence:documents/document?doc=…&page=…` du chat et des notes |
| Entraînement (`entrainement`) | entraînements enregistrés, filtrés par type ; **QCM** à passer (une question à la fois, touches 1 à 9, correction par le serveur avec explication et source) ; **flashcards** à retourner (espace, puis 1 « À revoir » / 2 « Je savais »), tour de rattrapage des cartes manquées ; **questions ouvertes** lancées dans le chat ; **historique des scores**. Paramètre de route `quiz` : ouvre un entraînement |

### Éditeur de notes

Éditeur par blocs (TipTap / ProseMirror, embarqué dans le build, sans réseau) :

- **titre** de la note (nom du fichier `.md`), puis des blocs : titres 1 à 3, paragraphes, listes à
  puces ou numérotées, **cases à cocher**, citations, blocs de code, séparateur, **tableaux**
  (barre « + Ligne », « + Colonne »… quand le curseur y est) ;
- **`/`** ouvre le menu des blocs (filtré à la frappe, ↑ ↓ Entrée) ; **raccourcis Markdown** à la
  frappe : `# `, `## `, `### `, `- `, `1. `, `[] `, `> `, ```` ``` ````, `---`, `**gras**`,
  `*italique*`, `` `code` `` ;
- poignée à gauche de chaque bloc : **+** ajoute un bloc dessous, **⋮⋮** se glisse pour
  **réordonner** (ou Alt+↑ / Alt+↓) ;
- sélection de texte : gras, italique, barré, code, **lien** ; « / Lien vers un document » insère
  un lien vers un cours, une page ou une autre note (`cadence:documents/document?doc=…&page=…`),
  ouvert par Ctrl+clic ou « Ouvrir » ;
- **sauvegarde automatique** (0,8 s après la dernière frappe, Ctrl+S pour tout de suite) avec
  indicateur ; l'enregistrement passe la révision lue : si l'IA a modifié la note entre-temps,
  l'écran propose de charger sa version ou de garder la sienne. Une note modifiée par l'IA pendant
  qu'elle est ouverte (sans modification locale) se recharge seule ;
- note vide : « Résumer le chapitre » lance le skill `prendre-des-notes` dans la note.

Depuis la bibliothèque, le menu « S'entraîner » d'un chapitre lance « Générer un QCM »,
« Flashcards » ou « Questions ouvertes ». L'écran se met à jour sur les événements du serveur
(`notifications/cadence/event`) : `quiz-saved` (`{ id, kind }`) quand un entraînement est
enregistré, `result-saved` (`{ quiz, score, total }`) quand un score l'est, `note-saved`
(`{ id, revision }`) et `note-deleted` (`{ id }`) pour les notes.

## Actions et skills

| Action | Skill | Mode | Contexte |
| --- | --- | --- | --- |
| Poser une question | `repondre-cours` | chat | `{ "subject", "chapter", "document"? }` |
| Générer un QCM | `generer-qcm` | fond | `{ "subject", "chapter", "document"?, "count"? }` |
| Questions ouvertes | `questions-ouvertes` | chat | `{ "subject", "chapter", "count"? }` |
| Flashcards | `flashcards` | fond | `{ "subject", "chapter", "document"?, "count"? }` |
| Résumer en note | `prendre-des-notes` | fond | `{ "subject", "chapter", "document"?, "note"? }` |

## Outils MCP (`documents__<outil>`)

| Outil | Rôle |
| --- | --- |
| `list_subjects`, `list_chapters`, `list_documents` | parcourir la bibliothèque |
| `import_document` | extraire le texte d'un fichier et le ranger (matière et chapitre créés au besoin) |
| `read_pages` | texte d'une plage de pages (20 par appel), avec le `link` de chaque page ; pour une note, le titre de chaque `section` |
| `search` | recherche plein texte sans accents ni casse, notes comprises : quelles pages lire (`link` de chaque résultat) |
| `create_note`, `update_note` | créer une note (Markdown) dans un chapitre ; la remplacer, la compléter (`append`) ou la renommer, avec la `revision` lue pour ne rien écraser |
| `list_notes`, `get_note` | notes (sections, révision, fichier) ; une note en entier (Markdown) |
| `delete_note` | réservé à l'écran (`_meta["cadence/visibility"] = "ui"`) : retire la note et efface son fichier |
| `save_quiz`, `list_quizzes`, `get_quiz` | entraînements générés ; `save_quiz` vérifie le format des éléments (QCM : `question`, `choices`, `answer` ; flashcards : `front`, `back` ; questions ouvertes : `question`) |
| `submit_qcm` | corrige un QCM à partir des indices choisis (1 point par bonne réponse), enregistre le score et renvoie la correction |
| `save_result` | réponses corrigées et score (questions ouvertes, tour de flashcards) |
| `list_results` | historique des scores, les plus récents d'abord |

Pages : une page de PDF ; une **diapositive** de PowerPoint ; pour Word, Markdown et texte, un
**bloc d'environ 3000 caractères** coupé entre deux paragraphes ; pour une note, une **section**
coupée avant chaque titre `#` à `###` (une section de plus de 3000 caractères est redécoupée).

## Données

Dans `CADENCE_DATA_DIR` (`<données de l'app>/plugins-data/documents/`) : `library.json`,
`cache/<document>.json` (texte par page), `quizzes/<quiz>.json`, `results/<résultat>.json` (score,
total, réponses ou correction, bilan, rang d'enregistrement `seq`). Les fichiers d'origine ne sont
pas copiés : chaque document garde leur chemin absolu. Aucun accès réseau.

Notes : `<dossier des cours>/Notes/<Matière>/<Chapitre>/<Titre>.md` (`CADENCE_DATA_DIR/notes/…`
tant que le dossier des cours n'est pas réglé), lisibles et modifiables hors de Cadence : le
fichier ne contient que le corps de la note en Markdown (GFM : cases `- [ ]`, tableaux), relu à
chaque lecture. Titre, révision et dates sont dans `library.json` (document de type `note`) ; le
cache garde une copie découpée par sections, qui sert si le fichier disparaît. L'IA tourne dans un
dossier neutre de Cadence et lit les cours par les outils ci-dessus.

## Développement

```sh
cargo test -p cadence-documents
pnpm --dir plugins/documents/ui dev
pnpm validate documents
```
