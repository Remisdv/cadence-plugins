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
//! Les notes prises dans Cadence (`notes.rs`) sont des documents de type `note` : leur Markdown
//! vit dans le dossier des cours, le cache en garde une copie découpée par titres.
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
    /// Note : dernière modification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Note : révision, +1 à chaque enregistrement (refus d'écraser une version plus récente).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub revision: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PageCache {
    pub(crate) pages: Vec<String>,
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
    /// Rang d'enregistrement (1, 2, 3…) : ordonne les résultats d'une même seconde. 0 pour les
    /// résultats antérieurs à la 0.3.0.
    #[serde(default)]
    pub seq: u32,
}

/// Correction d'une question de QCM (`grade_qcm`), gardée dans `answers` du résultat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QcmCorrection {
    pub question: String,
    pub choices: Vec<String>,
    /// Indice choisi, à partir de 0 ; `None` : question passée.
    pub chosen: Option<u32>,
    /// Indice de la bonne réponse.
    pub answer: u32,
    pub correct: bool,
    pub explanation: Option<String>,
    /// Document et page de la réponse (`{ "document", "page" }`), tels que le skill les a donnés.
    pub source: Value,
}

/// Résultat dans l'historique des scores, avec son entraînement (sans le détail des réponses).
#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub id: String,
    pub quiz: String,
    /// Titre et type de l'entraînement ; `None` s'il a été supprimé depuis.
    pub title: Option<String>,
    pub kind: Option<QuizKind>,
    pub subject: Option<String>,
    pub chapter: Option<String>,
    pub score: Option<f64>,
    pub total: Option<f64>,
    /// Score en pourcentage (0 à 100), quand le total est connu.
    pub percent: Option<u32>,
    pub created_at: String,
}

/// Vérifie le format des éléments d'un entraînement (celui décrit par les skills), pour que
/// l'écran Entraînement puisse le faire passer : message lisible par l'IA sinon.
pub fn check_items(kind: QuizKind, items: &Value) -> Result<()> {
    let Some(list) = items.as_array().filter(|l| !l.is_empty()) else {
        bail!("Le quiz ne contient aucune question ni carte (`items` doit être une liste non vide).");
    };
    let text = |item: &Value, key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
    };
    for (i, item) in list.iter().enumerate() {
        let n = i + 1;
        if !item.is_object() {
            bail!("Élément {n} : objet attendu.");
        }
        match kind {
            QuizKind::Qcm => {
                if !text(item, "question") {
                    bail!("Question {n} : champ `question` absent ou vide.");
                }
                let choices = item.get("choices").and_then(Value::as_array);
                let Some(choices) = choices.filter(|c| {
                    c.len() >= 2 && c.iter().all(|c| c.as_str().is_some_and(|s| !s.trim().is_empty()))
                }) else {
                    bail!("Question {n} : `choices` doit lister au moins 2 réponses (texte).");
                };
                let answer = item.get("answer").and_then(Value::as_u64);
                if answer.is_none_or(|a| a as usize >= choices.len()) {
                    bail!(
                        "Question {n} : `answer` doit être l'indice (à partir de 0) de la bonne réponse parmi les {} choix.",
                        choices.len()
                    );
                }
            }
            QuizKind::Flashcards => {
                if !text(item, "front") || !text(item, "back") {
                    bail!("Carte {n} : champs `front` (recto) et `back` (verso) attendus.");
                }
            }
            QuizKind::QuestionsOuvertes => {
                if !text(item, "question") {
                    bail!("Question {n} : champ `question` absent ou vide.");
                }
            }
        }
    }
    Ok(())
}

