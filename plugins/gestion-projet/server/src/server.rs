//! Outils MCP du plugin Gestion de projet (exposés aux IA en `gestion-projet__<outil>`).
//!
//! Implémentés : `get_account` (réservé à l'UI), `get_repository`, `list_issues`, `get_issue`,
//! `create_issue`, `update_issue`, `add_comment`, `list_milestones`.
//! À faire (TODO, répondent « pas encore implémenté ») : `create_milestone`, `update_milestone`,
//! `list_pull_requests`, `get_pull_request`, `create_pull_request`, `mark_pull_request_ready`,
//! `list_releases`, `create_release`, `sprint_summary`.

use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, Implementation, MetaObject, ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    config::{Env, Settings},
    github::GitHub,
    model::{self, IssueType, Status},
};

type ToolResult = Result<CallToolResult, McpError>;

/// `_meta` d'un outil appelable seulement par l'UI du plugin (contrat Cadence).
fn ui_only() -> MetaObject {
    let mut meta = MetaObject::new();
    meta.0.insert("cadence/visibility".into(), json!("ui"));
    meta
}

/// Résultat d'outil : objet structuré, ou erreur d'outil lisible par l'IA (`isError`).
fn respond(result: Result<Value>) -> ToolResult {
    Ok(match result {
        Ok(Value::Object(map)) => CallToolResult::structured(Value::Object(map)),
        Ok(other) => CallToolResult::structured(json!({ "result": other })),
        Err(err) => CallToolResult::error(vec![ContentBlock::text(format!("{err:#}"))]),
    })
}

/// Réponse des outils pas encore écrits.
fn todo(tool: &str) -> ToolResult {
    Ok(CallToolResult::error(vec![ContentBlock::text(format!(
        "L'outil {tool} n'est pas encore implémenté dans cette version du plugin (TODO). \
         Faites l'opération avec git ou l'interface GitHub, puis continuez."
    ))]))
}

/* ---------- Paramètres ---------- */

#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum StateFilter {
    #[default]
    Open,
    Closed,
    All,
}

