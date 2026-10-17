//! Outils MCP du plugin Gestion de projet (exposés aux IA en `gestion-projet__<outil>`).
//!
//! Tous les outils de dépôt prennent un paramètre `repo` (`owner/name`), qui doit faire partie
//! des dépôts suivis (service `repos` de Cadence). `list_issues` sans `repo` agrège tous les
//! dépôts suivis ; chaque issue porte alors son champ `repo`.
//!
//! - Compte (réservés à l'UI) : `get_account`, `list_account_repos`.
//! - Issues : `get_repository`, `list_issues`, `get_issue`, `create_issue`, `update_issue`,
//!   `add_comment`.
//! - Versions : `list_milestones`, `create_milestone`, `update_milestone` (clôture comprise),
//!   `sprint_summary` (réservé à l'UI : sprint en cours ou version donnée, burndown, retard).
//! - Pull requests : `list_pull_requests` (sans `repo` : tous les dépôts suivis),
//!   `get_pull_request`, `create_pull_request` (brouillon par défaut, jamais depuis la branche par
//!   défaut), `mark_pull_request_ready` (GraphQL `markPullRequestReadyForReview`).
//! - Releases : `list_releases`, `create_release` (brouillon par défaut, tag = préfixe + version).

use std::sync::{Arc, RwLock};

use anyhow::{Context, Result, anyhow, bail};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, CustomNotification, Implementation, MetaObject, ServerCapabilities,
        ServerConfig,
    },
    service::NotificationContext,
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    config::{self, Env, Settings},
    github::GitHub,
    model::{self, IssueType, Status},
    pulls, sprint,
};

type ToolResult = Result<CallToolResult, McpError>;