pub struct Library {
    pub(crate) data_dir: PathBuf,
    /// Dossier des cours (réglage `dossier_cours`) : base des chemins relatifs à l'import, et
    /// dossier des notes.
    pub(crate) courses_dir: Option<PathBuf>,
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
pub(crate) fn unique_id(base: &str, taken: impl Fn(&str) -> bool) -> String {
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
pub(crate) fn matches(id: &str, name: &str, wanted: &str) -> bool {
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

    pub(crate) fn cache_path(&self, document: &str) -> PathBuf {
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

    pub(crate) fn save(&self, lib: &LibraryFile) -> Result<()> {
        write_json(&self.library_path(), lib)
    }

    /// Indices de la matière et du chapitre désignés (identifiant ou nom), créés s'ils n'existent pas.
    pub(crate) fn ensure_chapter(lib: &mut LibraryFile, subject: &str, chapter: &str) -> (usize, usize) {
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
        (si, ci)
    }

    /// Identifiants de tous les documents de la bibliothèque.
    pub(crate) fn document_ids(lib: &LibraryFile) -> Vec<String> {
        lib.subjects
            .iter()
            .flat_map(|s| &s.chapters)
            .flat_map(|c| &c.documents)
            .map(|d| d.id.clone())
            .collect()
    }

    /// Texte de chaque page d'un document : le cache d'extraction ; pour une note, son fichier
    /// Markdown relu (modifications faites hors de Cadence comprises), le cache s'il a disparu.
    pub(crate) fn pages_of(&self, located: &Located) -> Result<Vec<String>> {
        let id = &located.document.id;
        if located.document.kind == DocKind::Note
            && let Ok(markdown) = fs::read_to_string(&located.document.source)
        {
            return Ok(extract::note_pages(&markdown));
        }
        let text = fs::read_to_string(self.cache_path(id))
            .with_context(|| format!("texte de « {id} » absent du cache : réimportez le document"))?;
        let cache: PageCache = serde_json::from_str(&text).context("cache illisible")?;
        Ok(cache.pages)
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

        let all_doc_ids = Self::document_ids(&lib);
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
        let (si, ci) = Self::ensure_chapter(&mut lib, subject, chapter);
        let ch = &mut lib.subjects[si].chapters[ci];

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
            updated_at: None,
            revision: 0,
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
        let mut located = self.find_document(document)?;
        let pages = self.pages_of(&located)?;
        let total = pages.len() as u32;
        // Une note relue depuis son fichier peut avoir changé de nombre de sections.
        located.document.pages = total;
        let from = from.max(1);
        if from > total {
            bail!("« {} » n'a que {total} page(s).", located.document.title);
        }
        let to = to
            .unwrap_or(from)
            .clamp(from, total)
            .min(from + MAX_PAGES_PER_READ - 1);
        let pages = (from..=to)
            .map(|n| (n, pages[(n - 1) as usize].clone()))
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
            let Ok(pages) = self.pages_of(&l) else { continue };
            for (i, page) in pages.iter().enumerate() {
                let folded = fold(page);
                let Some(pos) = folded.find(&needle) else { continue };
                // Extrait autour de la première occurrence (positions en caractères du texte replié).
                let start_char = folded[..pos].chars().count().saturating_sub(120);
                let excerpt: String = page.chars().skip(start_char).take(300).collect();
                hits.push(serde_json::json!({
                    "document": l.document.id,
                    "title": l.document.title,
                    "page": i + 1,
                    "kind": l.document.kind,
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
        check_items(kind, &items)?;
        if title.trim().is_empty() {
            bail!("Donnez un titre à l'entraînement.");
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
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.seq.cmp(&a.seq)));
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
            seq: self.results()?.iter().map(|r| r.seq).max().unwrap_or(0) + 1,
        };
        write_json(&dir.join(format!("{id}.json")), &result)?;
        Ok(result)
    }

    /// Corrige un QCM enregistré : `answers[i]` est l'indice choisi pour la question `i`
    /// (`None`, ou absent, pour une question passée). Le score (1 point par bonne réponse), la
    /// correction et un bilan sont enregistrés comme un résultat.
    pub fn grade_qcm(&self, quiz: &str, answers: &[Option<u32>]) -> Result<(QuizResult, Vec<QcmCorrection>)> {
        let quiz = self.quiz(quiz)?;
        if quiz.kind != QuizKind::Qcm {
            bail!(
                "« {} » n'est pas un QCM : enregistrez son résultat avec save_result.",
                quiz.title
            );
        }
        check_items(quiz.kind, &quiz.items)?;
        let items = quiz.items.as_array().map(Vec::as_slice).unwrap_or_default();
        if answers.len() > items.len() {
            bail!("{} réponses pour {} questions.", answers.len(), items.len());
        }
        let corrections: Vec<QcmCorrection> = items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let choices: Vec<String> = item["choices"]
                    .as_array()
                    .map(|c| c.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                let answer = item["answer"].as_u64().unwrap_or(0) as u32;
                let chosen = answers
                    .get(i)
                    .copied()
                    .flatten()
                    .filter(|c| (*c as usize) < choices.len());
                QcmCorrection {
                    question: item["question"].as_str().unwrap_or_default().to_string(),
                    choices,
                    chosen,
                    answer,
                    correct: chosen == Some(answer),
                    explanation: item
                        .get("explanation")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    source: item.get("source").cloned().unwrap_or(Value::Null),
                }
            })
            .collect();
        let score = corrections.iter().filter(|c| c.correct).count();
        let total = corrections.len();
        let missed: Vec<String> = corrections
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.correct)
            .map(|(i, _)| (i + 1).to_string())
            .collect();
        let feedback = if missed.is_empty() {
            format!("{score}/{total} : sans faute.")
        } else {
            format!("{score}/{total}. À revoir : question(s) {}.", missed.join(", "))
        };
        let result = self.save_result(
            &quiz.id,
            Some(score as f64),
            Some(total as f64),
            serde_json::to_value(&corrections)?,
            Some(feedback),
        )?;
        Ok((result, corrections))
    }

    /// Historique des scores, les plus récents d'abord, éventuellement d'un seul entraînement.
    pub fn history(&self, quiz: Option<&str>, limit: usize) -> Result<Vec<HistoryEntry>> {
        let quizzes = self.quizzes()?;
        let wanted = quiz.map(slugify);
        Ok(self
            .results()?
            .into_iter()
            .filter(|r| wanted.as_ref().is_none_or(|w| &r.quiz == w))
            .take(limit)
            .map(|r| {
                let q = quizzes.iter().find(|q| q.id == r.quiz);
                let percent = match (r.score, r.total) {
                    (Some(score), Some(total)) if total > 0.0 => {
                        Some((score / total * 100.0).round().clamp(0.0, 100.0) as u32)
                    }
                    _ => None,
                };
                HistoryEntry {
                    id: r.id,
                    quiz: r.quiz,
                    title: q.map(|q| q.title.clone()),
                    kind: q.map(|q| q.kind),
                    subject: q.and_then(|q| q.subject.clone()),
                    chapter: q.and_then(|q| q.chapter.clone()),
                    score: r.score,
                    total: r.total,
                    percent,
                    created_at: r.created_at,
                }
            })
            .collect())
    }
}

/// Écriture atomique (fichier temporaire puis renommage).
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    write_atomic(path, &serde_json::to_vec_pretty(value)?)
}

/// Écrit `bytes` dans un fichier temporaire voisin puis le renomme : jamais de fichier à moitié écrit.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().context("chemin sans dossier")?;
    fs::create_dir_all(dir).with_context(|| format!("création de {}", dir.display()))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).with_context(|| format!("écriture de {}", tmp.display()))?;
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
                json!([{ "question": "Charge de l'électron ?", "choices": ["+e", "-e"], "answer": 1 }]),
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
    fn checks_the_items_of_each_kind() {
        let ok_qcm = json!([{ "question": "Q ?", "choices": ["a", "b", "c"], "answer": 2 }]);
        assert!(check_items(QuizKind::Qcm, &ok_qcm).is_ok());
        let err = |kind, items: Value| check_items(kind, &items).unwrap_err().to_string();
        assert!(err(QuizKind::Qcm, json!([])).contains("non vide"));
        assert!(err(QuizKind::Qcm, json!([1])).contains("objet attendu"));
        assert!(err(QuizKind::Qcm, json!([{ "choices": ["a", "b"], "answer": 0 }])).contains("`question`"));
        assert!(
            err(
                QuizKind::Qcm,
                json!([{ "question": "Q", "choices": ["a"], "answer": 0 }])
            )
            .contains("au moins 2")
        );
        let out_of_range = err(
            QuizKind::Qcm,
            json!([ok_qcm[0], { "question": "Q", "choices": ["a", "b"], "answer": 2 }]),
        );
        assert!(
            out_of_range.starts_with("Question 2 :") && out_of_range.contains("2 choix"),
            "{out_of_range}"
        );
        assert!(
            err(
                QuizKind::Qcm,
                json!([{ "question": "Q", "choices": ["a", "b"], "answer": "a" }])
            )
            .contains("indice")
        );

        assert!(
            check_items(
                QuizKind::Flashcards,
                &json!([{ "front": "Z", "back": "Protons" }])
            )
            .is_ok()
        );
        assert!(err(QuizKind::Flashcards, json!([{ "front": "Z" }])).contains("Carte 1"));
        assert!(
            check_items(
                QuizKind::QuestionsOuvertes,
                &json!([{ "question": "Pourquoi ?", "points": 4 }])
            )
            .is_ok()
        );
        assert!(err(QuizKind::QuestionsOuvertes, json!([{ "points": 4 }])).contains("`question`"));
    }