impl StateFilter {
    fn as_str(self) -> &'static str {
        match self {
            StateFilter::Open => "open",
            StateFilter::Closed => "closed",
            StateFilter::All => "all",
        }
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListIssuesParams {
    /// open (défaut), closed ou all.
    #[serde(default)]
    pub state: StateFilter,
    /// Version (titre du milestone, ex. « 0.1.2 »), « none » pour les issues sans version, « * » pour toutes.
    pub milestone: Option<String>,
    /// Labels exigés (tous), ex. ["type/fix", "area/api"].
    #[serde(default)]
    pub labels: Vec<String>,
    /// Login assigné, « none » ou « * ».
    pub assignee: Option<String>,
    /// 1 à 100, 50 par défaut.
    pub per_page: Option<u32>,
    /// Page, à partir de 1.
    pub page: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetIssueParams {
    /// Numéro de l'issue.
    pub number: u32,
    /// Inclure les commentaires (vrai par défaut).
    pub comments: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateIssueParams {
    pub title: String,
    /// Description en markdown.
    pub body: Option<String>,
    /// Type conventionnel, posé en label `type/<type>`.
    #[serde(rename = "type")]
    pub issue_type: Option<IssueType>,
    /// État initial, posé en label `status/<état>`.
    pub status: Option<Status>,
    /// Labels supplémentaires (ex. `area/api`, `estimate/M`).
    #[serde(default)]
    pub labels: Vec<String>,
    /// Version : titre du milestone (ex. « 0.2.0 »).
    pub milestone: Option<String>,
    /// Logins à assigner.
    #[serde(default)]
    pub assignees: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StateReason {
    Completed,
    NotPlanned,
    Reopened,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateIssueParams {
    pub number: u32,
    pub title: Option<String>,
    /// Nouvelle description complète (markdown).
    pub body: Option<String>,
    pub state: Option<IssueState>,
    pub state_reason: Option<StateReason>,
    /// Change l'état d'avancement (remplace le label `status/*`).
    pub status: Option<Status>,
    /// Remplace tous les labels.
    pub labels: Option<Vec<String>>,
    /// Labels à ajouter.
    #[serde(default)]
    pub add_labels: Vec<String>,
    /// Labels à retirer.
    #[serde(default)]
    pub remove_labels: Vec<String>,
    /// Titre du milestone ; chaîne vide pour retirer la version.
    pub milestone: Option<String>,
    /// Remplace les assignés.
    pub assignees: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddCommentParams {
    /// Numéro de l'issue ou de la pull request.
    pub number: u32,
    /// Commentaire en markdown.
    pub body: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListMilestonesParams {
    /// open (défaut), closed ou all.
    #[serde(default)]
    pub state: StateFilter,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct Empty {}

#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)] // TODO : lu quand l'outil sera implémenté
pub struct MilestoneParams {
    /// Version semver, ex. « 0.1.3 ».
    pub title: String,
    pub description: Option<String>,
    /// Échéance (AAAA-MM-JJ) : un milestone daté est un sprint, sans date un palier.
    pub due_on: Option<String>,
    pub state: Option<IssueState>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)] // TODO : lu quand l'outil sera implémenté
pub struct NumberParams {
    pub number: u32,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)] // TODO : lu quand l'outil sera implémenté
pub struct CreatePullRequestParams {
    pub title: String,
    /// Branche source (jamais la branche par défaut).
    pub head: String,
    /// Branche cible ; la branche par défaut du dépôt si absente.
    pub base: Option<String>,
    pub body: Option<String>,
    /// Ouvrir en brouillon (vrai par défaut).
    pub draft: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)] // TODO : lu quand l'outil sera implémenté
pub struct CreateReleaseParams {
    /// Version semver ; le tag est `<préfixe><version>`.
    pub version: String,
    /// Notes de version en markdown.
    pub notes: String,
    /// Commit ou branche à taguer si le tag n'existe pas encore.
    pub target: Option<String>,
    /// Créer en brouillon (vrai par défaut).
    pub draft: Option<bool>,
}

/* ---------- Serveur ---------- */

#[derive(Clone)]
pub struct GestionProjet {
    gh: Arc<GitHub>,
    settings: Arc<Settings>,
    #[allow(dead_code)] // lu par #[tool_handler]
    tool_router: ToolRouter<Self>,
}

impl GestionProjet {
    pub fn new(env: &Env) -> Result<Self> {
        Ok(GestionProjet {
            gh: Arc::new(GitHub::new(&env.api_url, env.token.clone())?),
            settings: Arc::new(Settings::load(env)),
            tool_router: Self::tool_router(),
        })
    }

    fn repo(&self) -> Result<&str> {
        self.settings.repository.as_deref().ok_or_else(|| {
            anyhow!(
                "Aucun dépôt GitHub réglé pour cet espace : renseignez « Dépôt » (owner/name) dans les réglages \
                 du plugin, ou ajoutez un remote origin GitHub au dossier de l'espace."
            )
        })
    }

    async fn milestones(&self, state: &str) -> Result<Vec<Value>> {
        let repo = self.repo()?;
        let mut out = Vec::new();
        for page in 1..=10u32 {
            let p = self
                .gh
                .get_page(
                    &format!("/repos/{repo}/milestones"),
                    &[
                        ("state", state.into()),
                        ("per_page", "100".into()),
                        ("page", page.to_string()),
                    ],
                )
                .await?;
            out.extend(p.body.as_array().cloned().unwrap_or_default());
            if !p.has_next {
                break;
            }
        }
        Ok(out)
    }

    /// Numéro du milestone d'une version (titre, avec ou sans préfixe de tag).
    async fn milestone_number(&self, title: &str) -> Result<u32> {
        let all = self.milestones("all").await?;
        let m = model::find_milestone(&all, title, &self.settings.tag_prefix).ok_or_else(|| {
            anyhow!(
                "Version « {title} » introuvable : aucun milestone de ce nom dans {}.",
                self.repo().unwrap_or("?")
            )
        })?;
        m["number"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .context("numéro de milestone illisible")
    }

    async fn raw_issue(&self, number: u32) -> Result<Value> {
        let repo = self.repo()?;
        self.gh.get(&format!("/repos/{repo}/issues/{number}"), &[]).await
    }

    async fn do_list_issues(&self, p: ListIssuesParams) -> Result<Value> {
        let repo = self.repo()?;
        let per_page = p.per_page.unwrap_or(50).clamp(1, 100);
        let page = p.page.unwrap_or(1).max(1);
        let mut query = vec![
            ("state", p.state.as_str().to_string()),
            ("per_page", per_page.to_string()),
            ("page", page.to_string()),
            ("sort", "updated".to_string()),
        ];
        match p.milestone.as_deref().map(str::trim) {
            None | Some("") => {}
            Some(m @ ("none" | "*")) => query.push(("milestone", m.to_string())),
            Some(title) => query.push(("milestone", self.milestone_number(title).await?.to_string())),
        }
        if !p.labels.is_empty() {
            query.push(("labels", p.labels.join(",")));
        }
        if let Some(a) = p.assignee.filter(|a| !a.trim().is_empty()) {
            query.push(("assignee", a));
        }
        let res = self.gh.get_page(&format!("/repos/{repo}/issues"), &query).await?;
        // L'API issues renvoie aussi les pull requests : on les écarte.
        let issues: Vec<model::Issue> = res
            .body
            .as_array()
            .into_iter()
            .flatten()
            .filter(|raw| !model::is_pull_request(raw))
            .map(|raw| model::issue_from(raw, false))
            .collect();
        Ok(json!({ "repository": repo, "issues": issues, "page": page, "has_more": res.has_next }))
    }

    async fn do_get_issue(&self, p: GetIssueParams) -> Result<Value> {
        let repo = self.repo()?;
        let raw = self.raw_issue(p.number).await?;
        if model::is_pull_request(&raw) {
            bail!("#{} est une pull request, pas une issue.", p.number);
        }
        let issue = model::issue_from(&raw, true);
        let mut out = serde_json::to_value(&issue)?;
        if p.comments.unwrap_or(true) && issue.comments > 0 {
            let comments = self
                .gh
                .get(
                    &format!("/repos/{repo}/issues/{}/comments", p.number),
                    &[("per_page", "100".into())],
                )
                .await?;
            out["comment_list"] = Value::Array(
                comments
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| {
                        json!({
                            "author": c["user"]["login"],
                            "created_at": c["created_at"],
                            "body": c["body"],
                        })
                    })
                    .collect(),
            );
        }
        Ok(out)
    }

    async fn do_create_issue(&self, p: CreateIssueParams) -> Result<Value> {
        let repo = self.repo()?;
        if p.title.trim().is_empty() {
            bail!("Titre vide.");
        }
        let mut labels: Vec<String> = Vec::new();
        labels.extend(p.issue_type.map(IssueType::label));
        labels.extend(p.status.map(|s| s.label().to_string()));
        labels = model::edit_labels(&labels, &p.labels, &[]);
        let mut body =
            json!({ "title": p.title.trim(), "body": p.body.unwrap_or_default(), "labels": labels });
        if let Some(m) = p.milestone.filter(|m| !m.trim().is_empty()) {
            body["milestone"] = json!(self.milestone_number(&m).await?);
        }
        if !p.assignees.is_empty() {
            body["assignees"] = json!(p.assignees);
        }
        let raw = self.gh.post(&format!("/repos/{repo}/issues"), &body).await?;
        Ok(serde_json::to_value(model::issue_from(&raw, true))?)
    }

    async fn do_update_issue(&self, p: UpdateIssueParams) -> Result<Value> {
        let repo = self.repo()?;
        let mut body = json!({});
        if let Some(t) = p.title.filter(|t| !t.trim().is_empty()) {
            body["title"] = json!(t.trim());
        }
        if let Some(b) = p.body {
            body["body"] = json!(b);
        }
        if let Some(s) = p.state {
            body["state"] = json!(match s {
                IssueState::Open => "open",
                IssueState::Closed => "closed",
            });
        }
        if let Some(r) = p.state_reason {
            body["state_reason"] = json!(match r {
                StateReason::Completed => "completed",
                StateReason::NotPlanned => "not_planned",
                StateReason::Reopened => "reopened",
            });
        }
        let touches_labels = p.labels.is_some()
            || p.status.is_some()
            || !p.add_labels.is_empty()
            || !p.remove_labels.is_empty();
        if touches_labels {
            let mut labels = match p.labels {
                Some(l) => l,
                None => model::issue_from(&self.raw_issue(p.number).await?, false).labels,
            };
            labels = model::edit_labels(&labels, &p.add_labels, &p.remove_labels);
            if let Some(s) = p.status {
                labels = model::with_status(&labels, s);
            }
            body["labels"] = json!(labels);
        }
        match p.milestone.as_deref().map(str::trim) {
            None => {}
            Some("") => body["milestone"] = Value::Null,
            Some(title) => body["milestone"] = json!(self.milestone_number(title).await?),
        }
        if let Some(a) = p.assignees {
            body["assignees"] = json!(a);
        }
        if body.as_object().is_some_and(|o| o.is_empty()) {
            bail!("Rien à modifier : précisez au moins un champ.");
        }
        let raw = self
            .gh
            .patch(&format!("/repos/{repo}/issues/{}", p.number), &body)
            .await?;
        Ok(serde_json::to_value(model::issue_from(&raw, true))?)
    }
}

#[tool_router]
impl GestionProjet {
    #[tool(
        description = "Compte GitHub du jeton enregistré (login, nom, avatar) : sert à vérifier la connexion dans l'étape de configuration.",
        meta = ui_only()
    )]
    async fn get_account(&self, Parameters(_): Parameters<Empty>) -> ToolResult {
        respond(
            async {
                let user = self.gh.get("/user", &[]).await?;
                Ok(json!({
                    "login": user["login"],
                    "name": user["name"],
                    "avatar_url": user["avatar_url"],
                    "repository": self.settings.repository,
                }))
            }
            .await,
        )
    }

    #[tool(
        description = "Dépôt GitHub de l'espace : nom complet, branche par défaut, visibilité, URL. À lire avant de créer une branche ou une PR."
    )]
    async fn get_repository(&self, Parameters(_): Parameters<Empty>) -> ToolResult {
        respond(
            async {
                let repo = self.repo()?;
                let r = self.gh.get(&format!("/repos/{repo}"), &[]).await?;
                Ok(json!({
                    "full_name": r["full_name"],
                    "default_branch": r["default_branch"],
                    "private": r["private"],
                    "url": r["html_url"],
                    "open_issues": r["open_issues_count"],
                    "tag_prefix": self.settings.tag_prefix,
                    "sprint_length_days": self.settings.sprint_length_days,
                }))
            }
            .await,
        )
    }

    #[tool(
        description = "Liste les issues du dépôt (sans les pull requests), triées par dernière mise à jour. Chaque issue porte son type (label type/*), son état (todo, doing, review, done), son estimation et sa version (milestone)."
    )]
    async fn list_issues(&self, Parameters(p): Parameters<ListIssuesParams>) -> ToolResult {
        respond(self.do_list_issues(p).await)
    }

    #[tool(
        description = "Lit une issue : titre, description markdown, labels, version, assignés et commentaires."
    )]
    async fn get_issue(&self, Parameters(p): Parameters<GetIssueParams>) -> ToolResult {
        respond(self.do_get_issue(p).await)
    }

    #[tool(
        description = "Crée une issue. Le type et l'état deviennent des labels type/* et status/* ; la version est le titre d'un milestone existant."
    )]
    async fn create_issue(&self, Parameters(p): Parameters<CreateIssueParams>) -> ToolResult {
        respond(self.do_create_issue(p).await)
    }

    #[tool(
        description = "Modifie une issue : titre, description, état ouvert/fermé, état d'avancement (status), labels (remplacer, ajouter, retirer), version, assignés."
    )]
    async fn update_issue(&self, Parameters(p): Parameters<UpdateIssueParams>) -> ToolResult {
        respond(self.do_update_issue(p).await)
    }

    #[tool(description = "Ajoute un commentaire markdown à une issue ou à une pull request.")]
    async fn add_comment(&self, Parameters(p): Parameters<AddCommentParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo()?;
                if p.body.trim().is_empty() {
                    bail!("Commentaire vide.");
                }
                let c = self
                    .gh
                    .post(
                        &format!("/repos/{repo}/issues/{}/comments", p.number),
                        &json!({ "body": p.body }),
                    )
                    .await?;
                Ok(json!({ "id": c["id"], "url": c["html_url"] }))
            }
            .await,
        )
    }

    #[tool(
        description = "Liste les versions (milestones) : un milestone daté est un sprint, un milestone sans date un palier de roadmap. La description d'un palier liste ses thèmes."
    )]
    async fn list_milestones(&self, Parameters(p): Parameters<ListMilestonesParams>) -> ToolResult {
        respond(
            async {
                let versions: Vec<model::Version> = self
                    .milestones(p.state.as_str())
                    .await?
                    .iter()
                    .map(model::version_from)
                    .collect();
                Ok(json!({ "versions": versions }))
            }
            .await,
        )
    }

    /* ---------- TODO : outils déclarés, pas encore implémentés ---------- */

    #[tool(description = "TODO — Crée une version (milestone). Pas encore implémenté.")]
    async fn create_milestone(&self, Parameters(_): Parameters<MilestoneParams>) -> ToolResult {
        // TODO: POST /repos/{repo}/milestones (title, description, due_on).
        todo("create_milestone")
    }

    #[tool(description = "TODO — Modifie ou clôt une version (milestone). Pas encore implémenté.")]
    async fn update_milestone(&self, Parameters(_): Parameters<MilestoneParams>) -> ToolResult {
        // TODO: PATCH /repos/{repo}/milestones/{number} après résolution du titre.
        todo("update_milestone")
    }

    #[tool(description = "TODO — Liste les pull requests ouvertes. Pas encore implémenté.")]
    async fn list_pull_requests(&self, Parameters(_): Parameters<ListMilestonesParams>) -> ToolResult {
        // TODO: GET /repos/{repo}/pulls + état des checks et des revues.
        todo("list_pull_requests")
    }

    #[tool(
        description = "TODO — Lit une pull request (description, fichiers, checks, revues). Pas encore implémenté."
    )]
    async fn get_pull_request(&self, Parameters(_): Parameters<NumberParams>) -> ToolResult {
        // TODO: GET /repos/{repo}/pulls/{number} + /files + /reviews.
        todo("get_pull_request")
    }

    #[tool(
        description = "TODO — Ouvre une pull request (brouillon par défaut) depuis une branche déjà poussée. Refuse la branche par défaut comme source. Pas encore implémenté."
    )]
    async fn create_pull_request(&self, Parameters(_): Parameters<CreatePullRequestParams>) -> ToolResult {
        // TODO: POST /repos/{repo}/pulls ; refuser head == branche par défaut.
        todo("create_pull_request")
    }

    #[tool(
        description = "TODO — Sort une pull request du brouillon (prête pour la revue). Pas encore implémenté."
    )]
    async fn mark_pull_request_ready(&self, Parameters(_): Parameters<NumberParams>) -> ToolResult {
        // TODO: mutation GraphQL markPullRequestReadyForReview (node_id de la PR).
        todo("mark_pull_request_ready")
    }

    #[tool(description = "TODO — Liste les releases publiées et les brouillons. Pas encore implémenté.")]
    async fn list_releases(&self, Parameters(_): Parameters<Empty>) -> ToolResult {
        // TODO: GET /repos/{repo}/releases.
        todo("list_releases")
    }

    #[tool(
        description = "TODO — Crée la release d'une version (brouillon par défaut) avec ses notes ; crée le tag s'il manque. Pas encore implémenté."
    )]
    async fn create_release(&self, Parameters(_): Parameters<CreateReleaseParams>) -> ToolResult {
        // TODO: POST /repos/{repo}/releases (tag_name = préfixe + version, target_commitish, draft).
        todo("create_release")
    }

    #[tool(description = "TODO — Résumé du sprint en cours : issues par état, burndown, retard. Pas encore implémenté.", meta = ui_only())]
    async fn sprint_summary(&self, Parameters(_): Parameters<Empty>) -> ToolResult {
        // TODO: milestone daté ouvert le plus proche + issues + durée de sprint réglée.
        todo("sprint_summary")
    }
}

