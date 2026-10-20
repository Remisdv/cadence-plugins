//! Notes prises dans Cadence : des documents de la bibliothèque (type `note`), rangés comme les
//! autres en Matière → Chapitre.
//!
//! Le texte d'une note est un fichier Markdown lisible hors de Cadence :
//!
//! ```text
//! <dossier des cours>/Notes/<Matière>/<Chapitre>/<Titre>.md
//! ```
//!
//! (`CADENCE_DATA_DIR/notes/…` tant que le dossier des cours n'est pas réglé). Le fichier ne
//! contient que le corps de la note ; titre, révision et dates restent dans `library.json`. Le
//! cache garde une copie découpée par titres (une page = une section), relue depuis le fichier
//! à chaque lecture pour suivre les modifications faites hors de Cadence.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;

use crate::{
    extract::{self, DocKind},
    library::{Document, Library, Located, PageCache, now_iso, slugify, unique_id, write_atomic, write_json},
};

/// Sous-dossier des notes dans le dossier des cours.
pub const NOTES_FOLDER: &str = "Notes";
/// Titre d'une note créée sans titre.
pub const UNTITLED: &str = "Sans titre";

/// Section d'une note (une page pour `read_pages`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Section {
    pub page: u32,
    /// Titre Markdown qui ouvre la section ; `None` pour le texte avant le premier titre.
    pub title: Option<String>,
}

/// Note complète : sa place dans la bibliothèque et son Markdown.
#[derive(Debug, Clone, Serialize)]
pub struct NoteContent {
    #[serde(flatten)]
    pub located: Located,
    pub markdown: String,
    pub sections: Vec<Section>,
    /// Le fichier a disparu (déplacé ou supprimé hors de Cadence) : texte tiré du cache, et le
    /// prochain enregistrement recrée le fichier.
    pub missing_file: bool,
}

/// Modification d'une note (`update_note`).
#[derive(Debug, Clone, Default)]
pub struct NoteUpdate {
    /// Nouveau Markdown (remplace le corps, ou s'y ajoute avec `append`).
    pub content: Option<String>,
    pub append: bool,
    /// Nouveau titre : le fichier est renommé.
    pub title: Option<String>,
    /// Révision lue : refus si la note a été enregistrée depuis.
    pub revision: Option<u32>,
}

/// Nom de fichier sûr sur Windows, macOS et Linux, accents gardés : caractères interdits
/// remplacés, points et espaces de bord retirés, noms réservés de Windows évités.
pub fn file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut stem: String = collapsed.chars().take(80).collect();
    stem = stem.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    if stem.is_empty() {
        return UNTITLED.into();
    }
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    let upper = stem.to_ascii_uppercase();
    let reserved = RESERVED.contains(&upper.as_str())
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        stem.push('_');
    }
    stem
}

/// `<dossier>/<Titre>.md`, sinon `<Titre> (2).md`… ; `current` (le fichier de la note) compte comme libre.
fn free_path(dir: &Path, title: &str, current: Option<&Path>) -> PathBuf {
    let stem = file_stem(title);
    let candidate = |n: u32| {
        if n == 1 {
            dir.join(format!("{stem}.md"))
        } else {
            dir.join(format!("{stem} ({n}).md"))
        }
    };
    (1..)
        .map(candidate)
        .find(|p| Some(p.as_path()) == current || !p.exists())
        .unwrap()
}

fn clean_title(title: Option<&str>) -> String {
    let title = title.map(str::trim).unwrap_or_default();
    if title.is_empty() {
        UNTITLED.into()
    } else {
        title.chars().take(200).collect()
    }
}

/// Texte enregistré : fins de ligne Unix, une seule fin de ligne finale (rien pour une note vide).
fn normalize(markdown: &str) -> String {
    let text = markdown.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let text = text.trim_end();
    if text.trim().is_empty() {
        String::new()
    } else {
        format!("{text}\n")
    }
}