    fn qcm(lib: &Library) -> Quiz {
        let items = json!([
            { "question": "Charge du proton ?", "choices": ["+e", "-e", "0"], "answer": 0,
              "explanation": "Charge élémentaire positive.", "source": { "document": "atomes", "page": 1 } },
            { "question": "Charge du neutron ?", "choices": ["+e", "0"], "answer": 1 },
            { "question": "Numéro atomique ?", "choices": ["Protons", "Nucléons"], "answer": 0 }
        ]);
        lib.save_quiz(
            QuizKind::Qcm,
            "Atomes",
            Some("chimie".into()),
            Some("atomistique".into()),
            json!([]),
            items,
        )
        .unwrap()
    }

    #[test]
    fn grades_a_qcm_and_saves_the_result() {
        let (_tmp, lib) = setup();
        let quiz = qcm(&lib);

        // Question 2 fausse, question 3 passée (réponse absente).
        let (result, corrections) = lib.grade_qcm(&quiz.id, &[Some(0), Some(0)]).unwrap();
        assert_eq!((result.score, result.total), (Some(1.0), Some(3.0)));
        assert_eq!(
            result.feedback.as_deref(),
            Some("1/3. À revoir : question(s) 2, 3.")
        );
        assert_eq!(
            corrections
                .iter()
                .map(|c| (c.chosen, c.correct))
                .collect::<Vec<_>>(),
            [(Some(0), true), (Some(0), false), (None, false)]
        );
        assert_eq!(
            corrections[0].explanation.as_deref(),
            Some("Charge élémentaire positive.")
        );
        assert_eq!(corrections[0].source, json!({ "document": "atomes", "page": 1 }));
        assert_eq!(corrections[1].source, Value::Null);
        // La correction est gardée avec le résultat.
        let saved = &lib.results().unwrap()[0];
        assert_eq!(saved.answers[1]["chosen"], json!(0));
        assert_eq!(saved.answers[1]["answer"], json!(1));

        let (perfect, _) = lib.grade_qcm(&quiz.id, &[Some(0), Some(1), Some(0)]).unwrap();
        assert_eq!(perfect.feedback.as_deref(), Some("3/3 : sans faute."));
        // Un indice hors des choix compte comme une question passée.
        let (_, odd) = lib.grade_qcm(&quiz.id, &[Some(7)]).unwrap();
        assert_eq!(odd[0].chosen, None);

        assert!(lib.grade_qcm(&quiz.id, &[None, None, None, None]).is_err());
        assert!(lib.grade_qcm("inconnu", &[]).is_err());
        let cards = lib
            .save_quiz(
                QuizKind::Flashcards,
                "Cartes",
                None,
                None,
                json!([]),
                json!([{ "front": "Z", "back": "Protons" }]),
            )
            .unwrap();
        assert!(
            lib.grade_qcm(&cards.id, &[])
                .unwrap_err()
                .to_string()
                .contains("n'est pas un QCM")
        );
    }

