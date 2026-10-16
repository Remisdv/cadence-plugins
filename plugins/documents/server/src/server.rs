//! Outils MCP du plugin Documents (exposés aux IA en `documents__<outil>`).
//!
//! Un seul processus pour le plugin : une bibliothèque dans `CADENCE_DATA_DIR`, et le dossier
//! des cours lu dans les réglages globaux (`CADENCE_SETTINGS`, puis
//! `notifications/cadence/settings`).

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Result, anyhow};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, CustomNotification, Implementation, ServerCapabilities, ServerConfig,
    },
    service::NotificationContext,
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    extract::SUPPORTED,
    library::{Library, MAX_PAGES_PER_READ, QuizKind},
};

type ToolResult = Result<CallToolResult, McpError>;

/// Notification de Cadence : réglages globaux modifiés.
pub const SETTINGS_NOTIFICATION: &str = "notifications/cadence/settings";

/// Dossier des cours d'après les réglages (`dossier_cours`) : `{ "settings": {…} }` ou l'objet
/// seul. Vide ou relatif (ancien réglage « relatif à l'espace ») : aucun dossier.
pub fn courses_dir_from_settings(settings: &Value) -> Option<PathBuf> {
    let settings = settings.get("settings").unwrap_or(settings);
    let dir = settings.get("dossier_cours")?.as_str()?.trim();
    if dir.is_empty() {
        return None;
    }
    if !Path::new(dir).is_absolute() {
        tracing::warn!("dossier des cours « {dir} » ignoré : chemin absolu attendu");
        return None;
    }
    Some(PathBuf::from(dir))
}

fn respond(result: Result<Value>) -> ToolResult {
    Ok(match result {
        Ok(Value::Object(map)) => CallToolResult::structured(Value::Object(map)),
        Ok(other) => CallToolResult::structured(json!({ "result": other })),
        Err(err) => CallToolResult::error(vec![ContentBlock::text(format!("{err:#}"))]),
    })
}

