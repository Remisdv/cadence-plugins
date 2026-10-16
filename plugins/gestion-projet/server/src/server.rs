//! Outils MCP du plugin Gestion de projet (exposés aux IA en `gestion-projet__<outil>`).
//!
//! Tous les outils de dépôt prennent un paramètre `repo` (`owner/name`), qui doit faire partie
//! des dépôts suivis (service `repos` de Cadence). `list_issues` sans `repo` agrège tous les
//! dépôts suivis ; chaque issue porte alors son champ `repo`.
//!
//! Implémentés : `get_account` et `list_account_repos` (réservés à l'UI), `get_repository`,
//! `list_issues`, `get_issue`, `create_issue`, `update_issue`, `add_comment`, `list_milestones`.
//! À faire (TODO, répondent « pas encore implémenté ») : `create_milestone`, `update_milestone`,
//! `list_pull_requests`, `get_pull_request`, `create_pull_request`, `mark_pull_request_ready`,
//! `list_releases`, `create_release`, `sprint_summary`.

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
#[allow(dead_code)] // TODO : lu quand l'outil sera implémenté
pub struct MilestoneParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
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
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    pub number: u32,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)] // TODO : lu quand l'outil sera implémenté
pub struct ListPullRequestsParams {
    /// Dépôt `owner/name` parmi les dépôts suivis ; absent : tous les dépôts suivis.
    pub repo: Option<String>,
    /// open (défaut), closed ou all.
    #[serde(default)]
    pub state: StateFilter,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[allow(dead_code)] // TODO : lu quand l'outil sera implémenté
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
#[allow(dead_code)] // TODO : lu quand l'outil sera implémenté
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

    #[tool(
        description = "TODO — Liste les pull requests d'un dépôt suivi, ou de tous sans `repo`. Pas encore implémenté."
    )]
    async fn list_pull_requests(&self, Parameters(_): Parameters<ListPullRequestsParams>) -> ToolResult {
        // TODO: GET /repos/{repo}/pulls (par dépôt suivi) + état des checks et des revues.
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
    async fn list_releases(&self, Parameters(_): Parameters<RepoParams>) -> ToolResult {
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
    async fn sprint_summary(&self, Parameters(_): Parameters<RepoParams>) -> ToolResult {
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
    async fn todo_tools_say_so() {
        let r = server(&["me/app"])
            .list_releases(Parameters(RepoParams {
                repo: "me/app".into(),
            }))
            .await
            .unwrap();
        assert_eq!(r.is_error, Some(true));
        assert!(text(&r).contains("pas encore implémenté"));
    }
}