/// Notification de Cadence : dépôts suivis modifiés (service `repos`).
pub const REPOS_NOTIFICATION: &str = "notifications/cadence/repos";
/// Notification de Cadence : réglages globaux modifiés.
pub const SETTINGS_NOTIFICATION: &str = "notifications/cadence/settings";

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

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ListIssuesParams {
    /// Dépôt `owner/name` parmi les dépôts suivis ; absent : tous les dépôts suivis.
    pub repo: Option<String>,
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
    /// 1 à 100, 50 par défaut (par dépôt).
    pub per_page: Option<u32>,
    /// Page, à partir de 1 (par dépôt).
    pub page: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RepoParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetIssueParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Numéro de l'issue.
    pub number: u32,
    /// Inclure les commentaires (vrai par défaut).
    pub comments: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateIssueParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
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
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
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
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Numéro de l'issue ou de la pull request.
    pub number: u32,
    /// Commentaire en markdown.
    pub body: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListMilestonesParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// open (défaut), closed ou all.
    #[serde(default)]
    pub state: StateFilter,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ListAccountReposParams {
    /// Filtre sur le nom `owner/name` (sans casse).
    pub query: Option<String>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct Empty {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MilestoneParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Version semver, ex. « 0.1.3 ».
    pub title: String,
    /// Description markdown : un titre `# Nom` donne le nom de la version, les éléments de liste
    /// sont les thèmes d'un palier.
    pub description: Option<String>,
    /// Échéance (AAAA-MM-JJ) : un milestone daté est un sprint, sans date un palier.
    pub due_on: Option<String>,
    pub state: Option<IssueState>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateMilestoneParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Version à modifier : titre actuel du milestone (avec ou sans préfixe de tag).
    pub title: String,
    /// Nouveau titre (renommer la version).
    pub new_title: Option<String>,
    /// Nouvelle description complète (markdown).
    pub description: Option<String>,
    /// Nouvelle échéance (AAAA-MM-JJ) ; chaîne vide pour la retirer (la version devient un palier).
    pub due_on: Option<String>,
    /// `closed` pour clore la version, `open` pour la rouvrir.
    pub state: Option<IssueState>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct NumberParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Numéro de la pull request.
    pub number: u32,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SprintSummaryParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Version à résumer (titre du milestone) ; absente : le milestone daté ouvert le plus proche.
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ListPullRequestsParams {
    /// Dépôt `owner/name` parmi les dépôts suivis ; absent : tous les dépôts suivis.
    pub repo: Option<String>,
    /// open (défaut), closed ou all.
    #[serde(default)]
    pub state: StateFilter,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreatePullRequestParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
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
pub struct CreateReleaseParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
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

/// Ce que Cadence peut changer pendant la vie du processus.
#[derive(Debug, Default)]
struct State {
    /// Dépôts suivis, `owner/name`.
    repos: Vec<String>,
    settings: Settings,
}

#[derive(Clone)]
pub struct GestionProjet {
    gh: Arc<GitHub>,
    state: Arc<RwLock<State>>,
    #[allow(dead_code)] // lu par #[tool_handler]
    tool_router: ToolRouter<Self>,
}

/// Page d'issues d'un dépôt.
struct RepoIssues {
    issues: Vec<model::Issue>,
    has_more: bool,
}

impl GestionProjet {
    pub fn new(env: &Env) -> Result<Self> {
        Ok(GestionProjet {
            gh: Arc::new(GitHub::new(&env.api_url, env.token.clone())?),
            state: Arc::new(RwLock::new(State {
                repos: env.repos.clone(),
                settings: env.settings.clone(),
            })),
            tool_router: Self::tool_router(),
        })
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, State> {
        self.state.read().unwrap_or_else(|e| e.into_inner())
    }

    fn followed(&self) -> Vec<String> {
        self.read().repos.clone()
    }

    fn settings(&self) -> Settings {
        self.read().settings.clone()
    }

    /// Applique une notification de Cadence ; faux si elle ne concerne pas ce serveur.
    pub fn apply_notification(&self, method: &str, params: Option<&Value>) -> bool {
        let params = params.cloned().unwrap_or(Value::Null);
        let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
        match method {
            REPOS_NOTIFICATION => match config::parse_repos(&params) {
                Ok(repos) => {
                    tracing::info!(count = repos.len(), "dépôts suivis mis à jour");
                    state.repos = repos;
                }
                Err(err) => tracing::warn!("{REPOS_NOTIFICATION} illisible : {err}"),
            },
            SETTINGS_NOTIFICATION => match Settings::from_notification(&params) {
                Ok(settings) => state.settings = settings,
                Err(err) => tracing::warn!("{SETTINGS_NOTIFICATION} illisible : {err}"),
            },
            _ => return false,
        }
        true
    }

    /// Dépôt demandé, validé et pris parmi les dépôts suivis (nom canonique).
    fn repo(&self, wanted: &str) -> Result<String> {
        let name = config::normalize_repo(wanted)
            .ok_or_else(|| anyhow!("Dépôt invalide : « {wanted} ». Attendu : owner/name."))?;
        let followed = self.followed();
        if followed.is_empty() {
            bail!(no_repos_message());
        }
        followed
            .iter()
            .find(|r| r.eq_ignore_ascii_case(&name))
            .cloned()
            .ok_or_else(|| {
                anyhow!(
                    "Dépôt « {name} » non suivi par Gestion de projet. Dépôts suivis : {}. \
                     Ajoutez-le dans « Dépôts suivis » du plugin.",
                    followed.join(", ")
                )
            })
    }

    async fn milestones(&self, repo: &str, state: &str) -> Result<Vec<Value>> {
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

    /// Numéro du milestone d'une version (titre, avec ou sans préfixe de tag), s'il existe.
    async fn find_milestone_number(&self, repo: &str, title: &str) -> Result<Option<u32>> {
        let all = self.milestones(repo, "all").await?;
        let Some(m) = model::find_milestone(&all, title, &self.settings().tag_prefix) else {
            return Ok(None);
        };
        m["number"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .context("numéro de milestone illisible")
            .map(Some)
    }

    async fn milestone_number(&self, repo: &str, title: &str) -> Result<u32> {
        self.find_milestone_number(repo, title).await?.ok_or_else(|| {
            anyhow!("Version « {title} » introuvable : aucun milestone de ce nom dans {repo}.")
        })
    }

    async fn raw_issue(&self, repo: &str, number: u32) -> Result<Value> {
        self.gh.get(&format!("/repos/{repo}/issues/{number}"), &[]).await
    }

    /// Issues d'un dépôt. `strict` : une version inconnue est une erreur (sinon : aucune issue).
    async fn issues_in(&self, repo: &str, p: &ListIssuesParams, strict: bool) -> Result<RepoIssues> {
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
            Some(title) if strict => {
                query.push(("milestone", self.milestone_number(repo, title).await?.to_string()))
            }
            Some(title) => match self.find_milestone_number(repo, title).await? {
                Some(n) => query.push(("milestone", n.to_string())),
                None => {
                    return Ok(RepoIssues {
                        issues: Vec::new(),
                        has_more: false,
                    });
                }
            },
        }
        if !p.labels.is_empty() {
            query.push(("labels", p.labels.join(",")));
        }
        if let Some(a) = p.assignee.as_ref().filter(|a| !a.trim().is_empty()) {
            query.push(("assignee", a.clone()));
        }
        let res = self.gh.get_page(&format!("/repos/{repo}/issues"), &query).await?;
        // L'API issues renvoie aussi les pull requests : on les écarte.
        let issues = res
            .body
            .as_array()
            .into_iter()
            .flatten()
            .filter(|raw| !model::is_pull_request(raw))
            .map(|raw| model::issue_in(repo, raw, false))
            .collect();
        Ok(RepoIssues {
            issues,
            has_more: res.has_next,
        })
    }

    async fn do_list_issues(&self, p: ListIssuesParams) -> Result<Value> {
        let page = p.page.unwrap_or(1).max(1);
        if let Some(wanted) = p.repo.as_deref().filter(|r| !r.trim().is_empty()) {
            let repo = self.repo(wanted)?;
            let res = self.issues_in(&repo, &p, true).await?;
            return Ok(json!({
                "repo": repo,
                "repos": [repo],
                "issues": res.issues,
                "page": page,
                "has_more": res.has_more,
            }));
        }

        // Tous les dépôts suivis, en parallèle ; un dépôt en erreur n'empêche pas les autres.
        let repos = self.followed();
        if repos.is_empty() {
            bail!(no_repos_message());
        }
        let mut set = tokio::task::JoinSet::new();
        for (i, repo) in repos.iter().cloned().enumerate() {
            let (me, params) = (self.clone(), p.clone());
            set.spawn(async move { (i, me.issues_in(&repo, &params, false).await) });
        }
        let mut results: Vec<(usize, Result<RepoIssues>)> = Vec::new();
        while let Some(joined) = set.join_next().await {
            results.push(joined.context("lecture des issues interrompue")?);
        }
        results.sort_by_key(|(i, _)| *i);

        let mut issues: Vec<model::Issue> = Vec::new();
        let mut errors: Vec<Value> = Vec::new();
        let mut has_more = false;
        for (i, result) in results {
            match result {
                Ok(r) => {
                    has_more |= r.has_more;
                    issues.extend(r.issues);
                }
                Err(err) => errors.push(json!({ "repo": repos[i], "message": format!("{err:#}") })),
            }
        }
        if errors.len() == repos.len() {
            bail!(
                "{}",
                errors
                    .iter()
                    .filter_map(|e| e["message"].as_str())
                    .next()
                    .unwrap_or("lecture des issues impossible")
            );
        }
        // Plus récentes d'abord (dates ISO 8601 : l'ordre lexical suffit).
        issues.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let mut out = json!({
            "repo": Value::Null,
            "repos": repos,
            "issues": issues,
            "page": page,
            "has_more": has_more,
        });
        if !errors.is_empty() {
            out["errors"] = Value::Array(errors);
        }
        Ok(out)
    }

    async fn do_get_issue(&self, p: GetIssueParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let raw = self.raw_issue(&repo, p.number).await?;
        if model::is_pull_request(&raw) {
            bail!("#{} est une pull request, pas une issue.", p.number);
        }
        let issue = model::issue_in(&repo, &raw, true);
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
        let repo = self.repo(&p.repo)?;
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
            body["milestone"] = json!(self.milestone_number(&repo, &m).await?);
        }
        if !p.assignees.is_empty() {
            body["assignees"] = json!(p.assignees);
        }
        let raw = self.gh.post(&format!("/repos/{repo}/issues"), &body).await?;
        Ok(serde_json::to_value(model::issue_in(&repo, &raw, true))?)
    }

    async fn do_update_issue(&self, p: UpdateIssueParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
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
                None => model::issue_from(&self.raw_issue(&repo, p.number).await?, false).labels,
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
            Some(title) => body["milestone"] = json!(self.milestone_number(&repo, title).await?),
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
        Ok(serde_json::to_value(model::issue_in(&repo, &raw, true))?)
    }

    /* ---------- Versions ---------- */

    async fn do_create_milestone(&self, p: MilestoneParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let title = p.title.trim();
        if title.is_empty() {
            bail!("Titre de version vide (ex. 0.1.3).");
        }
        let due_on = p
            .due_on
            .as_deref()
            .map(model::due_on_param)
            .transpose()?
            .flatten();
        let all = self.milestones(&repo, "all").await?;
        if let Some(m) = model::find_milestone(&all, title, &self.settings().tag_prefix) {
            bail!(
                "La version « {} » existe déjà dans {repo} (milestone #{}, {}). Modifiez-la avec update_milestone.",
                m["title"].as_str().unwrap_or(title),
                m["number"],
                m["state"].as_str().unwrap_or("open")
            );
        }
        let mut body = json!({ "title": title, "state": state_str(p.state.unwrap_or(IssueState::Open)) });
        if let Some(d) = p.description {
            body["description"] = json!(d);
        }
        if let Some(d) = due_on {
            body["due_on"] = json!(d);
        }
        let raw = self.gh.post(&format!("/repos/{repo}/milestones"), &body).await?;
        Ok(json!({ "repo": repo, "version": model::version_from(&raw) }))
    }

    async fn do_update_milestone(&self, p: UpdateMilestoneParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let mut body = json!({});
        if let Some(t) = p.new_title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            body["title"] = json!(t);
        }
        if let Some(d) = p.description {
            body["description"] = json!(d);
        }
        if let Some(d) = p.due_on.as_deref() {
            body["due_on"] = json!(model::due_on_param(d)?);
        }
        if let Some(s) = p.state {
            body["state"] = json!(state_str(s));
        }
        if body.as_object().is_some_and(|o| o.is_empty()) {
            bail!("Rien à modifier : précisez new_title, description, due_on ou state.");
        }
        let number = self.milestone_number(&repo, &p.title).await?;
        let raw = self
            .gh
            .patch(&format!("/repos/{repo}/milestones/{number}"), &body)
            .await?;
        Ok(json!({ "repo": repo, "version": model::version_from(&raw) }))
    }

    /// Toutes les issues d'un milestone (ouvertes et fermées), sans les pull requests.
    async fn milestone_issues(&self, repo: &str, number: u32) -> Result<Vec<model::Issue>> {
        let mut out = Vec::new();
        for page in 1..=5u32 {
            let p = self
                .gh
                .get_page(
                    &format!("/repos/{repo}/issues"),
                    &[
                        ("milestone", number.to_string()),
                        ("state", "all".into()),
                        ("per_page", "100".into()),
                        ("page", page.to_string()),
                    ],
                )
                .await?;
            out.extend(
                p.body
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|raw| !model::is_pull_request(raw))
                    .map(|raw| model::issue_in(repo, raw, false)),
            );
            if !p.has_next {
                break;
            }
        }
        Ok(out)
    }

    async fn do_sprint_summary(&self, p: SprintSummaryParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let settings = self.settings();
        let today = sprint::today();
        let wanted = p.version.as_deref().map(str::trim).filter(|v| !v.is_empty());
        let milestones = self
            .milestones(&repo, if wanted.is_some() { "all" } else { "open" })
            .await?;
        let chosen = match wanted {
            Some(title) => Some(
                model::find_milestone(&milestones, title, &settings.tag_prefix).ok_or_else(|| {
                    anyhow!("Version « {title} » introuvable : aucun milestone de ce nom dans {repo}.")
                })?,
            ),
            None => sprint::current_sprint(&milestones, &today),
        };
        let Some(raw) = chosen else {
            return Ok(json!({
                "repo": repo,
                "today": today,
                "sprint_length_days": settings.sprint_length_days,
                "sprint": Value::Null,
                "message": "Aucun sprint en cours : aucun milestone ouvert n'a d'échéance. Datez une version pour en faire un sprint.",
            }));
        };
        let version = model::version_from(raw);
        let mut issues = self.milestone_issues(&repo, version.number).await?;
        issues.sort_by_key(|i| i.number);
        let pace = sprint::pace(
            &issues,
            version.due_on.as_deref(),
            settings.sprint_length_days,
            &today,
        );
        Ok(json!({
            "repo": repo,
            "today": today,
            "sprint_length_days": settings.sprint_length_days,
            "sprint": version,
            "pace": pace,
            "issues": issues,
        }))
    }

    /* ---------- Pull requests ---------- */

    async fn pulls_in(&self, repo: &str, state: StateFilter) -> Result<Vec<pulls::PullRequest>> {
        let (owner, name) = repo.split_once('/').context("dépôt owner/name attendu")?;
        let data = self
            .gh
            .graphql(
                &pulls::list_query(),
                json!({
                    "owner": owner,
                    "name": name,
                    "open": !matches!(state, StateFilter::Closed),
                    "done": !matches!(state, StateFilter::Open),
                }),
            )
            .await?;
        if data["repository"].is_null() {
            bail!("Dépôt {repo} introuvable sur GitHub (ou inaccessible au compte connecté).");
        }
        Ok(pulls::parse_list(repo, &data))
    }

    async fn do_list_pull_requests(&self, p: ListPullRequestsParams) -> Result<Value> {
        if let Some(wanted) = p.repo.as_deref().filter(|r| !r.trim().is_empty()) {
            let repo = self.repo(wanted)?;
            let pulls = self.pulls_in(&repo, p.state).await?;
            return Ok(json!({ "repo": repo, "repos": [repo], "pull_requests": pulls }));
        }
        let repos = self.followed();
        if repos.is_empty() {
            bail!(no_repos_message());
        }
        let mut set = tokio::task::JoinSet::new();
        for (i, repo) in repos.iter().cloned().enumerate() {
            let me = self.clone();
            set.spawn(async move { (i, me.pulls_in(&repo, p.state).await) });
        }
        let mut results = Vec::new();
        while let Some(joined) = set.join_next().await {
            results.push(joined.context("lecture des pull requests interrompue")?);
        }
        results.sort_by_key(|(i, _)| *i);
        let mut all: Vec<pulls::PullRequest> = Vec::new();
        let mut errors: Vec<Value> = Vec::new();
        for (i, result) in results {
            match result {
                Ok(list) => all.extend(list),
                Err(err) => errors.push(json!({ "repo": repos[i], "message": format!("{err:#}") })),
            }
        }
        if errors.len() == repos.len() {
            bail!(
                "{}",
                errors
                    .iter()
                    .filter_map(|e| e["message"].as_str())
                    .next()
                    .unwrap_or("lecture des pull requests impossible")
            );
        }
        // Ouvertes d'abord, puis par activité (dates ISO 8601 : l'ordre lexical suffit).
        let is_open = |p: &pulls::PullRequest| matches!(p.state, "open" | "draft");
        all.sort_by(|a, b| {
            is_open(b)
                .cmp(&is_open(a))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        let mut out = json!({ "repo": Value::Null, "repos": repos, "pull_requests": all });
        if !errors.is_empty() {
            out["errors"] = Value::Array(errors);
        }
        Ok(out)
    }

    async fn do_get_pull_request(&self, p: NumberParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let (owner, name) = repo.split_once('/').context("dépôt owner/name attendu")?;
        let data = self
            .gh
            .graphql(
                &pulls::detail_query(),
                json!({ "owner": owner, "name": name, "number": p.number }),
            )
            .await?;
        let raw = &data["repository"]["pullRequest"];
        if raw.is_null() {
            bail!("Pull request #{} introuvable dans {repo}.", p.number);
        }
        let mut out = serde_json::to_value(pulls::from_graphql(&repo, raw))?;
        out["body"] = json!(raw["body"].as_str().unwrap_or(""));
        out["mergeable"] = raw["mergeable"].as_str().map(str::to_lowercase).into();
        out["reviews"] = Value::Array(pulls::reviews_of(raw));
        out["checks"] = Value::Array(pulls::checks_of(raw));
        let files = self
            .gh
            .get(
                &format!("/repos/{repo}/pulls/{}/files", p.number),
                &[("per_page", "100".into())],
            )
            .await?;
        out["files"] = Value::Array(
            files
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| {
                    json!({
                        "path": f["filename"],
                        "status": f["status"],
                        "additions": f["additions"],
                        "deletions": f["deletions"],
                    })
                })
                .collect(),
        );
        Ok(out)
    }

    async fn do_create_pull_request(&self, p: CreatePullRequestParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        if p.title.trim().is_empty() {
            bail!("Titre de pull request vide.");
        }
        let info = self.gh.get(&format!("/repos/{repo}"), &[]).await?;
        let default_branch = info["default_branch"].as_str().unwrap_or("main").to_string();
        let base = p
            .base
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .unwrap_or(&default_branch)
            .to_string();
        pulls::check_head(&p.head, &base, &default_branch)?;
        let body = json!({
            "title": p.title.trim(),
            "head": p.head.trim(),
            "base": base,
            "body": p.body.unwrap_or_default(),
            "draft": p.draft.unwrap_or(true),
        });
        let raw = self.gh.post(&format!("/repos/{repo}/pulls"), &body).await?;
        Ok(serde_json::to_value(pulls::from_rest(&repo, &raw))?)
    }

    async fn do_mark_ready(&self, p: NumberParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let (owner, name) = repo.split_once('/').context("dépôt owner/name attendu")?;
        let data = self
            .gh
            .graphql(
                pulls::NODE_QUERY,
                json!({ "owner": owner, "name": name, "number": p.number }),
            )
            .await?;
        let pr = &data["repository"]["pullRequest"];
        if pr.is_null() {
            bail!("Pull request #{} introuvable dans {repo}.", p.number);
        }
        let url = pr["url"].clone();
        if pr["state"].as_str() != Some("OPEN") {
            bail!(
                "La pull request #{} n'est plus ouverte ({}) : rien à sortir du brouillon.",
                p.number,
                pr["state"].as_str().unwrap_or("?").to_lowercase()
            );
        }
        if pr["isDraft"].as_bool() != Some(true) {
            return Ok(json!({
                "repo": repo, "number": p.number, "draft": false, "url": url,
                "message": "La pull request était déjà prête pour la revue.",
            }));
        }
        let id = pr["id"].as_str().context("identifiant GraphQL de la PR absent")?;
        self.gh
            .graphql(pulls::READY_MUTATION, json!({ "id": id }))
            .await?;
        Ok(json!({ "repo": repo, "number": p.number, "draft": false, "url": url }))
    }

    /* ---------- Releases ---------- */

    async fn releases(&self, repo: &str) -> Result<Vec<Value>> {
        let raw = self
            .gh
            .get(&format!("/repos/{repo}/releases"), &[("per_page", "100".into())])
            .await?;
        Ok(raw.as_array().cloned().unwrap_or_default())
    }

    async fn do_create_release(&self, p: CreateReleaseParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let prefix = self.settings().tag_prefix;
        let tag = model::tag_name(&prefix, &p.version)?;
        if p.notes.trim().is_empty() {
            bail!("Notes de version vides : rédigez-les en markdown (nouveautés, corrections…).");
        }
        // Les brouillons ne sont pas trouvables par tag : on lit la liste.
        if let Some(existing) = self
            .releases(&repo)
            .await?
            .iter()
            .find(|r| r["tag_name"].as_str() == Some(tag.as_str()))
        {
            let r = model::release_from(existing, &prefix, false);
            bail!(
                "Une release existe déjà pour {tag} ({}) : {}. Modifiez-la sur GitHub.",
                if r.draft { "brouillon" } else { "publiée" },
                r.url
            );
        }
        let mut body = json!({
            "tag_name": tag,
            "name": tag,
            "body": p.notes,
            "draft": p.draft.unwrap_or(true),
        });
        if let Some(t) = p.target.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            body["target_commitish"] = json!(t);
        }
        let raw = self.gh.post(&format!("/repos/{repo}/releases"), &body).await?;
        Ok(json!({ "repo": repo, "release": model::release_from(&raw, &prefix, false) }))
    }
}

fn state_str(s: IssueState) -> &'static str {
    match s {
        IssueState::Open => "open",
        IssueState::Closed => "closed",
    }
}

fn no_repos_message() -> String {
    "Aucun dépôt suivi : ajoutez-en dans « Dépôts suivis » du plugin Gestion de projet.".into()
}

#[tool_router]
impl GestionProjet {
    #[tool(
        description = "Compte GitHub connecté dans Cadence (login, nom, avatar) et dépôts suivis : sert à l'écran « Dépôts suivis ».",
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
                    "repos": self.followed(),
                }))
            }
            .await,
        )
    }

    #[tool(
        description = "Dépôts accessibles au compte GitHub connecté (les 100 plus récents), pour choisir ceux à suivre.",
        meta = ui_only()
    )]
    async fn list_account_repos(&self, Parameters(p): Parameters<ListAccountReposParams>) -> ToolResult {
        respond(
            async {
                let raw = self
                    .gh
                    .get(
                        "/user/repos",
                        &[
                            ("sort", "updated".into()),
                            ("per_page", "100".into()),
                            ("affiliation", "owner,collaborator,organization_member".into()),
                        ],
                    )
                    .await?;
                let followed = self.followed();
                let query = p.query.unwrap_or_default().trim().to_lowercase();
                let repos: Vec<Value> = raw
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| {
                        let name = r["full_name"].as_str()?;
                        (query.is_empty() || name.to_lowercase().contains(&query)).then(|| {
                            json!({
                                "full_name": name,
                                "private": r["private"],
                                "description": r["description"],
                                "updated_at": r["updated_at"],
                                "followed": followed.iter().any(|f| f.eq_ignore_ascii_case(name)),
                            })
                        })
                    })
                    .collect();
                Ok(json!({ "repos": repos }))
            }
            .await,
        )
    }

    #[tool(
        description = "Dépôt GitHub suivi : nom complet, branche par défaut, visibilité, URL, préfixe de tag. À lire avant de créer une branche ou une PR."
    )]
    async fn get_repository(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let r = self.gh.get(&format!("/repos/{repo}"), &[]).await?;
                let settings = self.settings();
                Ok(json!({
                    "repo": repo,
                    "full_name": r["full_name"],
                    "default_branch": r["default_branch"],
                    "private": r["private"],
                    "url": r["html_url"],
                    "open_issues": r["open_issues_count"],
                    "tag_prefix": settings.tag_prefix,
                    "sprint_length_days": settings.sprint_length_days,
                }))
            }
            .await,
        )
    }

    #[tool(
        description = "Liste les issues (sans les pull requests), triées par dernière mise à jour. Avec `repo` : ce dépôt ; sans `repo` : tous les dépôts suivis, chaque issue portant son champ `repo`. Chaque issue porte son type (label type/*), son état (todo, doing, review, done), son estimation et sa version (milestone)."
    )]
    async fn list_issues(&self, Parameters(p): Parameters<ListIssuesParams>) -> ToolResult {
        respond(self.do_list_issues(p).await)
    }

    #[tool(
        description = "Lit une issue d'un dépôt suivi : titre, description markdown, labels, version, assignés et commentaires."
    )]
    async fn get_issue(&self, Parameters(p): Parameters<GetIssueParams>) -> ToolResult {
        respond(self.do_get_issue(p).await)
    }

    #[tool(
        description = "Crée une issue dans un dépôt suivi. Le type et l'état deviennent des labels type/* et status/* ; la version est le titre d'un milestone existant."
    )]
    async fn create_issue(&self, Parameters(p): Parameters<CreateIssueParams>) -> ToolResult {
        respond(self.do_create_issue(p).await)
    }

    #[tool(
        description = "Modifie une issue d'un dépôt suivi : titre, description, état ouvert/fermé, état d'avancement (status), labels (remplacer, ajouter, retirer), version, assignés."
    )]
    async fn update_issue(&self, Parameters(p): Parameters<UpdateIssueParams>) -> ToolResult {
        respond(self.do_update_issue(p).await)
    }

    #[tool(
        description = "Ajoute un commentaire markdown à une issue ou à une pull request d'un dépôt suivi."
    )]
    async fn add_comment(&self, Parameters(p): Parameters<AddCommentParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
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
                Ok(json!({ "repo": repo, "id": c["id"], "url": c["html_url"] }))
            }
            .await,
        )
    }

    #[tool(
        description = "Liste les versions (milestones) d'un dépôt suivi : un milestone daté est un sprint, un milestone sans date un palier de roadmap. La description d'un palier liste ses thèmes."
    )]
    async fn list_milestones(&self, Parameters(p): Parameters<ListMilestonesParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let versions: Vec<model::Version> = self
                    .milestones(&repo, p.state.as_str())
                    .await?
                    .iter()
                    .map(model::version_from)
                    .collect();
                Ok(json!({ "repo": repo, "versions": versions }))
            }
            .await,
        )
    }

    #[tool(
        description = "Crée une version (milestone) dans un dépôt suivi. Avec une échéance (AAAA-MM-JJ), c'est un sprint ; sans date, un palier de roadmap. La description peut commencer par « # Nom » et lister les thèmes (« - Thème »)."
    )]
    async fn create_milestone(&self, Parameters(p): Parameters<MilestoneParams>) -> ToolResult {
        respond(self.do_create_milestone(p).await)
    }

    #[tool(
        description = "Modifie une version (milestone) désignée par son titre : nouveau titre, description, échéance (chaîne vide pour la retirer), ou state « closed » pour la clore (« open » pour la rouvrir)."
    )]
    async fn update_milestone(&self, Parameters(p): Parameters<UpdateMilestoneParams>) -> ToolResult {
        respond(self.do_update_milestone(p).await)
    }

    #[tool(
        description = "Liste les pull requests (ouvertes par défaut ; closed = 30 dernières fusionnées ou fermées) avec l'état des checks (CI), des revues, la branche, la version et les issues fermées. Avec `repo` : ce dépôt ; sans `repo` : tous les dépôts suivis, chaque PR portant son champ `repo`."
    )]
    async fn list_pull_requests(&self, Parameters(p): Parameters<ListPullRequestsParams>) -> ToolResult {
        respond(self.do_list_pull_requests(p).await)
    }

    #[tool(
        description = "Lit une pull request d'un dépôt suivi : description, branches, checks du dernier commit, revues, fichiers modifiés (sans les patchs : lire le code dans un worktree)."
    )]
    async fn get_pull_request(&self, Parameters(p): Parameters<NumberParams>) -> ToolResult {
        respond(self.do_get_pull_request(p).await)
    }

    #[tool(
        description = "Ouvre une pull request (brouillon par défaut) depuis une branche déjà poussée vers la branche par défaut (ou `base`). Refuse la branche par défaut comme source."
    )]
    async fn create_pull_request(&self, Parameters(p): Parameters<CreatePullRequestParams>) -> ToolResult {
        respond(self.do_create_pull_request(p).await)
    }

    #[tool(description = "Sort une pull request du brouillon : elle devient prête pour la revue.")]
    async fn mark_pull_request_ready(&self, Parameters(p): Parameters<NumberParams>) -> ToolResult {
        respond(self.do_mark_ready(p).await)
    }

    #[tool(
        description = "Liste les releases d'un dépôt suivi (publiées et brouillons) : tag, version, état, date, lien."
    )]
    async fn list_releases(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let prefix = self.settings().tag_prefix;
                let releases: Vec<model::Release> = self
                    .releases(&repo)
                    .await?
                    .iter()
                    .map(|r| model::release_from(r, &prefix, false))
                    .collect();
                Ok(json!({ "repo": repo, "tag_prefix": prefix, "releases": releases }))
            }
            .await,
        )
    }

    #[tool(
        description = "Crée la release d'une version avec ses notes markdown, en brouillon par défaut (jamais publiée sans accord). Le tag est le préfixe réglé suivi de la version (v0.1.2) ; GitHub le crée sur `target` (ou la branche par défaut) s'il n'existe pas."
    )]
    async fn create_release(&self, Parameters(p): Parameters<CreateReleaseParams>) -> ToolResult {
        respond(self.do_create_release(p).await)
    }

    #[tool(
        description = "Résumé du sprint en cours (milestone daté ouvert le plus proche) ou d'une version donnée : issues par état, burndown jour par jour, rythme, retard sur la droite idéale, durée de sprint réglée.",
        meta = ui_only()
    )]
    async fn sprint_summary(&self, Parameters(p): Parameters<SprintSummaryParams>) -> ToolResult {
        respond(self.do_sprint_summary(p).await)
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
                 commentaires, pull requests et releases des dépôts suivis. Chaque outil prend `repo` \
                 (owner/name) ; `list_issues` sans `repo` couvre tous les dépôts suivis. Conventions : \
                 labels type/*, status/*, estimate/* ; un milestone daté est un sprint, sans date un palier. \
                 Pour lire ou modifier le code, obtenir d'abord un worktree avec cadence__repo_checkout.",
            )
    }

    fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _context: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + Send + '_ {
        if !self.apply_notification(&notification.method, notification.params.as_ref()) {
            tracing::debug!(method = %notification.method, "notification ignorée");
        }
        std::future::ready(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(repos: &[&str]) -> GestionProjet {
        let env = Env {
            token: None,
            repos: repos.iter().map(|r| r.to_string()).collect(),
            settings: Settings::default(),
            api_url: "http://127.0.0.1:9".into(),
        };
        GestionProjet::new(&env).unwrap()
    }

    fn text(r: &CallToolResult) -> String {
        format!("{:?}", r.content)
    }

    #[test]
    fn declares_every_tool() {
        let names: Vec<String> = server(&[])
            .tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        for expected in [
            "get_account",
            "list_account_repos",
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
    fn every_repo_tool_takes_repo() {
        for tool in server(&[]).tool_router.list_all() {
            let props = tool.input_schema.get("properties").and_then(Value::as_object);
            let required: Vec<&str> = tool
                .input_schema
                .get("required")
                .and_then(Value::as_array)
                .map(|r| r.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            match tool.name.as_ref() {
                "get_account" | "list_account_repos" => {}
                // `repo` absent : tous les dépôts suivis.
                "list_issues" | "list_pull_requests" => {
                    assert!(props.is_some_and(|p| p.contains_key("repo")), "{}", tool.name);
                    assert!(!required.contains(&"repo"), "{}", tool.name);
                }
                name => assert!(required.contains(&"repo"), "{name} : `repo` obligatoire attendu"),
            }
        }
    }

    #[test]
    fn marks_ui_only_tools() {
        let tools = server(&[]).tool_router.list_all();
        for name in ["get_account", "list_account_repos", "sprint_summary"] {
            let tool = tools.iter().find(|t| t.name == name).unwrap();
            let meta = tool.meta.as_ref().expect("_meta");
            assert_eq!(meta.0.get("cadence/visibility"), Some(&json!("ui")));
        }
        let list = tools.iter().find(|t| t.name == "list_issues").unwrap();
        assert!(list.meta.is_none());
    }

    #[tokio::test]
    async fn explains_missing_repo_and_token() {
        let r = server(&[])
            .list_issues(Parameters(ListIssuesParams::default()))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(true));
        assert!(text(&r).contains("Aucun dépôt suivi"));

        let r = server(&["me/app"])
            .get_issue(Parameters(GetIssueParams {
                repo: "other/lib".into(),
                number: 1,
                comments: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("non suivi"), "{}", text(&r));

        let r = server(&["me/app"])
            .get_repository(Parameters(RepoParams {
                repo: "pas un dépôt".into(),
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("Dépôt invalide"));

        let r = server(&["me/app"])
            .list_issues(Parameters(ListIssuesParams {
                repo: Some("ME/App".into()),
                ..Default::default()
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("GitHub n'est pas connecté"), "{}", text(&r));

        // Tous les dépôts : chacun échoue, l'erreur est remontée.
        let r = server(&["me/app", "me/site"])
            .list_issues(Parameters(ListIssuesParams::default()))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(true));
        assert!(text(&r).contains("GitHub n'est pas connecté"));
    }

    #[test]
    fn follows_cadence_notifications() {
        let s = server(&["me/app"]);
        assert!(s.apply_notification(
            REPOS_NOTIFICATION,
            Some(&json!({ "repos": ["me/site", "org/lib"] }))
        ));
        assert_eq!(s.followed(), ["me/site", "org/lib"]);
        assert!(s.repo("ORG/lib").is_ok_and(|r| r == "org/lib"));
        assert!(s.repo("me/app").is_err());

        assert!(s.apply_notification(
            SETTINGS_NOTIFICATION,
            Some(&json!({ "settings": { "tag_prefix": "" } }))
        ));
        assert_eq!(s.settings().tag_prefix, "");

        // Notification illisible : l'état ne change pas.
        assert!(s.apply_notification(REPOS_NOTIFICATION, Some(&json!(42))));
        assert_eq!(s.followed().len(), 2);
        assert!(!s.apply_notification("notifications/autre", None));
    }

    #[tokio::test]
    async fn validates_inputs_before_calling_github() {
        let s = server(&["me/app"]);
        let r = s
            .create_milestone(Parameters(MilestoneParams {
                repo: "me/app".into(),
                title: "0.1.3".into(),
                description: None,
                due_on: Some("20/10/2026".into()),
                state: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("AAAA-MM-JJ"), "{}", text(&r));

        let r = s
            .update_milestone(Parameters(UpdateMilestoneParams {
                repo: "me/app".into(),
                title: "0.1.3".into(),
                new_title: None,
                description: None,
                due_on: None,
                state: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("Rien à modifier"), "{}", text(&r));

        let r = s
            .create_release(Parameters(CreateReleaseParams {
                repo: "me/app".into(),
                version: "0.1 beta".into(),
                notes: "## Notes".into(),
                target: None,
                draft: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("Version invalide"), "{}", text(&r));

        let r = s
            .create_pull_request(Parameters(CreatePullRequestParams {
                repo: "me/app".into(),
                title: " ".into(),
                head: "feat/1-x".into(),
                base: None,
                body: None,
                draft: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("Titre de pull request vide"), "{}", text(&r));

        let r = s
            .sprint_summary(Parameters(SprintSummaryParams {
                repo: "other/lib".into(),
                version: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("non suivi"), "{}", text(&r));
    }

    #[tokio::test]
    async fn lists_pull_requests_of_every_followed_repo() {
        let r = server(&[])
            .list_pull_requests(Parameters(ListPullRequestsParams::default()))
            .await
            .unwrap();
        assert!(text(&r).contains("Aucun dépôt suivi"));
        // Chaque dépôt échoue (pas de jeton) : l'erreur est remontée.
        let r = server(&["me/app", "me/site"])
            .list_pull_requests(Parameters(ListPullRequestsParams::default()))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(true));
        assert!(text(&r).contains("GitHub n'est pas connecté"), "{}", text(&r));
    }
}