    #[test]
    fn keeps_the_score_history() {
        let (_tmp, lib) = setup();
        let quiz = qcm(&lib);
        let cards = lib
            .save_quiz(
                QuizKind::Flashcards,
                "Cartes",
                None,
                None,
                json!([]),
                json!([{ "front": "Z", "back": "Protons" }]),
            )
            .unwrap();
        lib.grade_qcm(&quiz.id, &[Some(0)]).unwrap();
        lib.grade_qcm(&quiz.id, &[Some(0), Some(1), Some(0)]).unwrap();
        lib.save_result(
            &cards.id,
            Some(1.0),
            Some(1.0),
            json!([{ "card": 0, "known": true }]),
            None,
        )
        .unwrap();
        lib.save_result(&cards.id, None, None, json!(null), None).unwrap();

        let all = lib.history(None, 50).unwrap();
        assert_eq!(all.len(), 4);
        // Les plus récents d'abord (même seconde : ordre d'enregistrement).
        assert_eq!(all[0].quiz, cards.id);
        assert_eq!(all[0].percent, None);
        assert_eq!(
            (all[1].kind, all[1].percent),
            (Some(QuizKind::Flashcards), Some(100))
        );
        assert_eq!((all[2].score, all[2].percent), (Some(3.0), Some(100)));
        assert_eq!(
            (all[3].title.as_deref(), all[3].percent),
            (Some("Atomes"), Some(33))
        );
        assert_eq!(all[3].subject.as_deref(), Some("chimie"));

        let only = lib.history(Some(&quiz.id), 1).unwrap();
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].score, Some(3.0));
        assert!(lib.history(Some("inconnu"), 10).unwrap().is_empty());
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
