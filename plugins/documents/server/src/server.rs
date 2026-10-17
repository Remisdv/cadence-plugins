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
    ErrorData as McpError, Peer, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, CustomNotification, Implementation, ServerCapabilities, ServerConfig,
        ServerNotification,
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
/// Notification vers Cadence, relayée aux écrans du plugin (`cadence.on(event, …)`).
pub const EVENT_NOTIFICATION: &str = "notifications/cadence/event";

/// Événement pour l'écran Entraînement : `quiz-saved` (`{ id, kind }`) ou `result-saved`
/// (`{ quiz, score, total }`). Sans écran ouvert, Cadence l'ignore ; un échec n'est que journalisé.
async fn emit(peer: &Peer<RoleServer>, event: &str, data: Value) {
    let params = json!({ "event": event, "data": data });
    let notification =
        ServerNotification::CustomNotification(CustomNotification::new(EVENT_NOTIFICATION, Some(params)));
    if let Err(err) = peer.send_notification(notification).await {
        tracing::warn!(event, "événement non envoyé : {err}");
    }
}

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
pub struct SubmitQcmParams {
    /// Identifiant du QCM (voir list_quizzes).
    pub quiz: String,
    /// Réponse à chaque question, dans l'ordre : indice du choix (à partir de 0), ou null pour une
    /// question passée. Les questions au-delà de la liste comptent comme passées.
    pub answers: Vec<Option<u32>>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListResultsParams {
    /// Identifiant d'un entraînement ; tous si absent.
    pub quiz: Option<String>,
    /// 50 résultats par défaut, 200 au plus.
    pub limit: Option<u32>,
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
    async fn save_quiz(
        &self,
        Parameters(p): Parameters<SaveQuizParams>,
        peer: Peer<RoleServer>,
    ) -> ToolResult {
        let saved = self
            .with(move |lib| {
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
            .await;
        if let Ok(v) = &saved {
            emit(
                &peer,
                "quiz-saved",
                json!({ "id": v["quiz"]["id"], "kind": v["quiz"]["kind"] }),
            )
            .await;
        }
        respond(saved)
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
    async fn save_result(
        &self,
        Parameters(p): Parameters<SaveResultParams>,
        peer: Peer<RoleServer>,
    ) -> ToolResult {
        let saved = self
            .with(move |lib| {
                let r = lib.save_result(
                    &p.quiz,
                    p.score,
                    p.total,
                    p.answers.unwrap_or(Value::Null),
                    p.feedback,
                )?;
                Ok(json!({ "result": r }))
            })
            .await;
        if let Ok(v) = &saved {
            emit(&peer, "result-saved", result_event(&v["result"])).await;
        }
        respond(saved)
    }

    #[tool(
        description = "Corrige un QCM enregistré à partir des réponses de l'étudiant (indice du choix, à partir de 0 ; null pour une question passée) : 1 point par bonne réponse. Enregistre le score et renvoie la correction question par question (bonne réponse, explication, source)."
    )]
    async fn submit_qcm(
        &self,
        Parameters(p): Parameters<SubmitQcmParams>,
        peer: Peer<RoleServer>,
    ) -> ToolResult {
        let graded = self
            .with(move |lib| {
                let (result, corrections) = lib.grade_qcm(&p.quiz, &p.answers)?;
                Ok(json!({ "result": result, "corrections": corrections }))
            })
            .await;
        if let Ok(v) = &graded {
            emit(&peer, "result-saved", result_event(&v["result"])).await;
        }
        respond(graded)
    }

    #[tool(
        description = "Historique des scores, les plus récents d'abord : entraînement (titre, type, matière, chapitre), score, total, pourcentage et date. Sert à repérer les notions à revoir."
    )]
    async fn list_results(&self, Parameters(p): Parameters<ListResultsParams>) -> ToolResult {
        respond(
            self.with(move |lib| {
                let limit = p.limit.unwrap_or(50).clamp(1, 200) as usize;
                Ok(json!({ "results": lib.history(p.quiz.as_deref(), limit)? }))
            })
            .await,
        )
    }
}

/// Charge de l'événement `result-saved`.
fn result_event(result: &Value) -> Value {
    json!({ "quiz": result["quiz"], "score": result["score"], "total": result["total"] })
}