#[tool_handler]
impl ServerHandler for GestionProjet {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                env!("CARGO_PKG_NAME"),
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Outils GitHub du plugin Cadence « Gestion de projet » : issues, versions (milestones), \
                 commentaires, pull requests et releases du dépôt de l'espace. Conventions : labels type/*, \
                 status/*, estimate/* ; un milestone daté est un sprint, sans date un palier.",
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(repo: Option<&str>) -> GestionProjet {
        let env = Env {
            workspace: None,
            data_dir: None,
            token: None,
            api_url: "http://127.0.0.1:9".into(),
        };
        let mut s = GestionProjet::new(&env).unwrap();
        s.settings = Arc::new(Settings {
            repository: repo.map(str::to_string),
            ..Settings::default()
        });
        s
    }

    #[test]
    fn declares_every_tool() {
        let names: Vec<String> = server(None)
            .tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        for expected in [
            "get_account",
            "get_repository",
            "list_issues",
            "get_issue",
            "create_issue",
            "update_issue",
            "add_comment",
            "list_milestones",
            "create_milestone",
            "update_milestone",
            "list_pull_requests",
            "get_pull_request",
            "create_pull_request",
            "mark_pull_request_ready",
            "list_releases",
            "create_release",
            "sprint_summary",
        ] {
            assert!(names.iter().any(|n| n == expected), "outil {expected} absent");
        }
    }

    #[test]
    fn marks_ui_only_tools() {
        let tools = server(None).tool_router.list_all();
        let account = tools.iter().find(|t| t.name == "get_account").unwrap();
        let meta = account.meta.as_ref().expect("_meta");
        assert_eq!(meta.0.get("cadence/visibility"), Some(&json!("ui")));
        let list = tools.iter().find(|t| t.name == "list_issues").unwrap();
        assert!(list.meta.is_none());
    }

    #[tokio::test]
    async fn explains_missing_repo_and_token() {
        let r = server(None)
            .list_issues(Parameters(ListIssuesParams::default()))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(true));
        assert!(format!("{:?}", r.content).contains("Aucun dépôt GitHub"));

        let r = server(Some("me/app"))
            .list_issues(Parameters(ListIssuesParams::default()))
            .await
            .unwrap();
        assert!(format!("{:?}", r.content).contains("Jeton GitHub absent"));
    }

    #[tokio::test]
    async fn todo_tools_say_so() {
        let r = server(Some("me/app"))
            .list_releases(Parameters(Empty {}))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(true));
        assert!(format!("{:?}", r.content).contains("pas encore implémenté"));
    }
}