/* ---------- Paramètres ---------- */

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct Empty {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SubjectParams {
    /// Matière : identifiant (`chimie`) ou nom (« Chimie »).
    pub subject: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListDocumentsParams {
    /// Matière (identifiant ou nom) ; toutes si absent.
    pub subject: Option<String>,
    /// Chapitre (identifiant ou nom) ; tous si absent.
    pub chapter: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ImportParams {
    /// Chemin du fichier, absolu ou relatif au dossier des cours (réglage).
    pub path: String,
    /// Matière (créée si elle n'existe pas).
    pub subject: String,
    /// Chapitre (créé s'il n'existe pas).
    pub chapter: String,
    /// Titre affiché ; le nom du fichier par défaut.
    pub title: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadPagesParams {
    /// Identifiant du document (voir list_documents) ou son titre exact.
    pub document: String,
    /// Première page, à partir de 1 (1 par défaut).
    pub from: Option<u32>,
    /// Dernière page incluse (`from` par défaut) ; 20 pages au plus par appel.
    pub to: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SearchParams {
    /// Mots à chercher (sans tenir compte des accents ni de la casse).
    pub query: String,
    pub subject: Option<String>,
    pub chapter: Option<String>,
    /// 20 résultats par défaut, 50 au plus.
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveQuizParams {
    /// qcm, questions_ouvertes ou flashcards.
    pub kind: QuizKind,
    pub title: String,
    pub subject: Option<String>,
    pub chapter: Option<String>,
    /// Documents et pages utilisés : [{ "document": "atomes", "pages": [1, 2] }].
    #[serde(default)]
    pub sources: Option<Value>,
    /// Questions ou cartes, chacune avec sa source (document + page). Format décrit dans le skill.
    pub items: Value,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetQuizParams {
    pub id: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListQuizzesParams {
    pub subject: Option<String>,
    pub chapter: Option<String>,
    pub kind: Option<QuizKind>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveResultParams {
    /// Identifiant du quiz.
    pub quiz: String,
    /// Points obtenus.
    pub score: Option<f64>,
    /// Points possibles.
    pub total: Option<f64>,
    /// Réponses données et correction par question.
    #[serde(default)]
    pub answers: Option<Value>,
    /// Bilan rédigé pour l'étudiant.
    pub feedback: Option<String>,
}

/* ---------- Serveur ---------- */

#[derive(Clone)]
pub struct Documents {
    /// Une écriture à la fois dans library.json.
    library: Arc<Mutex<Library>>,
    #[allow(dead_code)] // lu par #[tool_handler]
    tool_router: ToolRouter<Self>,
}

impl Documents {
    pub fn new(data_dir: PathBuf, courses_dir: Option<PathBuf>) -> Self {
        Documents {
            library: Arc::new(Mutex::new(Library::new(data_dir, courses_dir))),
            tool_router: Self::tool_router(),
        }
    }

    /// Applique une notification de Cadence ; faux si elle ne concerne pas ce serveur.
    pub async fn apply_notification(&self, method: &str, params: Option<&Value>) -> bool {
        if method != SETTINGS_NOTIFICATION {
            return false;
        }
        let dir = params.and_then(courses_dir_from_settings);
        tracing::info!(dossier = ?dir, "réglages mis à jour");
        self.library.lock().await.set_courses_dir(dir);
        true
    }

    /// Exécute une opération de bibliothèque (E/S bloquantes) hors du fil asynchrone.
    async fn with<F>(&self, f: F) -> Result<Value>
    where
        F: FnOnce(&Library) -> Result<Value> + Send + 'static,
    {
        let lib = self.library.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || f(&lib))
            .await
            .map_err(|e| anyhow!("tâche interrompue : {e}"))?
    }
}

#[tool_router]
impl Documents {
    #[tool(
        description = "Liste les matières de la bibliothèque avec leur nombre de chapitres et de documents, et le dossier des cours réglé."
    )]
    async fn list_subjects(&self, Parameters(_): Parameters<Empty>) -> ToolResult {
        respond(
            self.with(|lib| {
                let l = lib.load()?;
                let subjects: Vec<Value> = l
                    .subjects
                    .iter()
                    .map(|s| {
                        json!({
                            "id": s.id, "name": s.name, "chapters": s.chapters.len(),
                            "documents": s.chapters.iter().map(|c| c.documents.len()).sum::<usize>(),
                        })
                    })
                    .collect();
                Ok(json!({ "subjects": subjects, "courses_dir": lib.courses_dir() }))
            })
            .await,
        )
    }

    #[tool(
        description = "Liste les chapitres d'une matière avec leurs documents (identifiant, titre, nombre de pages)."
    )]
    async fn list_chapters(&self, Parameters(p): Parameters<SubjectParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                let l = lib.load()?;
                let s = lib.subject(&l, &p.subject)?;
                let chapters: Vec<Value> = s
                    .chapters
                    .iter()
                    .map(|c| {
                        json!({
                            "id": c.id, "name": c.name,
                            "documents": c.documents.iter().map(|d| json!({ "id": d.id, "title": d.title, "pages": d.pages })).collect::<Vec<_>>(),
                        })
                    })
                    .collect();
                Ok(json!({ "subject": s.id, "name": s.name, "chapters": chapters }))
            })
            .await,
        )
    }

    #[tool(
        description = "Liste les documents, éventuellement d'une matière et d'un chapitre : identifiant, titre, format, nombre de pages, unité de page (page, diapositive ou bloc de texte) et fichier d'origine."
    )]
    async fn list_documents(&self, Parameters(p): Parameters<ListDocumentsParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                Ok(json!({ "documents": lib.documents(p.subject.as_deref(), p.chapter.as_deref())? }))
            })
            .await,
        )
    }

    #[tool(
        description = "Importe un cours dans la bibliothèque : extrait son texte page par page (PDF, Word .docx, PowerPoint .pptx, Markdown, texte) et le range dans une matière et un chapitre, créés s'ils n'existent pas. Réimporter le même fichier met son texte à jour."
    )]
    async fn import_document(&self, Parameters(p): Parameters<ImportParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                let doc = lib
                    .import(&p.path, &p.subject, &p.chapter, p.title.as_deref())
                    .map_err(|e| {
                        if e.to_string().contains("Format non pris en charge") {
                            e
                        } else {
                            e.context(format!("Formats acceptés : {SUPPORTED}"))
                        }
                    })?;
                Ok(json!({ "document": doc }))
            })
            .await,
        )
    }

    #[tool(
        description = "Lit le texte d'une plage de pages d'un document (20 pages au plus par appel), depuis le cache d'extraction. Citez toujours le document et le numéro de page (ou de diapositive) de ce que vous en tirez."
    )]
    async fn read_pages(&self, Parameters(p): Parameters<ReadPagesParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                let (doc, pages) = lib.read_pages(&p.document, p.from.unwrap_or(1), p.to)?;
                let last = pages.last().map(|(n, _)| *n).unwrap_or(0);
                Ok(json!({
                    "document": doc.document.id,
                    "title": doc.document.title,
                    "subject": doc.subject_name,
                    "chapter": doc.chapter_name,
                    "page_unit": doc.page_unit,
                    "total_pages": doc.document.pages,
                    "pages": pages.into_iter().map(|(page, text)| json!({ "page": page, "text": text })).collect::<Vec<_>>(),
                    "next_page": (last < doc.document.pages).then_some(last + 1),
                    "max_pages_per_read": MAX_PAGES_PER_READ,
                }))
            })
            .await,
        )
    }

    #[tool(
        description = "Cherche des mots dans le texte des documents (sans accents ni casse) et renvoie document, page et extrait : sert à savoir quelles pages lire avec read_pages."
    )]
    async fn search(&self, Parameters(p): Parameters<SearchParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                let limit = p.limit.unwrap_or(20).clamp(1, 50) as usize;
                Ok(json!({ "hits": lib.search(&p.query, p.subject.as_deref(), p.chapter.as_deref(), limit)? }))
            })
            .await,
        )
    }

    #[tool(
        description = "Enregistre un entraînement généré (QCM, questions ouvertes ou flashcards) pour l'écran Entraînement. Chaque élément de `items` porte sa source (document + page)."
    )]
    async fn save_quiz(&self, Parameters(p): Parameters<SaveQuizParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                let quiz = lib.save_quiz(
                    p.kind,
                    &p.title,
                    p.subject,
                    p.chapter,
                    p.sources.unwrap_or(json!([])),
                    p.items,
                )?;
                Ok(json!({ "quiz": quiz }))
            })
            .await,
        )
    }

    #[tool(
        description = "Liste les entraînements enregistrés (les plus récents d'abord), avec le dernier score obtenu."
    )]
    async fn list_quizzes(&self, Parameters(p): Parameters<ListQuizzesParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                let results = lib.results()?;
                let keep = |v: &Option<String>, w: &Option<String>| w.as_ref().is_none_or(|w| v.as_deref() == Some(w.as_str()));
                let quizzes: Vec<Value> = lib
                    .quizzes()?
                    .into_iter()
                    .filter(|q| keep(&q.subject, &p.subject) && keep(&q.chapter, &p.chapter) && p.kind.is_none_or(|k| k == q.kind))
                    .map(|q| {
                        let last = results.iter().find(|r| r.quiz == q.id);
                        json!({
                            "id": q.id, "kind": q.kind, "title": q.title, "subject": q.subject, "chapter": q.chapter,
                            "items": q.items.as_array().map(Vec::len).unwrap_or(0), "created_at": q.created_at,
                            "last_result": last.map(|r| json!({ "score": r.score, "total": r.total, "at": r.created_at })),
                        })
                    })
                    .collect();
                Ok(json!({ "quizzes": quizzes }))
            })
            .await,
        )
    }

    #[tool(description = "Lit un entraînement enregistré : questions ou cartes avec leurs sources.")]
    async fn get_quiz(&self, Parameters(p): Parameters<GetQuizParams>) -> ToolResult {
        respond(
            self.with(move |lib| Ok(json!({ "quiz": lib.quiz(&p.id)? })))
                .await,
        )
    }

    #[tool(description = "Enregistre le résultat d'un entraînement : score, réponses corrigées et bilan.")]
    async fn save_result(&self, Parameters(p): Parameters<SaveResultParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                let r = lib.save_result(
                    &p.quiz,
                    p.score,
                    p.total,
                    p.answers.unwrap_or(Value::Null),
                    p.feedback,
                )?;
                Ok(json!({ "result": r }))
            })
            .await,
        )
    }
}