#[tool_handler]
impl ServerHandler for Documents {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Bibliothèque de cours du plugin Cadence « Documents » : Matière → Chapitre → Documents. \
                 Lisez les documents à la demande (search puis read_pages) et citez toujours document et page. \
                 Les entraînements générés s'enregistrent avec save_quiz, les résultats avec save_result                  (submit_qcm corrige un QCM) ; list_results donne l'historique des scores.",
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
    use std::time::Duration;

    use rmcp::ServiceExt;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::*;
    use crate::extract::tests::pptx;

    /// Session MCP en mémoire, côté Cadence : envoie `messages` (JSON-RPC, une ligne chacun) l'un
    /// après l'autre, en attendant la réponse de chaque requête (rmcp traite les requêtes en
    /// parallèle), et renvoie tout ce que le serveur a écrit.
    async fn session(server: Documents, messages: &[Value]) -> Vec<Value> {
        let (client, transport) = tokio::io::duplex(256 * 1024);
        tokio::spawn(async move {
            if let Ok(service) = server.serve(tokio::io::split(transport)).await {
                let _ = service.waiting().await;
            }
        });
        let (read, mut write) = tokio::io::split(client);
        let mut lines = BufReader::new(read).lines();
        let init = json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": { "name": "cadence-test", "version": "0.0.0" } }
        });
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let mut received = Vec::new();
        for message in [init, initialized].iter().chain(messages) {
            write
                .write_all(
                    format!(
                        "{message}
"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let Some(id) = message.get("id") else { continue };
            loop {
                let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
                    .await
                    .expect("pas de réponse du serveur")
                    .unwrap()
                    .expect("flux fermé");
                let reply: Value = serde_json::from_str(&line).unwrap();
                let done = &reply["id"] == id;
                received.push(reply);
                if done {
                    break;
                }
            }
        }
        received
    }

    fn call(id: u64, tool: &str, args: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": args } })
    }

    #[tokio::test]
    async fn grades_a_qcm_over_mcp_and_notifies_the_screen() {
        let tmp = tempfile::tempdir().unwrap();
        let items = json!([
            { "question": "Charge du proton ?", "choices": ["+e", "-e"], "answer": 0, "source": { "document": "atomes", "page": 1 } },
            { "question": "Charge du neutron ?", "choices": ["+e", "0"], "answer": 1 }
        ]);
        let out = session(
            Documents::new(tmp.path().to_path_buf(), None),
            &[
                call(
                    1,
                    "save_quiz",
                    json!({ "kind": "qcm", "title": "Atomes", "items": items }),
                ),
                call(
                    2,
                    "submit_qcm",
                    json!({ "quiz": "qcm-atomes", "answers": [0, null] }),
                ),
                call(3, "list_results", json!({})),
                call(
                    4,
                    "save_quiz",
                    json!({ "kind": "qcm", "title": "Mal formé", "items": [{ "question": "?" }] }),
                ),
            ],
        )
        .await;
        let event = |name: &str| {
            out.iter()
                .find(|m| m["method"] == EVENT_NOTIFICATION && m["params"]["event"] == name)
                .map(|m| m["params"]["data"].clone())
        };
        let response = |id: u64| out.iter().find(|m| m["id"] == json!(id)).unwrap()["result"].clone();

        assert_eq!(
            event("quiz-saved"),
            Some(json!({ "id": "qcm-atomes", "kind": "qcm" }))
        );
        assert_eq!(
            event("result-saved"),
            Some(json!({ "quiz": "qcm-atomes", "score": 1.0, "total": 2.0 }))
        );

        let graded = &response(2)["structuredContent"];
        assert_eq!(graded["result"]["feedback"], "1/2. À revoir : question(s) 2.");
        assert_eq!(graded["corrections"][0]["correct"], true);
        assert_eq!(graded["corrections"][1]["chosen"], Value::Null);

        let history = &response(3)["structuredContent"]["results"];
        assert_eq!(
            (history[0]["title"].clone(), history[0]["percent"].clone()),
            (json!("Atomes"), json!(50))
        );

        // Format refusé : erreur d'outil lisible par l'IA, pas d'événement de plus.
        let refused = response(4);
        assert_eq!(refused["isError"], true);
        assert!(
            refused["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Question 1")
        );
        assert_eq!(
            out.iter()
                .filter(|m| m["params"]["event"] == "quiz-saved")
                .count(),
            1
        );
    }

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
            "submit_qcm",
            "list_results",
        ] {
            assert!(names.iter().any(|n| n == expected), "outil {expected} absent");
        }
    }
}
