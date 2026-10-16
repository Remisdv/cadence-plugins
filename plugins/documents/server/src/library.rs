//! Bibliothèque de cours : Matière → Chapitre → Documents (une seule, globale au plugin).
//!
//! Tout est rangé dans `CADENCE_DATA_DIR` :
//!
//! ```text
//! library.json            matières, chapitres, documents (métadonnées)
//! cache/<document>.json   texte extrait, une entrée par page
//! quizzes/<quiz>.json     QCM, questions ouvertes, flashcards générés
//! results/<résultat>.json réponses et scores
//! ```
//!
//! Les fichiers d'origine ne sont pas copiés : le document garde leur chemin absolu. Un chemin
//! relatif donné à l'import est lu depuis le dossier des cours (réglage global `dossier_cours`).
//! L'IA lit le cache à la demande, sans index d'embeddings.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::extract::{self, DocKind};

/// Pages rendues au plus par lecture.
pub const MAX_PAGES_PER_READ: u32 = 20;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LibraryFile {
    pub version: u32,
    pub subjects: Vec<Subject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subject {
    pub id: String,
    pub name: String,
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    pub id: String,
    pub name: String,
    pub documents: Vec<Document>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub kind: DocKind,
    /// Chemin absolu du fichier d'origine (barres obliques normalisées).
    pub source: String,
    pub pages: u32,
    pub chars: u32,
    pub imported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PageCache {
    pages: Vec<String>,
}

/// Document et sa place dans la bibliothèque.
#[derive(Debug, Clone, Serialize)]
pub struct Located {
    pub subject: String,
    pub subject_name: String,
    pub chapter: String,
    pub chapter_name: String,
    #[serde(flatten)]
    pub document: Document,
    /// Ce qu'une page désigne pour ce format (« page », « diapositive »…).
    pub page_unit: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QuizKind {
    Qcm,
    QuestionsOuvertes,
    Flashcards,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quiz {
    pub id: String,
    pub kind: QuizKind,
    pub title: String,
    pub subject: Option<String>,
    pub chapter: Option<String>,
    /// Documents et pages dont le quiz est tiré : `[{ "document": "…", "pages": [1, 2] }]`.
    pub sources: Value,
    /// Questions ou cartes, au format décrit par le skill qui les a générées.
    pub items: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuizResult {
    pub id: String,
    pub quiz: String,
    pub score: Option<f64>,
    pub total: Option<f64>,
    pub answers: Value,
    pub feedback: Option<String>,
    pub created_at: String,
}

pub struct Library {
    data_dir: PathBuf,
    /// Dossier des cours (réglage `dossier_cours`), base des chemins relatifs à l'import.
    courses_dir: Option<PathBuf>,
}

/* ---------- Utilitaires ---------- */

/// Identifiant lisible : minuscules ASCII, accents retirés, tirets.
pub fn slugify(text: &str) -> String {
    let mut slug = String::new();
    for c in text.chars().flat_map(fold_accent) {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_end_matches('-').chars().take(48).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        "sans-titre".into()
    } else {
        slug
    }
}

fn fold_accent(c: char) -> Vec<char> {
    let base = match c {
        'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'À' | 'Á' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'A',
        'ç' => 'c',
        'Ç' => 'C',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'É' | 'È' | 'Ê' | 'Ë' => 'E',
        'î' | 'ï' | 'í' | 'ì' => 'i',
        'Î' | 'Ï' | 'Í' | 'Ì' => 'I',
        'ô' | 'ö' | 'ó' | 'ò' | 'õ' => 'o',
        'Ô' | 'Ö' | 'Ó' | 'Ò' | 'Õ' => 'O',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'Ù' | 'Ú' | 'Û' | 'Ü' => 'U',
        'ÿ' => 'y',
        'œ' => return vec!['o', 'e'],
        'Œ' => return vec!['O', 'E'],
        'æ' => return vec!['a', 'e'],
        c => c,
    };
    vec![base]
}

/// Texte comparable pour la recherche : minuscules, sans accents.
pub fn fold(text: &str) -> String {
    text.chars()
        .flat_map(fold_accent)
        .flat_map(char::to_lowercase)
        .collect()
}

/// Identifiant libre : `base`, sinon `base-2`, `base-3`…
fn unique_id(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|id| !taken(id))
        .unwrap()
}

/// Date UTC au format RFC 3339 (`2026-10-16T09:30:00Z`).
pub fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso_from_unix(secs)
}

pub fn iso_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Algorithme « civil from days » (H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Désigne une matière ou un chapitre par identifiant ou par nom (insensible à la casse et aux accents).
fn matches(id: &str, name: &str, wanted: &str) -> bool {
    let w = wanted.trim();
    id == w || fold(name) == fold(w) || id == slugify(w)
}

impl Library {
    pub fn new(data_dir: PathBuf, courses_dir: Option<PathBuf>) -> Self {
        Library {
            data_dir,
            courses_dir,
        }
    }

    /// Nouveau dossier des cours (réglages modifiés dans Cadence).
    pub fn set_courses_dir(&mut self, courses_dir: Option<PathBuf>) {
        self.courses_dir = courses_dir;
    }

    pub fn courses_dir(&self) -> Option<&Path> {
        self.courses_dir.as_deref()
    }

    fn library_path(&self) -> PathBuf {
        self.data_dir.join("library.json")
    }

    fn cache_path(&self, document: &str) -> PathBuf {
        self.data_dir.join("cache").join(format!("{document}.json"))
    }

    pub fn load(&self) -> Result<LibraryFile> {
        match fs::read_to_string(self.library_path()) {
            Ok(text) => serde_json::from_str(&text).context("library.json illisible"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LibraryFile {
                version: 1,
                subjects: vec![],
            }),
            Err(e) => Err(e).context("lecture de library.json"),
        }
    }

    fn save(&self, lib: &LibraryFile) -> Result<()> {
        write_json(&self.library_path(), lib)
    }

    pub fn subject<'a>(&self, lib: &'a LibraryFile, wanted: &str) -> Result<&'a Subject> {
        lib.subjects
            .iter()
            .find(|s| matches(&s.id, &s.name, wanted))
            .ok_or_else(|| {
                let known: Vec<&str> = lib.subjects.iter().map(|s| s.name.as_str()).collect();
                anyhow!(
                    "Matière « {wanted} » introuvable. Matières : {}.",
                    if known.is_empty() {
                        "aucune".into()
                    } else {
                        known.join(", ")
                    }
                )
            })
    }

    /// Tous les documents, filtrés par matière et chapitre.
    pub fn documents(&self, subject: Option<&str>, chapter: Option<&str>) -> Result<Vec<Located>> {
        let lib = self.load()?;
        let subjects: Vec<&Subject> = match subject {
            Some(s) => vec![self.subject(&lib, s)?],
            None => lib.subjects.iter().collect(),
        };
        let mut out = Vec::new();
        for s in subjects {
            let chapters: Vec<&Chapter> = match chapter {
                Some(c) => {
                    let found: Vec<&Chapter> = s
                        .chapters
                        .iter()
                        .filter(|ch| matches(&ch.id, &ch.name, c))
                        .collect();
                    if found.is_empty() && subject.is_some() {
                        bail!("Chapitre « {c} » introuvable dans {}.", s.name);
                    }
                    found
                }
                None => s.chapters.iter().collect(),
            };
            for ch in chapters {
                for d in &ch.documents {
                    out.push(Located {
                        subject: s.id.clone(),
                        subject_name: s.name.clone(),
                        chapter: ch.id.clone(),
                        chapter_name: ch.name.clone(),
                        document: d.clone(),
                        page_unit: d.kind.page_unit(),
                    });
                }
            }
        }
        Ok(out)
    }

    pub fn find_document(&self, wanted: &str) -> Result<Located> {
        let all = self.documents(None, None)?;
        all.iter()
            .find(|l| l.document.id == wanted.trim())
            .or_else(|| all.iter().find(|l| fold(&l.document.title) == fold(wanted)))
            .cloned()
            .ok_or_else(|| anyhow!("Document « {wanted} » introuvable : listez-les avec list_documents."))
    }

    /// Chemin absolu du fichier à importer : tel quel, ou relatif au dossier des cours.
    fn resolve_source(&self, path: &str) -> Result<PathBuf> {
        let p = Path::new(path.trim());
        match (&self.courses_dir, p.is_absolute()) {
            (_, true) => Ok(p.to_path_buf()),
            (Some(dir), false) => Ok(dir.join(p)),
            (None, false) => bail!(
                "Chemin relatif « {path} » : donnez un chemin absolu, ou réglez le dossier des cours \
                 (étape « Dossier des cours » du plugin Documents)."
            ),
        }
    }

    /// Importe un fichier : extrait son texte, le met en cache, l'ajoute au chapitre (créé au besoin).
    pub fn import(&self, path: &str, subject: &str, chapter: &str, title: Option<&str>) -> Result<Located> {
        if subject.trim().is_empty() || chapter.trim().is_empty() {
            bail!("Précisez la matière et le chapitre du document.");
        }
        let source = self.resolve_source(path)?;
        if !source.is_file() {
            bail!("Fichier introuvable : {}", source.display());
        }
        let (kind, pages) = extract::extract_file(&source)?;
        let mut lib = self.load()?;
        lib.version = 1;

        let all_doc_ids: Vec<String> = lib
            .subjects
            .iter()
            .flat_map(|s| &s.chapters)
            .flat_map(|c| &c.documents)
            .map(|d| d.id.clone())
            .collect();
        let title = title
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                source
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        let source_text = source.to_string_lossy().replace('\\', "/");

        // Matière et chapitre, créés s'ils n'existent pas.
        let si = match lib.subjects.iter().position(|s| matches(&s.id, &s.name, subject)) {
            Some(i) => i,
            None => {
                let id = unique_id(&slugify(subject), |id| lib.subjects.iter().any(|s| s.id == id));
                lib.subjects.push(Subject {
                    id,
                    name: subject.trim().into(),
                    chapters: vec![],
                });
                lib.subjects.len() - 1
            }
        };
        let s = &mut lib.subjects[si];
        let ci = match s.chapters.iter().position(|c| matches(&c.id, &c.name, chapter)) {
            Some(i) => i,
            None => {
                let id = unique_id(&slugify(chapter), |id| s.chapters.iter().any(|c| c.id == id));
                s.chapters.push(Chapter {
                    id,
                    name: chapter.trim().into(),
                    documents: vec![],
                });
                s.chapters.len() - 1
            }
        };
        let ch = &mut s.chapters[ci];

        // Réimport du même fichier dans le même chapitre : on remplace.
        let existing = ch.documents.iter().position(|d| d.source == source_text);
        let id = match existing {
            Some(i) => ch.documents[i].id.clone(),
            None => unique_id(&slugify(&title), |id| all_doc_ids.iter().any(|d| d == id)),
        };
        let document = Document {
            id: id.clone(),
            title,
            kind,
            source: source_text,
            pages: pages.len() as u32,
            chars: pages.iter().map(|p| p.chars().count() as u32).sum(),
            imported_at: now_iso(),
        };
        write_json(&self.cache_path(&id), &PageCache { pages })?;
        match existing {
            Some(i) => ch.documents[i] = document,
            None => ch.documents.push(document),
        }
        self.save(&lib)?;
        self.find_document(&id)
    }

    /// Texte des pages `from..=to` (numérotées à partir de 1), bornées à [`MAX_PAGES_PER_READ`].
    pub fn read_pages(
        &self,
        document: &str,
        from: u32,
        to: Option<u32>,
    ) -> Result<(Located, Vec<(u32, String)>)> {
        let located = self.find_document(document)?;
        let id = &located.document.id;
        let text = fs::read_to_string(self.cache_path(id))
            .with_context(|| format!("texte de « {id} » absent du cache : réimportez le document"))?;
        let cache: PageCache = serde_json::from_str(&text).context("cache illisible")?;
        let total = cache.pages.len() as u32;
        let from = from.max(1);
        if from > total {
            bail!("« {} » n'a que {total} page(s).", located.document.title);
        }
        let to = to
            .unwrap_or(from)
            .clamp(from, total)
            .min(from + MAX_PAGES_PER_READ - 1);
        let pages = (from..=to)
            .map(|n| (n, cache.pages[(n - 1) as usize].clone()))
            .collect();
        Ok((located, pages))
    }

    /// Recherche plein texte naïve (sans accents ni casse) dans le cache, pour trouver quoi lire.
    pub fn search(
        &self,
        query: &str,
        subject: Option<&str>,
        chapter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Value>> {
        let needle = fold(query.trim());
        if needle.chars().count() < 2 {
            bail!("Recherche trop courte.");
        }
        let mut hits = Vec::new();
        for l in self.documents(subject, chapter)? {
            let Ok(text) = fs::read_to_string(self.cache_path(&l.document.id)) else {
                continue;
            };
            let Ok(cache) = serde_json::from_str::<PageCache>(&text) else {
                continue;
            };
            for (i, page) in cache.pages.iter().enumerate() {
                let folded = fold(page);
                let Some(pos) = folded.find(&needle) else { continue };
                // Extrait autour de la première occurrence (positions en caractères du texte replié).
                let start_char = folded[..pos].chars().count().saturating_sub(120);
                let excerpt: String = page.chars().skip(start_char).take(300).collect();
                hits.push(serde_json::json!({
                    "document": l.document.id,
                    "title": l.document.title,
                    "page": i + 1,
                    "page_unit": l.page_unit,
                    "excerpt": excerpt.trim(),
                    "occurrences": folded.matches(&needle).count(),
                }));
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
        Ok(hits)
    }

    /* ---------- Entraînement ---------- */

    pub fn save_quiz(
        &self,
        kind: QuizKind,
        title: &str,
        subject: Option<String>,
        chapter: Option<String>,
        sources: Value,
        items: Value,
    ) -> Result<Quiz> {
        let count = items.as_array().map(Vec::len).unwrap_or(0);
        if count == 0 {
            bail!("Le quiz ne contient aucune question ni carte (`items` doit être une liste non vide).");
        }
        let created_at = now_iso();
        let prefix = match kind {
            QuizKind::Qcm => "qcm",
            QuizKind::QuestionsOuvertes => "questions",
            QuizKind::Flashcards => "flashcards",
        };
        let dir = self.data_dir.join("quizzes");
        let base = format!("{prefix}-{}", slugify(title));
        let id = unique_id(&base, |id| dir.join(format!("{id}.json")).exists());
        let quiz = Quiz {
            id: id.clone(),
            kind,
            title: title.trim().into(),
            subject,
            chapter,
            sources,
            items,
            created_at,
        };
        write_json(&dir.join(format!("{id}.json")), &quiz)?;
        Ok(quiz)
    }

    pub fn quiz(&self, id: &str) -> Result<Quiz> {
        let path = self
            .data_dir
            .join("quizzes")
            .join(format!("{}.json", slugify(id)));
        let text = fs::read_to_string(&path).map_err(|_| anyhow!("Quiz « {id} » introuvable."))?;
        serde_json::from_str(&text).context("quiz illisible")
    }

    pub fn quizzes(&self) -> Result<Vec<Quiz>> {
        let mut out: Vec<Quiz> = read_dir_json(&self.data_dir.join("quizzes"))?;
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    pub fn results(&self) -> Result<Vec<QuizResult>> {
        let mut out: Vec<QuizResult> = read_dir_json(&self.data_dir.join("results"))?;
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    pub fn save_result(
        &self,
        quiz: &str,
        score: Option<f64>,
        total: Option<f64>,
        answers: Value,
        feedback: Option<String>,
    ) -> Result<QuizResult> {
        let quiz = self.quiz(quiz)?;
        let created_at = now_iso();
        let dir = self.data_dir.join("results");
        let base = format!(
            "{}-{}",
            quiz.id,
            created_at.replace([':', '-'], "").to_lowercase()
        );
        let id = unique_id(&base, |id| dir.join(format!("{id}.json")).exists());
        let result = QuizResult {
            id: id.clone(),
            quiz: quiz.id,
            score,
            total,
            answers,
            feedback,
            created_at,
        };
        write_json(&dir.join(format!("{id}.json")), &result)?;
        Ok(result)
    }
}

/// Écriture atomique (fichier temporaire puis renommage).
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let dir = path.parent().context("chemin sans dossier")?;
    fs::create_dir_all(dir).with_context(|| format!("création de {}", dir.display()))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, path).with_context(|| format!("écriture de {}", path.display()))
}

fn read_dir_json<T: for<'de> Deserialize<'de>>(dir: &Path) -> Result<Vec<T>> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json")
            && let Ok(text) = fs::read_to_string(&path)
            && let Ok(value) = serde_json::from_str(&text)
        {
            out.push(value);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::tests::{docx, pdf, pptx};
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().join("etudes");
        fs::create_dir_all(ws.join("cours")).unwrap();
        fs::write(
            ws.join("cours/atomes.pdf"),
            pdf(&["Le noyau atomique", "Les electrons"]),
        )
        .unwrap();
        fs::write(
            ws.join("cours/liaisons.docx"),
            docx(&["Liaison covalente", "Liaison ionique"]),
        )
        .unwrap();
        fs::write(
            ws.join("cours/td.pptx"),
            pptx(&["Exercice 1", "Exercice 2|Corrigé"]),
        )
        .unwrap();
        fs::write(ws.join("cours/notes.md"), "# Révisions\n\nÉnergie d'ionisation.").unwrap();
        let lib = Library::new(dir.path().join("data"), Some(ws));
        (dir, lib)
    }

    #[test]
    fn imports_into_subject_and_chapter() {
        let (_tmp, lib) = setup();
        let a = lib
            .import("cours/atomes.pdf", "Chimie", "Atomistique", None)
            .unwrap();
        assert_eq!(
            (a.subject.as_str(), a.chapter.as_str(), a.document.id.as_str()),
            ("chimie", "atomistique", "atomes")
        );
        assert_eq!(
            (a.document.pages, a.document.kind, a.page_unit),
            (2, DocKind::Pdf, "page")
        );
        assert!(Path::new(&a.document.source).is_absolute());
        assert!(
            a.document.source.ends_with("/etudes/cours/atomes.pdf"),
            "{}",
            a.document.source
        );

        // Même matière désignée par son nom accentué ou son id ; chapitre créé à la volée.
        lib.import(
            "cours/liaisons.docx",
            "chimie",
            "Liaisons chimiques",
            Some("Les liaisons"),
        )
        .unwrap();
        let td = lib
            .import("cours/td.pptx", "CHIMIE", "Atomistique", None)
            .unwrap();
        assert_eq!((td.document.pages, td.page_unit), (2, "diapositive"));
        lib.import("cours/notes.md", "Physique", "Énergie", None).unwrap();

        let library = lib.load().unwrap();
        assert_eq!(library.subjects.len(), 2);
        assert_eq!(library.subjects[0].chapters.len(), 2);
        assert_eq!(
            lib.documents(Some("chimie"), Some("atomistique")).unwrap().len(),
            2
        );
        assert_eq!(
            lib.documents(Some("Physique"), None).unwrap()[0].chapter,
            "energie"
        );
        assert!(lib.documents(Some("Maths"), None).is_err());

        // Réimport : remplacé, pas dupliqué.
        lib.import("cours/atomes.pdf", "Chimie", "Atomistique", None)
            .unwrap();
        assert_eq!(
            lib.documents(Some("chimie"), Some("atomistique")).unwrap().len(),
            2
        );
    }

    #[test]
    fn reads_page_ranges_from_cache() {
        let (_tmp, lib) = setup();
        lib.import("cours/td.pptx", "Chimie", "TD", None).unwrap();
        let (doc, pages) = lib.read_pages("td", 1, Some(9)).unwrap();
        assert_eq!(doc.document.title, "td");
        assert_eq!(
            pages,
            [
                (1, "Exercice 1".to_string()),
                (2, "Exercice 2\nCorrigé".to_string())
            ]
        );
        assert!(lib.read_pages("td", 3, None).is_err());
        assert!(lib.read_pages("inconnu", 1, None).is_err());
    }

    #[test]
    fn searches_without_accents() {
        let (_tmp, lib) = setup();
        lib.import("cours/notes.md", "Physique", "Énergie", None).unwrap();
        lib.import("cours/liaisons.docx", "Chimie", "Liaisons", None)
            .unwrap();
        let hits = lib.search("energie", None, None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            (hits[0]["document"].as_str(), hits[0]["page"].as_u64()),
            (Some("notes"), Some(1))
        );
        assert_eq!(
            lib.search("liaison", Some("chimie"), None, 10).unwrap()[0]["occurrences"],
            2
        );
    }

    #[test]
    fn saves_quizzes_and_results() {
        let (_tmp, lib) = setup();
        let items = json!([{ "question": "Charge du proton ?", "choices": ["+e", "-e"], "answer": 0,
                             "source": { "document": "atomes", "page": 1 } }]);
        let quiz = lib
            .save_quiz(
                QuizKind::Qcm,
                "Atomistique — bases",
                Some("chimie".into()),
                None,
                json!([]),
                items,
            )
            .unwrap();
        assert_eq!(quiz.id, "qcm-atomistique-bases");
        let again = lib
            .save_quiz(
                QuizKind::Qcm,
                "Atomistique — bases",
                None,
                None,
                json!([]),
                json!([1]),
            )
            .unwrap();
        assert_eq!(again.id, "qcm-atomistique-bases-2");
        assert!(
            lib.save_quiz(QuizKind::Flashcards, "Vide", None, None, json!([]), json!([]))
                .is_err()
        );

        let r = lib
            .save_result(&quiz.id, Some(1.0), Some(1.0), json!([0]), Some("Parfait".into()))
            .unwrap();
        assert_eq!(r.quiz, quiz.id);
        assert_eq!(lib.quizzes().unwrap().len(), 2);
        assert_eq!(lib.results().unwrap().len(), 1);
        assert!(lib.save_result("inconnu", None, None, json!(null), None).is_err());
    }

    #[test]
    fn slugs_and_dates() {
        assert_eq!(slugify("Électricité & Magnétisme"), "electricite-magnetisme");
        assert_eq!(slugify("Cœur"), "coeur");
        assert_eq!(slugify("!!!"), "sans-titre");
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_791_000_000), "2026-10-03T04:00:00Z");
    }
}