#[tool_handler]
impl ServerHandler for Documents {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Bibliothèque de cours du plugin Cadence « Documents » : Matière → Chapitre → Documents. \
                 Lisez les documents à la demande (search puis read_pages) et citez toujours document et page. \
                 Les entraînements générés s'enregistrent avec save_quiz, les résultats avec save_result.",
            )
    }

    fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _context: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + Send + '_ {
        async move {
            if !self
                .apply_notification(&notification.method, notification.params.as_ref())
                .await
            {
                tracing::debug!(method = %notification.method, "notification ignorée");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::tests::pptx;

    #[tokio::test]
    async fn imports_then_reads_through_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let courses = tmp.path().join("cours");
        std::fs::create_dir_all(&courses).unwrap();
        std::fs::write(courses.join("cours.pptx"), pptx(&["Intro", "Suite"])).unwrap();
        let server = Documents::new(tmp.path().join("data"), Some(courses));

        let imported = server
            .import_document(Parameters(ImportParams {
                path: "cours.pptx".into(),
                subject: "Info".into(),
                chapter: "Réseaux".into(),
                title: None,
            }))
            .await
            .unwrap();
        assert_ne!(imported.is_error, Some(true), "{:?}", imported.content);

        let read = server
            .read_pages(Parameters(ReadPagesParams {
                document: "cours".into(),
                from: Some(2),
                to: None,
            }))
            .await
            .unwrap();
        let body = read.structured_content.unwrap();
        assert_eq!(body["pages"][0], json!({ "page": 2, "text": "Suite" }));
        assert_eq!(body["page_unit"], "diapositive");
        assert_eq!(body["next_page"], Value::Null);

        let missing = server
            .import_document(Parameters(ImportParams {
                path: "absent.pdf".into(),
                subject: "Info".into(),
                chapter: "Réseaux".into(),
                title: None,
            }))
            .await
            .unwrap();
        assert_eq!(missing.is_error, Some(true));
    }

    #[tokio::test]
    async fn follows_the_courses_folder_setting() {
        let tmp = tempfile::tempdir().unwrap();
        let courses = tmp.path().join("cours");
        std::fs::create_dir_all(&courses).unwrap();
        std::fs::write(courses.join("td.pptx"), pptx(&["Exercice"])).unwrap();
        let server = Documents::new(tmp.path().join("data"), None);
        let import = || {
            server.import_document(Parameters(ImportParams {
                path: "td.pptx".into(),
                subject: "Info".into(),
                chapter: "TD".into(),
                title: None,
            }))
        };

        // Sans dossier des cours, un chemin relatif est refusé.
        let r = import().await.unwrap();
        assert_eq!(r.is_error, Some(true));
        assert!(format!("{:?}", r.content).contains("dossier des cours"));

        let settings = json!({ "settings": { "dossier_cours": courses.to_string_lossy() } });
        assert!(
            server
                .apply_notification(SETTINGS_NOTIFICATION, Some(&settings))
                .await
        );
        let r = import().await.unwrap();
        assert_ne!(r.is_error, Some(true), "{:?}", r.content);
        assert!(!server.apply_notification("notifications/autre", None).await);
    }

    #[test]
    fn reads_the_courses_folder_from_settings() {
        let abs = std::env::temp_dir();
        let abs_str = abs.to_string_lossy().to_string();
        assert_eq!(
            courses_dir_from_settings(&json!({ "dossier_cours": abs_str })),
            Some(abs.clone())
        );
        assert_eq!(
            courses_dir_from_settings(&json!({ "settings": { "dossier_cours": abs_str } })),
            Some(abs)
        );
        assert_eq!(courses_dir_from_settings(&json!({ "dossier_cours": "" })), None);
        assert_eq!(
            courses_dir_from_settings(&json!({ "dossier_cours": "cours/l3" })),
            None
        );
        assert_eq!(courses_dir_from_settings(&json!({})), None);
    }

    #[test]
    fn declares_the_contract_tools() {
        let server = Documents::new(PathBuf::from("."), None);
        let names: Vec<String> = server
            .tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        for expected in [
            "list_subjects",
            "list_chapters",
            "list_documents",
            "import_document",
            "read_pages",
            "save_quiz",
            "save_result",
            "search",
            "list_quizzes",
            "get_quiz",
        ] {
            assert!(names.iter().any(|n| n == expected), "outil {expected} absent");
        }
    }
}
