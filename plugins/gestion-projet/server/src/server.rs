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
//! - Sprints automatiques (réservés à l'UI, voir `projet` et `engine`) : `project_start`,
//!   `project_pause`, `project_resume`, `project_set_duration`. L'issue d'état `cadence/sprints`
//!   est masquée de `list_issues`.
//! - Roadmap : `roadmap` (jalons, sprints passés et prévus, dates estimées avec fourchette),
//!   `jalon_save`, `jalon_delete`, `jalon_issues` (jalons rangés dans l'issue d'état).
//! - Designs (Claude Design) : `list_designs`, `get_design`, `design_add`, `design_update`,
//!   `design_delete` ; fichiers dans le dépôt sous `design/<id>`, registre dans l'issue d'état.
//! - Planning (Gantt) : `planning_get`, `planning_save` (issue cachée `cadence/planning`).
//! - Architecture : `architecture_get`, `architecture_templates`, `architecture_save` (fichiers
//!   `architecture/` du dépôt, modifiés par une branche `archi/…` et une PR).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

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
    engine::Project,
    github::GitHub,
    model::{self, IssueType, Status},
    projet, pulls, sprint,
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
    /// Story points, suite de Fibonacci : 1, 2, 3, 5, 8 ou 13 (label `sp/<n>`). Au-delà de
    /// 13, découper l'issue.
    pub points: Option<u32>,
    /// Priorité (label `priority/<n>`) : 0 = socle (à faire avant tout, d'autres issues en
    /// dépendent), puis 1 (la plus urgente) à 5 (la moins urgente).
    pub priority: Option<u8>,
    /// Labels supplémentaires (ex. `area/api`).
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
    /// Nouvelle estimation en story points : 1, 2, 3, 5, 8 ou 13 (remplace `sp/*`).
    pub points: Option<u32>,
    /// Nouvelle priorité : 0 (socle) à 5 (remplace `priority/*`).
    pub priority: Option<u8>,
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
pub struct ProjectStartParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Durée d'un sprint en jours (1 à 90), modifiable ensuite.
    pub duration_days: u32,
    /// Story points du premier sprint ; ensuite, la capacité suit le rythme réel.
    pub capacity: u32,
    /// Version du premier sprint (ex. 0.1.0) ; absente : mineure suivante de la plus haute version.
    pub first_version: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProjectDurationParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Nouvelle durée d'un sprint en jours (1 à 90) : s'applique au sprint en cours.
    pub duration_days: u32,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct JalonSaveParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Jalon à modifier ; absent : nouveau jalon (identifiant tiré du nom).
    pub id: Option<String>,
    /// Nom clair (ex. « MVP privé », « Bêta publique »).
    pub name: String,
    /// Objectif du jalon en une ou deux phrases (markdown).
    pub description: Option<String>,
    /// Rang dans la roadmap, à partir de 0 ; absent : à la fin (nouveau) ou inchangé.
    pub position: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct JalonParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Identifiant du jalon (voir `roadmap`).
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct JalonIssuesParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Identifiant du jalon (voir `roadmap`).
    pub id: String,
    /// Issues à ranger dans ce jalon (retirées de leur jalon précédent).
    #[serde(default)]
    pub add: Vec<u32>,
    /// Issues à retirer de ce jalon.
    #[serde(default)]
    pub remove: Vec<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DesignAddParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Nom clair du design (« Écran d'accueil », « Maquettes V2 »).
    pub name: String,
    /// Lien claude.ai du design.
    pub url: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DesignUpdateParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Identifiant du design (voir `list_designs`).
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    /// `true` une fois les fichiers commités et poussés : le design passe « importé ».
    pub imported: Option<bool>,
    /// Branche où les fichiers ont été poussés (`design/<id>`).
    #[serde(rename = "ref")]
    pub branch: Option<String>,
    /// Dossier des fichiers dans le dépôt (`design/<id>` par défaut).
    pub path: Option<String>,
    /// Fichier à afficher d'abord, relatif au dossier (`index.html`).
    pub entry: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DesignParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Identifiant du design (voir `list_designs`).
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetDesignParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Identifiant du design (voir `list_designs`).
    pub id: String,
    /// Fichier à lire, relatif au dossier du design ; absent : le fichier d'entrée.
    pub file: Option<String>,
    /// Réservé à l'écran Designs : incorpore images et styles relatifs en `data:`.
    #[serde(default)]
    pub inline: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PlanningSaveParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Planning complet (personnes, phases, tâches) : il remplace le précédent.
    pub planning: crate::planning::Planning,
    /// Révision lue avec `planning_get` : refus si le planning a changé depuis.
    pub base_revision: u32,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ArchitectureSaveParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Architecture complète (services, liens, couches, règles) : elle remplace la précédente.
    pub architecture: crate::architecture::Architecture,
    /// Résumé de la modification (message de commit et titre de PR).
    pub message: String,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    /// Approuver (impossible sur sa propre PR : la revue est alors publiée en commentaire).
    Approve,
    /// Demander des changements.
    RequestChanges,
    /// Commenter sans verdict.
    Comment,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReviewComment {
    /// Fichier, chemin relatif au dépôt.
    pub path: String,
    /// Ligne du fichier dans la nouvelle version (côté droit du diff).
    pub line: u32,
    /// Remarque en markdown.
    pub body: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReviewParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Numéro de la pull request.
    pub number: u32,
    /// APPROVE, REQUEST_CHANGES ou COMMENT.
    pub event: ReviewEvent,
    /// Synthèse de la revue (markdown).
    pub body: String,
    /// Remarques sur des lignes du diff.
    #[serde(default)]
    pub comments: Vec<ReviewComment>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DiffParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Numéro de la pull request.
    pub number: u32,
    /// Un seul fichier (chemin) ; absent : tous, tronqués à 60 000 caractères.
    pub file: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    /// Commit de fusion (par défaut).
    #[default]
    Merge,
    /// Un seul commit.
    Squash,
    Rebase,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MergeParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Numéro de la pull request.
    pub number: u32,
    #[serde(default)]
    pub method: MergeMethod,
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
    pub(crate) gh: Arc<GitHub>,
    state: Arc<RwLock<State>>,
    /// Dernière passe du moteur de sprints, par dépôt (l'écran Sprint ne relance pas à chaque vue).
    pub(crate) last_pass: Arc<Mutex<HashMap<String, Instant>>>,
    /// Une seule opération du moteur à la fois dans ce processus.
    pub(crate) engine_lock: Arc<tokio::sync::Mutex<()>>,
    /// Numéros des issues cachées (état, planning) déjà trouvées ou créées, par `dépôt#label` :
    /// la recherche par label de GitHub peut ne pas voir tout de suite une issue toute neuve.
    pub(crate) hidden_issues: Arc<Mutex<HashMap<String, u32>>>,
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
            last_pass: Arc::default(),
            engine_lock: Arc::default(),
            hidden_issues: Arc::default(),
            tool_router: Self::tool_router(),
        })
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, State> {
        self.state.read().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn followed(&self) -> Vec<String> {
        self.read().repos.clone()
    }

    pub(crate) fn settings(&self) -> Settings {
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

    pub(crate) async fn milestones(&self, repo: &str, state: &str) -> Result<Vec<Value>> {
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
        // L'API issues renvoie aussi les pull requests : on les écarte, comme l'issue d'état
        // des sprints automatiques.
        let issues = res
            .body
            .as_array()
            .into_iter()
            .flatten()
            .filter(|raw| !model::is_pull_request(raw) && !model::is_state_issue(raw))
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
        if let Some(points) = p.points {
            labels = model::with_unique(&labels, &model::points_label(points)?);
        }
        if let Some(priority) = p.priority {
            labels = model::with_unique(&labels, &model::priority_label(priority)?);
        }
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
        // Valeurs vérifiées avant tout appel à GitHub.
        let points = p.points.map(model::points_label).transpose()?;
        let priority = p.priority.map(model::priority_label).transpose()?;
        let touches_labels = p.labels.is_some()
            || p.status.is_some()
            || points.is_some()
            || priority.is_some()
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
            for label in points.iter().chain(priority.iter()) {
                labels = model::with_unique(&labels, label);
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
    pub(crate) async fn milestone_issues(&self, repo: &str, number: u32) -> Result<Vec<model::Issue>> {
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
        // Sprints automatiques : une passe du moteur (au plus une par minute), puis leur état.
        let (project, project_error) = match self.reconcile_throttled(&repo).await {
            Ok(project) => (project, None),
            Err(err) => (
                self.load_project(&repo).await.ok().flatten(),
                Some(format!("{err:#}")),
            ),
        };
        let milestones = self.milestones(&repo, "all").await?;
        let current = project.as_ref().and_then(|p| p.state.current());
        let chosen = match (wanted, current) {
            (Some(title), _) => Some(
                model::find_milestone(&milestones, title, &settings.tag_prefix).ok_or_else(|| {
                    anyhow!("Version « {title} » introuvable : aucun milestone de ce nom dans {repo}.")
                })?,
            ),
            (None, Some(cur)) => model::find_milestone(&milestones, &cur.version, &settings.tag_prefix),
            (None, None) => {
                let open: Vec<Value> = milestones
                    .iter()
                    .filter(|m| m["state"].as_str() == Some("open"))
                    .cloned()
                    .collect();
                sprint::current_sprint(&open, &today)
                    .and_then(|m| model::find_milestone(&milestones, m["title"].as_str()?, ""))
            }
        };
        let mut out = json!({
            "repo": repo,
            "today": today,
            "sprint_length_days": settings.sprint_length_days,
            "project": project.as_ref().map(project_view),
        });
        if let Some(err) = project_error {
            out["project_error"] = json!(err);
        }
        if project.as_ref().is_none_or(|p| p.state.sprints.is_empty()) {
            let titles: Vec<String> = milestones
                .iter()
                .filter_map(|m| m["title"].as_str().map(str::to_string))
                .collect();
            let days = settings
                .sprint_length_days
                .clamp(projet::MIN_DAYS, projet::MAX_DAYS);
            out["start_defaults"] = json!({
                "duration_days": days,
                // 10 story points par semaine pour commencer : la capacité suit ensuite le rythme réel.
                "capacity": ((days as f32) * 10.0 / 7.0).round().max(1.0) as u32,
                "first_version": projet::next_version(&titles, &settings.tag_prefix),
            });
        }
        let Some(raw) = chosen else {
            out["sprint"] = Value::Null;
            out["message"] = json!(if project.as_ref().is_some_and(|p| !p.state.sprints.is_empty()) {
                "Le sprint en cours n'a pas encore de milestone : il sera créé à la prochaine passe."
            } else {
                "Aucun sprint en cours : démarrez le projet pour que Cadence crée les sprints, ou datez une version."
            });
            return Ok(out);
        };
        let version = model::version_from(raw);
        let record = project
            .as_ref()
            .and_then(|p| p.state.sprints.iter().find(|s| s.version == version.title));
        let mut issues = self.milestone_issues(&repo, version.number).await?;
        issues.sort_by_key(|i| i.number);
        let pace = sprint::pace(
            &issues,
            record.map(|r| r.start_on.as_str()),
            version.due_on.as_deref(),
            settings.sprint_length_days,
            &today,
        );
        out["sprint"] = serde_json::to_value(&version)?;
        out["pace"] = serde_json::to_value(&pace)?;
        out["issues"] = serde_json::to_value(&issues)?;
        Ok(out)
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

    pub(crate) async fn releases(&self, repo: &str) -> Result<Vec<Value>> {
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

/// État des sprints automatiques tel que l'écran Sprint l'affiche (six derniers sprints).
fn project_view(project: &Project) -> Value {
    let s = &project.state;
    let cur = s.current();
    let sprints: Vec<Value> = s
        .sprints
        .iter()
        .rev()
        .take(6)
        .map(|r| {
            let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
            v["branch"] = json!(r.branch());
            v
        })
        .collect();
    json!({
        "issue": project.issue,
        "url": project.url,
        "status": s.status,
        "paused_since": s.paused_since,
        "duration_days": s.duration_days,
        "points_per_day": crate::engine::round1(s.points_per_day()),
        "capacity": cur.map(|c| c.capacity),
        "next_capacity": s.next_capacity(),
        "current": cur.map(|c| c.version.clone()),
        "release_branch": cur.map(|c| c.branch()),
        "carried": cur.map(|c| c.carried.clone()).unwrap_or_default(),
        "sprints": sprints,
    })
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
        description = "Dépôt GitHub suivi : nom complet, branche par défaut, visibilité, URL, préfixe de tag et, si les sprints automatiques sont démarrés, la branche de release du sprint en cours (`sprints.release_branch`). À lire avant de créer une branche ou une PR."
    )]
    async fn get_repository(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let r = self.gh.get(&format!("/repos/{repo}"), &[]).await?;
                let settings = self.settings();
                // Sprints automatiques : la branche de release du sprint en cours est la base des
                // branches d'issue et de leurs PR.
                let sprints = match self.load_project(&repo).await {
                    Ok(Some(p)) => json!({
                        "status": p.state.status,
                        "current_version": p.state.current().map(|c| c.version.clone()),
                        "release_branch": p.state.current().map(|c| c.branch()),
                    }),
                    _ => Value::Null,
                };
                Ok(json!({
                    "sprints": sprints,
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
        description = "Diff d'une pull request (patchs par fichier) pour la relire : tous les fichiers tronqués à 60 000 caractères, ou un seul avec `file`. Pour le contexte complet, lire le code dans un worktree."
    )]
    async fn get_pull_request_diff(&self, Parameters(p): Parameters<DiffParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let files = self
                    .gh
                    .get(
                        &format!("/repos/{repo}/pulls/{}/files", p.number),
                        &[("per_page", "100".into())],
                    )
                    .await?;
                let files = files.as_array().cloned().unwrap_or_default();
                let (diff, skipped) = pulls::diff_text(&files, p.file.as_deref(), 60_000);
                Ok(json!({ "repo": repo, "number": p.number, "files": files.len(), "diff": diff, "not_shown": skipped }))
            }
            .await,
        )
    }

    #[tool(
        description = "Publie une revue sur une pull request : APPROVE, REQUEST_CHANGES ou COMMENT, avec une synthèse et des remarques sur des lignes (`comments` : path, line côté nouvelle version, body). GitHub refuse d'approuver sa propre PR : la revue est alors publiée en commentaire et la réponse le signale."
    )]
    async fn review_pull_request(&self, Parameters(p): Parameters<ReviewParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                if p.body.trim().is_empty() {
                    bail!("Revue sans synthèse : résumez votre avis dans `body`.");
                }
                let event = match p.event {
                    ReviewEvent::Approve => "APPROVE",
                    ReviewEvent::RequestChanges => "REQUEST_CHANGES",
                    ReviewEvent::Comment => "COMMENT",
                };
                let comments: Vec<Value> = p
                    .comments
                    .iter()
                    .map(|c| json!({ "path": c.path, "line": c.line, "side": "RIGHT", "body": c.body }))
                    .collect();
                let send = |event: &str, body: &str| {
                    json!({ "event": event, "body": body, "comments": comments })
                };
                let path = format!("/repos/{repo}/pulls/{}/reviews", p.number);
                let (review, posted, note) = match self.gh.post(&path, &send(event, &p.body)).await {
                    Ok(r) => (r, event, None),
                    // Sa propre PR : ni approbation ni demande de changements possibles.
                    Err(e) if event != "COMMENT" && e.to_string().contains("your own pull request") => {
                        let verdict = if event == "APPROVE" { "✅ Approuvée" } else { "✋ Changements demandés" };
                        let body = format!("**{verdict}** (revue de l'IA ; GitHub n'accepte pas ce verdict sur une PR du même compte)\n\n{}", p.body);
                        let r = self.gh.post(&path, &send("COMMENT", &body)).await?;
                        (r, "COMMENT", Some("PR du même compte GitHub : verdict publié en commentaire."))
                    }
                    Err(e) => return Err(e),
                };
                Ok(json!({
                    "repo": repo, "number": p.number, "event": posted, "note": note,
                    "url": review["html_url"], "comments": p.comments.len(),
                }))
            }
            .await,
        )
    }

    #[tool(
        description = "Fusionne une pull request prête (sortie du brouillon, sans conflit). Vers une branche de release, ferme aussi les issues que la PR déclare fermer (« Ferme #12 ») : GitHub ne le fait que pour la branche par défaut. Jamais sans accord explicite de l'utilisateur."
    )]
    async fn merge_pull_request(&self, Parameters(p): Parameters<MergeParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let pr = self.gh.get(&format!("/repos/{repo}/pulls/{}", p.number), &[]).await?;
                if !pr["merged_at"].is_null() {
                    bail!("La pull request #{} est déjà fusionnée.", p.number);
                }
                if pr["state"].as_str() != Some("open") {
                    bail!("La pull request #{} est fermée.", p.number);
                }
                if pr["draft"].as_bool() == Some(true) {
                    bail!("La pull request #{} est en brouillon : sortez-la du brouillon (mark_pull_request_ready) avant de la fusionner.", p.number);
                }
                if pr["mergeable"].as_bool() == Some(false) {
                    bail!("La pull request #{} a des conflits avec {} : à résoudre d'abord.", p.number, pr["base"]["ref"].as_str().unwrap_or("sa base"));
                }
                let method = match p.method {
                    MergeMethod::Merge => "merge",
                    MergeMethod::Squash => "squash",
                    MergeMethod::Rebase => "rebase",
                };
                let merged = self
                    .gh
                    .put(
                        &format!("/repos/{repo}/pulls/{}/merge", p.number),
                        &json!({ "merge_method": method, "sha": pr["head"]["sha"] }),
                    )
                    .await?;
                let base = pr["base"]["ref"].as_str().unwrap_or("").to_string();
                let default_branch = pr["base"]["repo"]["default_branch"].as_str().unwrap_or("main");
                let mut closed = Vec::new();
                if base != default_branch {
                    for n in pulls::closing_refs(pr["body"].as_str().unwrap_or("")) {
                        let done = self
                            .gh
                            .patch(
                                &format!("/repos/{repo}/issues/{n}"),
                                &json!({ "state": "closed", "state_reason": "completed" }),
                            )
                            .await;
                        if done.is_ok() {
                            closed.push(n);
                        }
                    }
                }
                Ok(json!({ "repo": repo, "number": p.number, "merged": true, "sha": merged["sha"], "base": base, "closed_issues": closed }))
            }
            .await,
        )
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
        description = "Résumé du sprint en cours (sprints automatiques : leur état, durée, capacité, rythme, sprints terminés et livraison ; sinon le milestone daté ouvert le plus proche) ou d'une version donnée : issues par état, burndown jour par jour, rythme, retard sur la droite idéale."
    )]
    async fn sprint_summary(&self, Parameters(p): Parameters<SprintSummaryParams>) -> ToolResult {
        respond(self.do_sprint_summary(p).await)
    }

    #[tool(
        description = "Démarre les sprints automatiques d'un dépôt : crée l'issue d'état partagée (label cadence/sprints), le premier sprint (milestone daté + branche release/<version>) et le remplit par priorité dans la limite de la capacité. Seulement à la demande explicite de l'utilisateur (durée et capacité confirmées)."
    )]
    async fn project_start(&self, Parameters(p): Parameters<ProjectStartParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self
                    .start_project(&repo, p.duration_days, p.capacity, p.first_version)
                    .await?;
                Ok(json!({ "repo": repo, "project": project_view(&project) }))
            }
            .await,
        )
    }

    #[tool(
        description = "Met en pause les sprints automatiques : plus de remplissage ni de clôture ; à la reprise, l'échéance du sprint en cours est repoussée de la durée de la pause. Seulement à la demande de l'utilisateur."
    )]
    async fn project_pause(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self.pause_project(&repo, true).await?;
                Ok(json!({ "repo": repo, "project": project_view(&project) }))
            }
            .await,
        )
    }

    #[tool(
        description = "Reprend les sprints automatiques mis en pause (échéance du sprint en cours repoussée de la durée de la pause)."
    )]
    async fn project_resume(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self.pause_project(&repo, false).await?;
                Ok(json!({ "repo": repo, "project": project_view(&project) }))
            }
            .await,
        )
    }

    #[tool(
        description = "Change la durée des sprints automatiques (en jours : 14 = 2 semaines) : l'échéance du sprint en cours est recalculée et sa portée ajustée à la nouvelle capacité (issues ajoutées par priorité, ou issues « à faire » les moins urgentes retirées). Seulement à la demande de l'utilisateur."
    )]
    async fn project_set_duration(&self, Parameters(p): Parameters<ProjectDurationParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self.set_duration(&repo, p.duration_days).await?;
                Ok(json!({ "repo": repo, "project": project_view(&project) }))
            }
            .await,
        )
    }

    #[tool(
        description = "Roadmap d'un dépôt : jalons (nom, objectif, issues, avancement, sprints concernés, date de fin estimée au rythme moyen avec une fourchette au plus tôt / au plus tard), sprints terminés, en cours et prévus, issues ouvertes sans jalon, fin estimée de tout le travail ouvert. Les dates se précisent à chaque sprint."
    )]
    async fn roadmap(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                self.build_roadmap(&repo).await
            }
            .await,
        )
    }

    #[tool(
        description = "Crée ou modifie un jalon de la roadmap (nom clair, objectif, rang). Un jalon regroupe des issues réalisées en un ou plusieurs sprints ; il sert à l'affichage de la roadmap (ni branche ni milestone)."
    )]
    async fn jalon_save(&self, Parameters(p): Parameters<JalonSaveParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let name = p.name.trim().to_string();
                if name.is_empty() || name.chars().count() > 80 {
                    bail!("Nom de jalon vide ou trop long (80 caractères au plus).");
                }
                let mut saved = String::new();
                let project = self
                    .edit_state(&repo, |state| {
                        let index = match p.id.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
                            Some(id) => state
                                .jalons
                                .iter()
                                .position(|j| j.id == id)
                                .ok_or_else(|| anyhow!("Jalon « {id} » introuvable."))?,
                            None => {
                                let id = state.new_jalon_id(&name);
                                state.jalons.push(projet::Jalon {
                                    id,
                                    name: name.clone(),
                                    description: String::new(),
                                    issues: vec![],
                                });
                                state.jalons.len() - 1
                            }
                        };
                        let mut jalon = state.jalons.remove(index);
                        jalon.name = name.clone();
                        if let Some(d) = &p.description {
                            jalon.description = d.trim().to_string();
                        }
                        saved = jalon.id.clone();
                        let at = p
                            .position
                            .map(|n| n as usize)
                            .unwrap_or(index)
                            .min(state.jalons.len());
                        state.jalons.insert(at, jalon);
                        Ok(())
                    })
                    .await?;
                Ok(json!({ "repo": repo, "id": saved, "jalons": project.state.jalons }))
            }
            .await,
        )
    }

    #[tool(description = "Supprime un jalon de la roadmap (ses issues restent, sans jalon).")]
    async fn jalon_delete(&self, Parameters(p): Parameters<JalonParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self
                    .edit_state(&repo, |state| {
                        let before = state.jalons.len();
                        state.jalons.retain(|j| j.id != p.id);
                        if state.jalons.len() == before {
                            bail!("Jalon « {} » introuvable.", p.id);
                        }
                        Ok(())
                    })
                    .await?;
                Ok(json!({ "repo": repo, "jalons": project.state.jalons }))
            }
            .await,
        )
    }

    #[tool(
        description = "Designs du projet (Claude Design) : nom, lien claude.ai, état (pending = lien seulement, imported = fichiers dans le dépôt sous `path`), branche, fichier d'entrée. À consulter quand l'utilisateur parle d'un design ou d'un écran à réaliser."
    )]
    async fn list_designs(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let designs = self
                    .load_project(&repo)
                    .await?
                    .map(|p| p.state.designs)
                    .unwrap_or_default();
                Ok(json!({ "repo": repo, "designs": designs }))
            }
            .await,
        )
    }

    #[tool(
        description = "Lit un design importé : liste de ses fichiers dans le dépôt et contenu d'un fichier (le fichier d'entrée par défaut, tronqué à 60 000 caractères : lire le reste dans un worktree, sous `path`)."
    )]
    async fn get_design(&self, Parameters(p): Parameters<GetDesignParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let mut out = self
                    .read_design(&repo, &p.id, p.file.as_deref(), p.inline)
                    .await?;
                out["repo"] = json!(repo);
                Ok(out)
            }
            .await,
        )
    }

    #[tool(
        description = "Ajoute un design au projet à partir de son lien claude.ai (état « pending » : fichiers à importer ensuite, comme le fait le skill « Importer un design »). Rend son identifiant."
    )]
    async fn design_add(&self, Parameters(p): Parameters<DesignAddParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let name = p.name.trim().to_string();
                let url = p.url.trim().to_string();
                if name.is_empty() || name.chars().count() > 80 {
                    bail!("Nom de design vide ou trop long (80 caractères au plus).");
                }
                if !url.starts_with("https://claude.ai/") {
                    bail!("Lien invalide : collez le lien claude.ai du design (https://claude.ai/…).");
                }
                let mut id = String::new();
                let project = self
                    .edit_state(&repo, |state| {
                        id = state.new_design_id(&name);
                        state.designs.push(projet::Design {
                            id: id.clone(),
                            name: name.clone(),
                            url: url.clone(),
                            status: projet::DesignStatus::Pending,
                            description: p.description.unwrap_or_default().trim().to_string(),
                            path: None,
                            branch: None,
                            entry: None,
                            added_on: sprint::today(),
                            imported_on: None,
                        });
                        Ok(())
                    })
                    .await?;
                Ok(json!({ "repo": repo, "id": id, "designs": project.state.designs }))
            }
            .await,
        )
    }

    #[tool(
        description = "Met à jour un design : nom, description, et après import (fichiers commités et poussés) `imported: true` avec la branche (`ref`), le dossier (`path`) et le fichier d'entrée (`entry`)."
    )]
    async fn design_update(&self, Parameters(p): Parameters<DesignUpdateParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self
                    .edit_state(&repo, |state| {
                        let d = state
                            .designs
                            .iter_mut()
                            .find(|d| d.id == p.id)
                            .ok_or_else(|| anyhow!("Design « {} » introuvable.", p.id))?;
                        if let Some(n) = p.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                            d.name = n.to_string();
                        }
                        if let Some(desc) = &p.description {
                            d.description = desc.trim().to_string();
                        }
                        if let Some(b) = p.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
                            d.branch = Some(b.to_string());
                        }
                        if let Some(path) = p
                            .path
                            .as_deref()
                            .map(|x| x.trim().trim_matches('/'))
                            .filter(|x| !x.is_empty())
                        {
                            if path.contains("..") {
                                bail!("Dossier invalide : « {path} ».");
                            }
                            d.path = Some(path.to_string());
                        }
                        if let Some(e) = p.entry.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
                            d.entry = Some(e.to_string());
                        }
                        match p.imported {
                            Some(true) => {
                                d.status = projet::DesignStatus::Imported;
                                d.imported_on = Some(sprint::today());
                                d.path.get_or_insert_with(|| format!("design/{}", d.id));
                            }
                            Some(false) => d.status = projet::DesignStatus::Pending,
                            None => {}
                        }
                        Ok(())
                    })
                    .await?;
                let design = project.state.design(&p.id).cloned();
                Ok(json!({ "repo": repo, "design": design }))
            }
            .await,
        )
    }

    #[tool(
        description = "Retire un design du projet (ses fichiers restent dans le dépôt).",
        meta = ui_only()
    )]
    async fn design_delete(&self, Parameters(p): Parameters<DesignParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self
                    .edit_state(&repo, |state| {
                        let before = state.designs.len();
                        state.designs.retain(|d| d.id != p.id);
                        if state.designs.len() == before {
                            bail!("Design « {} » introuvable.", p.id);
                        }
                        Ok(())
                    })
                    .await?;
                Ok(json!({ "repo": repo, "designs": project.state.designs }))
            }
            .await,
        )
    }

    #[tool(
        description = "Planning (Gantt) du dépôt : personnes, phases (étude, développement, recette…), tâches avec dates, personnes affectées, dépendances, avancement, jalons-dates. Rend aussi `revision`, à repasser à planning_save."
    )]
    async fn planning_get(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let (planning, url) = self.load_planning(&repo).await?;
                Ok(json!({ "repo": repo, "revision": planning.revision, "planning": planning, "url": url, "today": sprint::today() }))
            }
            .await,
        )
    }

    #[tool(
        description = "Enregistre le planning (Gantt) complet du dépôt, qui remplace le précédent. Vérifie dates (AAAA-MM-JJ, fin ≥ début), personnes, dépendances (sans boucle) ; refuse si `base_revision` n'est plus la révision courante. Un skill ne l'appelle qu'après accord explicite de l'utilisateur sur le planning proposé."
    )]
    async fn planning_save(&self, Parameters(p): Parameters<PlanningSaveParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let planning = self.save_planning(&repo, p.planning, p.base_revision).await?;
                Ok(json!({ "repo": repo, "revision": planning.revision, "planning": planning }))
            }
            .await,
        )
    }

    #[tool(
        description = "Architecture du projet, à suivre en codant : services (proxy, front, back, base…) et leurs liens, puis pour chaque service ses couches (controller, service, DTO, repository…), les couches que chacune peut utiliser, ses règles et conventions. Lue dans `architecture/architecture.json` (branche de la PR d'architecture ouverte, sinon la base) ; aussi lisible en Markdown dans `architecture/ARCHITECTURE.md` du worktree."
    )]
    async fn architecture_get(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let (architecture, source) = self.load_architecture(&repo).await?;
                let markdown = architecture.as_ref().map(|a| crate::architecture::render_markdown(a, &repo));
                Ok(json!({ "repo": repo, "architecture": architecture, "source": source, "markdown": markdown }))
            }
            .await,
        )
    }

    #[tool(
        description = "Modèles d'architecture prêts à appliquer : systèmes complets (web classique, API + cache + tâches, microservices) et intérieurs de service (API REST en couches, hexagonale, NestJS, Spring Boot, Express, FastAPI, Django, React par fonctionnalités, Next.js, Tauri)."
    )]
    async fn architecture_templates(&self, Parameters(_): Parameters<Empty>) -> ToolResult {
        respond(Ok(json!({ "templates": crate::architecture::templates() })))
    }

    #[tool(
        description = "Enregistre l'architecture complète du dépôt : commit de architecture/architecture.json et du ARCHITECTURE.md généré sur une branche archi/… et pull request (réutilisée tant qu'elle est ouverte). Vérifie identifiants, natures de service, liens et couches. Une IA ne l'appelle qu'après accord explicite de l'utilisateur."
    )]
    async fn architecture_save(&self, Parameters(p): Parameters<ArchitectureSaveParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                crate::architecture::validate(&p.architecture)?;
                let source = self.save_architecture(&repo, &p.architecture, &p.message).await?;
                Ok(json!({ "repo": repo, "source": source, "architecture": p.architecture }))
            }
            .await,
        )
    }

    #[tool(
        description = "Range des issues dans un jalon (une issue n'appartient qu'à un jalon : elle quitte le précédent) ou les en retire."
    )]
    async fn jalon_issues(&self, Parameters(p): Parameters<JalonIssuesParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                if p.add.is_empty() && p.remove.is_empty() {
                    bail!("Rien à modifier : précisez `add` ou `remove`.");
                }
                let project = self
                    .edit_state(&repo, |state| state.assign(&p.id, &p.add, &p.remove))
                    .await?;
                Ok(json!({ "repo": repo, "jalons": project.state.jalons }))
            }
            .await,
        )
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
                 labels type/*, status/*, sp/* (story points), priority/* ; un milestone daté est un sprint, \
                 sans date un palier. Sprints automatiques : chaque sprint a sa branche release/<version>, \
                 base des branches d'issue (voir get_repository). Roadmap : jalons (roadmap, jalon_save, \
                 jalon_issues), dates de fin estimées au rythme réel. \
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
            "project_start",
            "project_pause",
            "project_resume",
            "project_set_duration",
            "roadmap",
            "jalon_save",
            "jalon_delete",
            "jalon_issues",
            "list_designs",
            "get_design",
            "design_add",
            "design_update",
            "design_delete",
            "planning_get",
            "planning_save",
            "architecture_get",
            "architecture_templates",
            "architecture_save",
            "get_pull_request_diff",
            "review_pull_request",
            "merge_pull_request",
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
                "get_account" | "list_account_repos" | "architecture_templates" => {}
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
        for name in ["get_account", "list_account_repos", "design_delete"] {
            let tool = tools.iter().find(|t| t.name == name).unwrap();
            let meta = tool.meta.as_ref().expect("_meta");
            assert_eq!(meta.0.get("cadence/visibility"), Some(&json!("ui")));
        }
        // Ouverts à l'IA : on peut tout demander depuis le chat.
        for name in [
            "list_issues",
            "sprint_summary",
            "project_set_duration",
            "design_add",
            "review_pull_request",
        ] {
            let tool = tools.iter().find(|t| t.name == name).unwrap();
            assert!(tool.meta.is_none(), "{name} devrait être visible de l'IA");
        }
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

        // Story points hors de la suite de Fibonacci, priorité hors de 0..5 : refus lisible.
        let r = s
            .create_issue(Parameters(CreateIssueParams {
                repo: "me/app".into(),
                title: "Export PDF".into(),
                body: None,
                issue_type: None,
                status: None,
                points: Some(4),
                priority: None,
                labels: vec![],
                milestone: None,
                assignees: vec![],
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("1, 2, 3, 5, 8 ou 13"), "{}", text(&r));
        let r = s
            .update_issue(Parameters(UpdateIssueParams {
                repo: "me/app".into(),
                number: 3,
                title: None,
                body: None,
                state: None,
                state_reason: None,
                status: None,
                points: None,
                priority: Some(7),
                labels: None,
                add_labels: vec![],
                remove_labels: vec![],
                milestone: None,
                assignees: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("de 0 (socle) à 5"), "{}", text(&r));

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

        // Sprints automatiques : durée et capacité vérifiées avant GitHub.
        let r = s
            .project_start(Parameters(ProjectStartParams {
                repo: "me/app".into(),
                duration_days: 0,
                capacity: 20,
                first_version: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("de 1 à 90"), "{}", text(&r));
        let r = s
            .project_start(Parameters(ProjectStartParams {
                repo: "me/app".into(),
                duration_days: 14,
                capacity: 0,
                first_version: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("Capacité invalide"), "{}", text(&r));
        let r = s
            .project_set_duration(Parameters(ProjectDurationParams {
                repo: "me/app".into(),
                duration_days: 120,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("de 1 à 90"), "{}", text(&r));

        // Jalons : nom et modifications vérifiés avant GitHub.
        let r = s
            .jalon_save(Parameters(JalonSaveParams {
                repo: "me/app".into(),
                id: None,
                name: "  ".into(),
                description: None,
                position: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("Nom de jalon vide"), "{}", text(&r));
        let r = s
            .jalon_issues(Parameters(JalonIssuesParams {
                repo: "me/app".into(),
                id: "mvp".into(),
                add: vec![],
                remove: vec![],
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("Rien à modifier"), "{}", text(&r));

        // Designs : lien claude.ai exigé ; planning vérifié avant GitHub.
        let r = s
            .design_add(Parameters(DesignAddParams {
                repo: "me/app".into(),
                name: "Accueil".into(),
                url: "https://example.com/design".into(),
                description: None,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("lien claude.ai"), "{}", text(&r));
        let mut planning = crate::planning::Planning::default();
        planning.tasks.push(crate::planning::Task {
            id: "t1".into(),
            name: "Étude".into(),
            phase: String::new(),
            start: "2026-10-20".into(),
            end: "2026-10-01".into(),
            people: vec![],
            depends: vec![],
            progress: 0,
            milestone: false,
            issue: None,
            notes: String::new(),
        });
        let r = s
            .planning_save(Parameters(PlanningSaveParams {
                repo: "me/app".into(),
                planning,
                base_revision: 0,
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("avant de commencer"), "{}", text(&r));

        // Architecture vérifiée avant GitHub.
        let mut architecture = crate::architecture::Architecture::default();
        architecture.links.push(crate::architecture::Link {
            from: "web".into(),
            to: "api".into(),
            label: String::new(),
        });
        let r = s
            .architecture_save(Parameters(ArchitectureSaveParams {
                repo: "me/app".into(),
                architecture,
                message: "test".into(),
            }))
            .await
            .unwrap();
        assert!(text(&r).contains("n'existe pas"), "{}", text(&r));

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