fn sections_of(pages: &[String]) -> Vec<Section> {
    pages
        .iter()
        .enumerate()
        .map(|(i, p)| Section {
            page: i as u32 + 1,
            title: extract::section_title(p),
        })
        .collect()
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

impl Library {
    /// Dossier racine des notes : `<dossier des cours>/Notes`, sinon `CADENCE_DATA_DIR/notes`.
    pub fn notes_root(&self) -> PathBuf {
        match &self.courses_dir {
            Some(dir) => dir.join(NOTES_FOLDER),
            None => self.data_dir.join("notes"),
        }
    }

    /// Écrit le Markdown et le cache d'une note, et met à jour ses compteurs.
    fn write_note(&self, document: &mut Document, markdown: &str) -> Result<Vec<String>> {
        write_atomic(Path::new(&document.source), markdown.as_bytes())?;
        let pages = extract::note_pages(markdown);
        write_json(
            &self.cache_path(&document.id),
            &PageCache { pages: pages.clone() },
        )?;
        document.pages = pages.len() as u32;
        document.chars = markdown.chars().count() as u32;
        Ok(pages)
    }

    /// Crée une note dans un chapitre (matière et chapitre créés au besoin).
    pub fn create_note(
        &self,
        subject: &str,
        chapter: &str,
        title: Option<&str>,
        markdown: &str,
    ) -> Result<NoteContent> {
        if subject.trim().is_empty() || chapter.trim().is_empty() {
            bail!("Précisez la matière et le chapitre de la note.");
        }
        let title = clean_title(title);
        let mut lib = self.load()?;
        lib.version = 1;
        let ids = Self::document_ids(&lib);
        let (si, ci) = Self::ensure_chapter(&mut lib, subject, chapter);
        let (subject_name, chapter_name) = {
            let s = &lib.subjects[si];
            (s.name.clone(), s.chapters[ci].name.clone())
        };
        let dir = self
            .notes_root()
            .join(file_stem(&subject_name))
            .join(file_stem(&chapter_name));
        let path = free_path(&dir, &title, None);
        let now = now_iso();
        let mut document = Document {
            id: unique_id(&slugify(&title), |id| ids.iter().any(|d| d == id)),
            title,
            kind: DocKind::Note,
            source: path_text(&path),
            pages: 0,
            chars: 0,
            imported_at: now.clone(),
            updated_at: Some(now),
            revision: 1,
        };
        let markdown = normalize(markdown);
        self.write_note(&mut document, &markdown)
            .context("écriture de la note")?;
        let id = document.id.clone();
        lib.subjects[si].chapters[ci].documents.push(document);
        self.save(&lib)?;
        self.note(&id)
    }

    /// Lit une note : Markdown depuis son fichier (le cache s'il a disparu) et sections.
    pub fn note(&self, wanted: &str) -> Result<NoteContent> {
        let mut located = self.find_document(wanted)?;
        if located.document.kind != DocKind::Note {
            bail!(
                "« {} » n'est pas une note : lisez-le avec read_pages.",
                located.document.title
            );
        }
        let (markdown, missing_file) = match fs::read_to_string(&located.document.source) {
            Ok(text) => (text.trim_start_matches('\u{feff}').replace("\r\n", "\n"), false),
            Err(_) => {
                let cache = fs::read_to_string(self.cache_path(&located.document.id))
                    .ok()
                    .and_then(|t| serde_json::from_str::<PageCache>(&t).ok());
                let text = cache.map(|c| c.pages.join("\n\n")).unwrap_or_default();
                (normalize(&text), true)
            }
        };
        let pages = extract::note_pages(&markdown);
        located.document.pages = pages.len() as u32;
        Ok(NoteContent {
            sections: sections_of(&pages),
            located,
            markdown,
            missing_file,
        })
    }

    /// Modifie le texte et/ou le titre d'une note ; renvoie la note enregistrée (révision +1).
    pub fn update_note(&self, wanted: &str, update: NoteUpdate) -> Result<NoteContent> {
        if update.content.is_none() && update.title.is_none() {
            bail!("Rien à modifier : donnez `content` (Markdown) et/ou `title`.");
        }
        let current = self.note(wanted)?;
        let id = current.located.document.id.clone();
        let mut lib = self.load()?;
        let document = lib
            .subjects
            .iter_mut()
            .flat_map(|s| s.chapters.iter_mut())
            .flat_map(|c| c.documents.iter_mut())
            .find(|d| d.id == id)
            .ok_or_else(|| anyhow!("Note « {wanted} » introuvable."))?;
        if let Some(seen) = update.revision
            && seen != document.revision
        {
            bail!(
                "La note « {} » a été enregistrée depuis la révision {seen} (révision actuelle : {}) : \
                 relisez-la avec get_note avant de la modifier.",
                document.title,
                document.revision
            );
        }

        let markdown = match (&update.content, update.append) {
            (Some(extra), true) if !current.markdown.trim().is_empty() => normalize(&format!(
                "{}\n\n{}",
                current.markdown.trim_end(),
                extra.trim_start_matches('\n')
            )),
            (Some(content), _) => normalize(content),
            (None, _) => current.markdown.clone(),
        };

        // Nouveau titre : le fichier est renommé dans le même dossier.
        if let Some(title) = &update.title {
            let title = clean_title(Some(title));
            if title != document.title {
                let old = PathBuf::from(&document.source);
                let dir = old
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| self.notes_root());
                let new = free_path(&dir, &title, Some(&old));
                if new != old {
                    if old.exists() {
                        fs::rename(&old, &new).with_context(|| format!("renommage de {}", old.display()))?;
                    }
                    document.source = path_text(&new);
                }
                document.title = title;
            }
        }

        self.write_note(document, &markdown)
            .context("écriture de la note")?;
        document.revision += 1;
        document.updated_at = Some(now_iso());
        self.save(&lib)?;
        self.note(&id)
    }

    /// Supprime une note de la bibliothèque, avec son fichier Markdown et son cache.
    pub fn delete_note(&self, wanted: &str) -> Result<Located> {
        let note = self.note(wanted)?;
        let id = note.located.document.id.clone();
        let mut lib = self.load()?;
        for chapter in lib.subjects.iter_mut().flat_map(|s| s.chapters.iter_mut()) {
            chapter.documents.retain(|d| d.id != id);
        }
        self.save(&lib)?;
        let path = Path::new(&note.located.document.source);
        if path.exists() {
            fs::remove_file(path).with_context(|| format!("suppression de {}", path.display()))?;
        }
        let _ = fs::remove_file(self.cache_path(&id));
        Ok(note.located)
    }

    /// Notes de la bibliothèque, éventuellement d'une matière et d'un chapitre, les plus récemment
    /// modifiées d'abord, avec leurs sections.
    pub fn notes(&self, subject: Option<&str>, chapter: Option<&str>) -> Result<Vec<NoteContent>> {
        let mut out: Vec<NoteContent> = self
            .documents(subject, chapter)?
            .into_iter()
            .filter(|l| l.document.kind == DocKind::Note)
            .filter_map(|l| self.note(&l.document.id).ok())
            .collect();
        out.sort_by(|a, b| b.located.document.updated_at.cmp(&a.located.document.updated_at));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(with_courses: bool) -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let courses = dir.path().join("cours");
        fs::create_dir_all(&courses).unwrap();
        let lib = Library::new(dir.path().join("data"), with_courses.then_some(courses));
        (dir, lib)
    }

    #[test]
    fn creates_a_note_as_a_markdown_file_of_the_courses_folder() {
        let (tmp, lib) = setup(true);
        let note = lib
            .create_note(
                "Chimie",
                "Atomistique",
                Some("Résumé : l'atome"),
                "# Noyau\r\n\nProtons et neutrons.\n\n# Électrons\n\nCouches K, L, M.",
            )
            .unwrap();
        let doc = &note.located.document;
        assert_eq!(
            (doc.id.as_str(), doc.kind, doc.revision, doc.pages),
            ("resume-l-atome", DocKind::Note, 1, 2)
        );
        assert_eq!(
            (note.located.subject.as_str(), note.located.chapter.as_str()),
            ("chimie", "atomistique")
        );
        assert_eq!(note.located.page_unit, "section");
        let expected = tmp
            .path()
            .join("cours/Notes/Chimie/Atomistique/Résumé - l'atome.md");
        assert_eq!(doc.source, path_text(&expected));
        assert_eq!(
            fs::read_to_string(&expected).unwrap(),
            "# Noyau\n\nProtons et neutrons.\n\n# Électrons\n\nCouches K, L, M.\n"
        );
        assert_eq!(
            note.sections,
            [
                Section {
                    page: 1,
                    title: Some("Noyau".into())
                },
                Section {
                    page: 2,
                    title: Some("Électrons".into())
                }
            ]
        );

        // Même titre : autre fichier, autre identifiant. Note vide permise.
        let twin = lib
            .create_note("chimie", "atomistique", Some("Résumé : l'atome"), "")
            .unwrap();
        assert_eq!(twin.located.document.id, "resume-l-atome-2");
        assert!(twin.located.document.source.ends_with("Résumé - l'atome (2).md"));
        assert_eq!((twin.markdown.as_str(), twin.located.document.pages), ("", 1));

        // Rangée avec les autres documents du chapitre.
        let docs = lib.documents(Some("Chimie"), Some("Atomistique")).unwrap();
        assert_eq!(docs.len(), 2);
        assert!(lib.create_note(" ", "Atomistique", None, "").is_err());
    }

    #[test]
    fn without_courses_folder_notes_go_to_the_plugin_data() {
        let (tmp, lib) = setup(false);
        let note = lib.create_note("Maths", "Suites", None, "Texte").unwrap();
        assert_eq!(note.located.document.title, UNTITLED);
        assert_eq!(
            note.located.document.source,
            path_text(&tmp.path().join("data/notes/Maths/Suites/Sans titre.md"))
        );
    }

    #[test]
    fn updates_appends_renames_and_refuses_stale_revisions() {
        let (tmp, lib) = setup(true);
        let note = lib
            .create_note("Physique", "Optique", Some("Lentilles"), "# Foyer\n\nf'")
            .unwrap();
        let id = note.located.document.id.clone();

        let updated = lib
            .update_note(
                &id,
                NoteUpdate {
                    content: Some("# Foyer\n\nDistance focale f'.\n\n# Vergence\n\nV = 1/f'".into()),
                    revision: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.located.document.revision, 2);
        assert_eq!(updated.located.document.pages, 2);
        assert!(updated.located.document.updated_at.is_some());

        // Une révision périmée est refusée, sans rien écrire.
        let err = lib
            .update_note(
                &id,
                NoteUpdate {
                    content: Some("écrasé".into()),
                    revision: Some(1),
                    ..Default::default()
                },
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("révision actuelle : 2"), "{err}");

        let appended = lib
            .update_note(
                &id,
                NoteUpdate {
                    content: Some("# Exercices\n\n- Ex. 3".into()),
                    append: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            appended
                .markdown
                .ends_with("V = 1/f'\n\n# Exercices\n\n- Ex. 3\n")
        );
        assert_eq!(appended.sections.len(), 3);

        let renamed = lib
            .update_note(
                &id,
                NoteUpdate {
                    title: Some("Lentilles minces".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let new_path = tmp
            .path()
            .join("cours/Notes/Physique/Optique/Lentilles minces.md");
        assert_eq!(renamed.located.document.source, path_text(&new_path));
        assert!(new_path.exists());
        assert!(
            !tmp.path()
                .join("cours/Notes/Physique/Optique/Lentilles.md")
                .exists()
        );
        assert_eq!(renamed.markdown, appended.markdown);
        assert_eq!(renamed.located.document.id, id, "l'identifiant ne change pas");

        assert!(lib.update_note(&id, NoteUpdate::default()).is_err());
    }

    #[test]
    fn notes_are_read_and_searched_by_section() {
        let (tmp, lib) = setup(true);
        let note = lib
            .create_note(
                "Chimie",
                "Liaisons",
                Some("Fiche liaisons"),
                "Introduction.\n\n## Covalente\n\nMise en commun d'électrons.\n\n## Ionique\n\nTransfert d'électrons entre atomes.",
            )
            .unwrap();
        let id = note.located.document.id;

        let (doc, pages) = lib.read_pages(&id, 2, Some(3)).unwrap();
        assert_eq!(doc.page_unit, "section");
        assert_eq!(
            pages[0],
            (2, "## Covalente\n\nMise en commun d'électrons.".to_string())
        );
        assert_eq!(pages.len(), 2);

        let hits = lib.search("electrons", Some("chimie"), None, 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(
            (hits[1]["document"].as_str(), hits[1]["page"].as_u64()),
            (Some(id.as_str()), Some(3))
        );
        assert_eq!(hits[0]["kind"], "note");

        // Modifiée hors de Cadence : relue depuis le fichier.
        let path = tmp.path().join("cours/Notes/Chimie/Liaisons/Fiche liaisons.md");
        fs::write(&path, "# Métallique\r\n\nMer d'électrons délocalisés.").unwrap();
        let (doc, pages) = lib.read_pages(&id, 1, Some(5)).unwrap();
        assert_eq!((doc.document.pages, pages.len()), (1, 1));
        assert_eq!(lib.search("delocalises", None, None, 5).unwrap().len(), 1);

        // Fichier disparu : le cache prend le relais, et l'enregistrement suivant le recrée.
        fs::remove_file(&path).unwrap();
        let fallback = lib.note(&id).unwrap();
        assert!(fallback.missing_file);
        assert!(fallback.markdown.contains("Ionique"));
        assert_eq!(lib.search("transfert", None, None, 5).unwrap().len(), 1);
        lib.update_note(
            &id,
            NoteUpdate {
                content: Some(fallback.markdown),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(path.exists());
    }

    #[test]
    fn lists_and_deletes_notes() {
        let (tmp, lib) = setup(true);
        fs::write(tmp.path().join("cours/td.md"), "# TD\n\nExercice.").unwrap();
        lib.import("td.md", "Chimie", "Atomistique", None).unwrap();
        let a = lib.create_note("Chimie", "Atomistique", Some("A"), "a").unwrap();
        lib.create_note("Chimie", "Liaisons", Some("B"), "b").unwrap();
        assert_eq!(lib.notes(None, None).unwrap().len(), 2);
        assert_eq!(lib.notes(Some("chimie"), Some("atomistique")).unwrap().len(), 1);
        assert!(
            lib.note("td")
                .unwrap_err()
                .to_string()
                .contains("n'est pas une note")
        );

        let path = PathBuf::from(&a.located.document.source);
        lib.delete_note("a").unwrap();
        assert!(!path.exists());
        assert_eq!(lib.notes(None, None).unwrap().len(), 1);
        assert_eq!(
            lib.documents(Some("chimie"), Some("atomistique")).unwrap().len(),
            1
        );
        assert!(
            lib.delete_note("td").is_err(),
            "un cours importé n'est pas supprimable ainsi"
        );
    }

    #[test]
    fn safe_file_names() {
        assert_eq!(file_stem("Cours : chap. 1/2?"), "Cours - chap. 1-2-");
        assert_eq!(file_stem("  ...  "), UNTITLED);
        assert_eq!(file_stem("con"), "con_");
        assert_eq!(file_stem("COM1"), "COM1_");
        assert_eq!(file_stem("Compte rendu"), "Compte rendu");
        assert_eq!(file_stem("a\tb\nc"), "a b c");
        assert_eq!(file_stem(&"é".repeat(100)).chars().count(), 80);
    }
}
