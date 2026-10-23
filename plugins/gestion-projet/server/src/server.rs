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
//!   défaut), `mark_pull_request_ready` (GraphQL `markPullRequestReadyForReview`),
//!   `get_pull_request_diff`, `review_pull_request` (approbation, changements demandés,
//!   commentaire), `merge_pull_request` (méthode, issues fermées comme terminées, branche
//!   supprimée). `update_issue` avec `state: closed` passe l'issue à « terminé ».
//! - Releases : `list_releases`, `create_release` (brouillon par défaut, tag = préfixe + version).
//! - Sprints automatiques (réservés à l'UI, voir `projet` et `engine`) : `project_start`,
//!   `project_pause`, `project_resume`, `project_set_duration` (sprint suivant, ou en cours après
//!   confirmation), `project_close_sprint` (clôture anticipée), `sprint_issues` (ajouter / retirer
//!   des issues du sprint en cours), `sprint_backlog` (carnet dans l'ordre de remplissage).
//!   L'issue d'état `cadence/sprints` est masquée de `list_issues`.
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
    config::{self, Env, MergeMethod, Settings},
    engine::Project,
    github::GitHub,
    model::{self, IssueType, Status},
    projet, pulls, sprint,
};

type ToolResult = Result<CallToolResult, McpError>;

/// Écritures récentes d'issues par dépôt : numéro → (réponse de GitHub, instant de l'écriture).
type RecentIssues = HashMap<String, HashMap<u32, (Value, Instant)>>;

/// Durée pendant laquelle une écriture d'issue corrige les listes de GitHub (`patch_listing`).
const RECENT_WRITES: std::time::Duration = std::time::Duration::from_secs(120);

/// Notification de Cadence : dépôts suivis modifiés (service `repos`).
pub const REPOS_NOTIFICATION: &str = "notifications/cadence/repos";
/// Notification de Cadence : réglages globaux modifiés.
pub const SETTINGS_NOTIFICATION: &str = "notifications/cadence/settings";
/// Notification vers Cadence, relayée aux écrans du plugin (`cadence.on(event, …)`).
pub const EVENT_NOTIFICATION: &str = "notifications/cadence/event";
/// Événement des écrans : un outil vient d'écrire sur GitHub (`{ repo, tool }`).
pub const SYNC_EVENT: &str = "sync.updated";
/// Outils qui écrivent sur un dépôt (issues, sprint, PR) : `sync.updated` après chacun.
const WRITE_TOOLS: &[&str] = &[
    "create_issue",
    "update_issue",
    "create_milestone",
    "update_milestone",
    "create_pull_request",
    "update_pull_request",
    "mark_pull_request_ready",
    "review_pull_request",
    "merge_pull_request",
    "create_release",
    "project_start",
    "project_pause",
    "project_resume",
    "project_set_duration",
    "project_close_sprint",
    "project_ship_release",
    "sprint_issues",
    "jalon_save",
    "jalon_delete",
    "jalon_issues",
];

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
    /// Durée d'un sprint en jours (1 à 90 ; 1 = un sprint par jour), modifiable ensuite.
    pub duration_days: u32,
    /// Story points du premier sprint ; ensuite, la capacité suit le rythme réel.
    pub capacity: u32,
    /// Version du premier sprint (ex. 0.1.0) ; absente : mineure suivante de la plus haute version.
    pub first_version: Option<String>,
}

/// Sprint concerné par un changement de durée.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DurationApply {
    /// À partir du sprint suivant : le sprint en cours garde son échéance et sa portée.
    #[default]
    Next,
    /// Aussi au sprint en cours : échéance de son milestone recalculée, portée ajustée.
    Current,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ProjectDurationParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Nouvelle durée d'un sprint en jours (1 à 90).
    pub duration_days: u32,
    /// `next` (défaut) : à partir du sprint suivant ; `current` : aussi au sprint en cours (son
    /// échéance sur GitHub change), seulement si l'utilisateur l'a confirmé.
    #[serde(default)]
    pub apply: DurationApply,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CloseSprintParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Version du sprint à clore, telle que l'utilisateur l'a vue (refus si le sprint en cours a
    /// changé entre-temps) ; absente : le sprint en cours.
    pub version: Option<String>,
    /// Issues ouvertes du sprint à rendre au carnet (sans version) au lieu de les reporter au
    /// sprint suivant : l'excédent sur sa capacité, au choix de l'utilisateur.
    #[serde(default)]
    pub to_backlog: Vec<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ShipReleaseParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Version du sprint terminé dont la branche de release est à fusionner.
    pub version: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SprintIssuesParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Issues à ajouter au sprint en cours (elles prennent sa version).
    #[serde(default)]
    pub add: Vec<u32>,
    /// Issues à retirer du sprint en cours (elles repartent au carnet, sans version).
    #[serde(default)]
    pub remove: Vec<u32>,
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

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MergeParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Numéro de la pull request.
    pub number: u32,
    /// squash, merge ou rebase ; absente : réglage `merge_method` du plugin (squash par défaut).
    pub method: Option<MergeMethod>,
    /// Supprimer la branche source une fois fusionnée (jamais la branche par défaut, une branche
    /// `release/*` ou la branche d'un fork).
    #[serde(default)]
    pub delete_branch: bool,
    /// Issues à fermer comme terminées après la fusion, en plus de celles que la PR déclare
    /// fermer (« Ferme #12 ») ; leur label `status/*` est retiré.
    #[serde(default)]
    pub close_issues: Vec<u32>,
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
pub struct UpdatePullRequestParams {
    /// Dépôt `owner/name` parmi les dépôts suivis.
    pub repo: String,
    /// Numéro de la pull request (ouverte).
    pub number: u32,
    /// Nouvelle branche cible : la branche de release du sprint ou la branche par défaut (jamais
    /// la branche d'une autre PR).
    pub base: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
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
    /// Issues écrites par ce processus depuis peu (réponse de GitHub), par dépôt : les listes de
    /// GitHub mettent quelques secondes à refléter un changement de milestone, de labels ou
    /// d'état ; on les corrige avec ces réponses (voir `patch_listing`).
    recent_issues: Arc<Mutex<RecentIssues>>,
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
            recent_issues: Arc::default(),
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

    /// Retient une issue que ce processus vient d'écrire (réponse brute de GitHub).
    pub(crate) fn remember_issue(&self, repo: &str, raw: &Value) {
        let Some(n) = raw["number"].as_u64().and_then(|n| u32::try_from(n).ok()) else {
            return;
        };
        self.recent_issues
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(repo.to_string())
            .or_default()
            .insert(n, (raw.clone(), Instant::now()));
    }

    /// Corrige une liste brute d'issues lue sur GitHub avec les écritures récentes de ce processus
    /// (moins de `RECENT_WRITES`) : l'entrée périmée est remplacée par la réponse de l'écriture, ou
    /// retirée si l'issue ne fait plus partie de la liste (`keep` faux) ; une issue qui vient d'y
    /// entrer est ajoutée. Une entrée de la liste plus récente que l'écriture (`updated_at`) fait foi.
    pub(crate) fn patch_listing(
        &self,
        repo: &str,
        mut list: Vec<Value>,
        keep: impl Fn(&Value) -> bool,
    ) -> Vec<Value> {
        let fresh: Vec<Value> = {
            let mut all = self.recent_issues.lock().unwrap_or_else(|e| e.into_inner());
            let Some(issues) = all.get_mut(repo) else {
                return list;
            };
            issues.retain(|_, (_, at)| at.elapsed() < RECENT_WRITES);
            issues.values().map(|(raw, _)| raw.clone()).collect()
        };
        for raw in fresh {
            let listed = list.iter().position(|i| i["number"] == raw["number"]);
            if let Some(i) = listed {
                let newer = match (list[i]["updated_at"].as_str(), raw["updated_at"].as_str()) {
                    (Some(listed), Some(written)) => listed > written,
                    _ => false,
                };
                if newer {
                    continue;
                }
                list.remove(i);
            }
            if keep(&raw) {
                list.push(raw);
            }
        }
        list
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
        self.remember_issue(&repo, &raw);
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
        // Fermer l'issue la passe à « terminé » : son label `status/*` n'a plus lieu d'être.
        let closing = matches!(p.state, Some(IssueState::Closed));
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
            || !p.remove_labels.is_empty()
            || closing;
        if touches_labels {
            let mut labels = match p.labels {
                Some(l) => l,
                None => model::issue_from(&self.raw_issue(&repo, p.number).await?, false).labels,
            };
            labels = model::edit_labels(&labels, &p.add_labels, &p.remove_labels);
            if let Some(s) = p.status {
                labels = model::with_status(&labels, s);
            }
            if closing {
                labels.retain(|l| !l.starts_with("status/"));
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
        self.remember_issue(&repo, &raw);
        Ok(serde_json::to_value(model::issue_in(&repo, &raw, true))?)
    }

    /// Ferme une issue comme terminée et retire son label `status/*` (fusion d'une PR validée).
    async fn close_as_done(&self, repo: &str, number: u32) -> Result<()> {
        let raw = self.raw_issue(repo, number).await?;
        if model::is_pull_request(&raw) {
            bail!("#{number} est une pull request, pas une issue.");
        }
        let mut labels = model::issue_from(&raw, false).labels;
        labels.retain(|l| !l.starts_with("status/"));
        let raw = self
            .gh
            .patch(
                &format!("/repos/{repo}/issues/{number}"),
                &json!({ "state": "closed", "state_reason": "completed", "labels": labels }),
            )
            .await?;
        self.remember_issue(repo, &raw);
        Ok(())
    }

    async fn do_merge(&self, p: MergeParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let pr = self
            .gh
            .get(&format!("/repos/{repo}/pulls/{}", p.number), &[])
            .await?;
        if !pr["merged_at"].is_null() {
            bail!("La pull request #{} est déjà fusionnée.", p.number);
        }
        if pr["state"].as_str() != Some("open") {
            bail!("La pull request #{} est fermée.", p.number);
        }
        if pr["draft"].as_bool() == Some(true) {
            bail!(
                "La pull request #{} est en brouillon : sortez-la du brouillon (mark_pull_request_ready) avant de la fusionner.",
                p.number
            );
        }
        if pr["mergeable"].as_bool() == Some(false) {
            bail!(
                "La pull request #{} a des conflits avec {} : à résoudre d'abord.",
                p.number,
                pr["base"]["ref"].as_str().unwrap_or("sa base")
            );
        }
        let method = p.method.unwrap_or(self.settings().merge_method);
        let merged = self
            .gh
            .put(
                &format!("/repos/{repo}/pulls/{}/merge", p.number),
                &json!({ "merge_method": method.as_str(), "sha": pr["head"]["sha"] }),
            )
            .await?;
        let base = pr["base"]["ref"].as_str().unwrap_or("").to_string();
        let default_branch = pr["base"]["repo"]["default_branch"].as_str().unwrap_or("main");

        // Issues terminées : celles demandées, puis celles que la PR déclare fermer (GitHub ne
        // ferme ces dernières que vers la branche par défaut, et sans toucher aux labels).
        let mut wanted = p.close_issues.clone();
        for n in pulls::closing_refs(pr["body"].as_str().unwrap_or("")) {
            if !wanted.contains(&n) {
                wanted.push(n);
            }
        }
        let mut closed = Vec::new();
        let mut errors: Vec<Value> = Vec::new();
        for n in wanted {
            match self.close_as_done(&repo, n).await {
                Ok(()) => closed.push(n),
                Err(e) => errors.push(json!({ "issue": n, "message": format!("{e:#}") })),
            }
        }

        // Branche source : supprimée seulement si elle est du dépôt et n'est pas une branche longue.
        let head = pr["head"]["ref"].as_str().unwrap_or("").to_string();
        let same_repo = pr["head"]["repo"]["full_name"]
            .as_str()
            .is_some_and(|f| f.eq_ignore_ascii_case(&repo));
        let mut branch_deleted = false;
        let mut note: Option<String> = None;

        // PR empilées sur la branche fusionnée (base = cette branche) : elles visent désormais la
        // base de la PR fusionnée, sinon GitHub les fermerait à la suppression de la branche (N11).
        let mut retargeted: Vec<u64> = Vec::new();
        let long_lived = head == default_branch || head.starts_with("release/") || head.is_empty();
        if same_repo && !long_lived && !base.is_empty() {
            let stacked = self
                .gh
                .get(
                    &format!("/repos/{repo}/pulls"),
                    &[
                        ("state", "open".into()),
                        ("base", head.clone()),
                        ("per_page", "100".into()),
                    ],
                )
                .await?;
            for n in stacked
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| p["number"].as_u64())
            {
                match self
                    .gh
                    .patch(&format!("/repos/{repo}/pulls/{n}"), &json!({ "base": base }))
                    .await
                {
                    Ok(_) => retargeted.push(n),
                    Err(e) => errors.push(json!({ "pull_request": n, "message": format!("{e:#}") })),
                }
            }
        }
        if p.delete_branch {
            if !same_repo {
                note = Some(format!("Branche {head} gardée : elle vient d'un fork."));
            } else if head == default_branch || head.starts_with("release/") || head.is_empty() {
                note = Some(format!(
                    "Branche {head} gardée : branche par défaut ou de release."
                ));
            } else {
                match self
                    .gh
                    .delete(&format!("/repos/{repo}/git/refs/heads/{head}"))
                    .await
                {
                    Ok(()) => branch_deleted = true,
                    Err(e) => errors.push(json!({ "branch": head, "message": format!("{e:#}") })),
                }
            }
        }

        let mut out = json!({
            "repo": repo, "number": p.number, "merged": true, "method": method.as_str(),
            "sha": merged["sha"], "base": base, "head": head, "closed_issues": closed,
            "branch_deleted": branch_deleted, "retargeted": retargeted,
        });
        if let Some(note) = note {
            out["note"] = json!(note);
        }
        if !errors.is_empty() {
            out["errors"] = Value::Array(errors);
        }
        Ok(out)
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
        let mut raws: Vec<Value> = Vec::new();
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
            raws.extend(p.body.as_array().cloned().unwrap_or_default());
            if !p.has_next {
                break;
            }
        }
        // Issue tout juste ajoutée au sprint, retirée ou fermée : la réponse de l'écriture fait foi
        // tant que la liste de GitHub ne la reflète pas (N08).
        let raws = self.patch_listing(repo, raws, |raw| {
            raw["milestone"]["number"].as_u64() == Some(u64::from(number))
        });
        Ok(raws
            .iter()
            .filter(|raw| !model::is_pull_request(raw))
            .map(|raw| model::issue_in(repo, raw, false))
            .collect())
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
        let length = sprint_length(project.as_ref(), &settings);
        let mut out = json!({
            "repo": repo,
            "today": today,
            "sprint_length_days": length,
        });
        merge(
            &mut out,
            project_summary(project.as_ref(), &settings, &milestones),
        );
        if let Some(err) = project_error {
            out["project_error"] = json!(err);
        }
        let started = project.as_ref().is_some_and(|p| p.state.started());
        let Some(raw) = chosen else {
            out["sprint"] = Value::Null;
            out["message"] = json!(if started {
                "Le sprint en cours n'a pas encore de milestone : il sera créé à la prochaine passe."
            } else {
                NOT_STARTED_MESSAGE
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
            length,
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
        self.check_base(&repo, &base, &default_branch, Some(p.head.trim()))
            .await?;
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

    /// Garde-fou des bases de PR (N11) : une PR d'issue vise la branche par défaut ou une branche
    /// `release/*`, jamais la branche d'une autre PR ouverte (fusionnée puis supprimée, GitHub
    /// fermerait la PR empilée) ; avec les sprints automatiques, toute autre base est refusée.
    async fn check_base(
        &self,
        repo: &str,
        base: &str,
        default_branch: &str,
        head: Option<&str>,
    ) -> Result<()> {
        if base == default_branch || base.starts_with("release/") {
            return Ok(());
        }
        let release = match self.load_project(repo).await {
            Ok(Some(p)) if p.state.started() => p.state.current().map(|c| c.branch()),
            _ => None,
        };
        let target = release.clone().unwrap_or_else(|| default_branch.to_string());
        let owner = repo.split_once('/').map_or(repo, |(o, _)| o);
        let stacked = self
            .gh
            .get(
                &format!("/repos/{repo}/pulls"),
                &[
                    ("state", "open".into()),
                    ("head", format!("{owner}:{base}")),
                    ("per_page", "10".into()),
                ],
            )
            .await?;
        let other = stacked
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| head.is_none_or(|h| p["head"]["ref"].as_str() != Some(h)))
            .find_map(|p| p["number"].as_u64());
        if let Some(n) = other {
            bail!(
                "Refusé : « {base} » est la branche de la PR #{n}. Une branche d'issue part toujours \
                 de {target} et sa PR la vise (base: \"{target}\") ; une fois #{n} fusionnée et sa \
                 branche supprimée, GitHub fermerait cette PR. Recréez la branche depuis \
                 origin/{target} (ou fusionnez-y origin/{target}) puis visez {target}."
            );
        }
        if let Some(release) = release {
            bail!(
                "Refusé : avec les sprints automatiques, une PR d'issue vise la branche de release \
                 du sprint en cours ({release}) ou la branche par défaut, pas « {base} »."
            );
        }
        Ok(())
    }

    async fn do_update_pull_request(&self, p: UpdatePullRequestParams) -> Result<Value> {
        let repo = self.repo(&p.repo)?;
        let mut body = json!({});
        if let Some(t) = p.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            body["title"] = json!(t);
        }
        if let Some(b) = p.body {
            body["body"] = json!(b);
        }
        if let Some(base) = p.base.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            let pr = self
                .gh
                .get(&format!("/repos/{repo}/pulls/{}", p.number), &[])
                .await?;
            if pr["state"].as_str() != Some("open") {
                bail!(
                    "La pull request #{} n'est plus ouverte : sa base ne peut plus changer. Si sa \
                     base a été supprimée, ouvrez une nouvelle PR depuis la même branche vers la \
                     branche de release (create_pull_request).",
                    p.number
                );
            }
            let default_branch = pr["base"]["repo"]["default_branch"].as_str().unwrap_or("main");
            let head = pr["head"]["ref"].as_str().unwrap_or("");
            if head == base {
                bail!("La branche source et la branche cible sont identiques (« {base} »).");
            }
            self.check_base(&repo, base, default_branch, Some(head)).await?;
            body["base"] = json!(base);
        }
        if body.as_object().is_some_and(|o| o.is_empty()) {
            bail!("Rien à modifier : précisez base, title ou body.");
        }
        let raw = self
            .gh
            .patch(&format!("/repos/{repo}/pulls/{}", p.number), &body)
            .await?;
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

/// Sprints automatiques pas encore démarrés (pas d'issue d'état, ou une issue d'état « idle » qui
/// ne porte que les jalons et les designs).
const NOT_STARTED_MESSAGE: &str = concat!(
    "Sprints automatiques pas encore démarrés : « Démarrer le projet » (écran Sprint en cours, ",
    "ou l'outil project_start à la demande de l'utilisateur) crée le premier sprint et le remplit ",
    "avec les issues sans version, par priorité. Sans cela, datez une version."
);

/// Durée d'un sprint en jours : celle des sprints automatiques une fois démarrés (issue d'état),
/// sinon le réglage `sprint_length_days` du plugin.
fn sprint_length(project: Option<&Project>, settings: &Settings) -> u32 {
    project
        .filter(|p| p.state.started())
        .map(|p| p.state.duration_days)
        .unwrap_or(settings.sprint_length_days)
}

/// Copie les champs de `extra` (un objet) dans `out`.
fn merge(out: &mut Value, extra: Value) {
    if let (Some(out), Value::Object(extra)) = (out.as_object_mut(), extra) {
        out.extend(extra);
    }
}

/// Partie « sprints automatiques » de `sprint_summary` : `started`, `project` (seulement une fois
/// démarrés : l'écran Sprint propose sinon « Démarrer le projet ») et `start_defaults` tant qu'ils
/// ne le sont pas — durée de l'issue d'état « idle » si elle existe, sinon celle des réglages.
fn project_summary(project: Option<&Project>, settings: &Settings, milestones: &[Value]) -> Value {
    let started = project.is_some_and(|p| p.state.started());
    let milestone_titles: Vec<String> = milestones
        .iter()
        .filter_map(|m| m["title"].as_str().map(str::to_string))
        .collect();
    let mut out = json!({
        "started": started,
        "project": project
            .filter(|_| started)
            .map(|p| project_view_with(p, milestones, &settings.tag_prefix)),
    });
    if !started {
        let days = project
            .map(|p| p.state.duration_days)
            .unwrap_or(settings.sprint_length_days)
            .clamp(projet::MIN_DAYS, projet::MAX_DAYS);
        out["start_defaults"] = json!({
            "duration_days": days,
            // 10 story points par semaine pour commencer : la capacité suit ensuite le rythme réel.
            "capacity": projet::start_capacity(days),
            "first_version": projet::next_version(&milestone_titles, &settings.tag_prefix),
        });
        if let Some(p) = project {
            // Issue d'état existante (jalons de la roadmap) : réutilisée au démarrage.
            out["state_issue"] = json!({ "number": p.issue, "url": p.url });
        }
    }
    out
}

/// État des sprints automatiques tel que l'écran Sprint l'affiche (six derniers sprints).
fn project_view(project: &Project) -> Value {
    project_view_with(project, &[], "")
}

/// `project_view`, chaque sprint portant le numéro de son milestone (`milestone`) s'il est dans
/// `milestones` : l'écran retrouve les conversations d'un sprint terminé (groupe
/// `sprint:<repo>:<n°>`).
fn project_view_with(project: &Project, milestones: &[Value], tag_prefix: &str) -> Value {
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
            v["milestone"] = model::find_milestone(milestones, &r.version, tag_prefix)
                .and_then(|m| m["number"].as_u64())
                .map_or(Value::Null, |n| json!(n));
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
        meta = ui_only(),
        annotations(read_only_hint = true)
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
        meta = ui_only(),
        annotations(read_only_hint = true)
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
        description = "Dépôt GitHub suivi : nom complet, branche par défaut, visibilité, URL, préfixe de tag et, si les sprints automatiques sont démarrés, la branche de release du sprint en cours (`sprints.release_branch`). À lire avant de créer une branche ou une PR.",
        annotations(read_only_hint = true)
    )]
    async fn get_repository(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let r = self.gh.get(&format!("/repos/{repo}"), &[]).await?;
                let settings = self.settings();
                // Sprints automatiques : la branche de release du sprint en cours est la base des
                // branches d'issue et de leurs PR.
                let project = self.load_project(&repo).await.ok().flatten();
                let sprints = match &project {
                    Some(p) => json!({
                        "started": p.state.started(),
                        "status": p.state.status,
                        "duration_days": p.state.duration_days,
                        "current_version": p.state.current().map(|c| c.version.clone()),
                        "release_branch": p.state.current().map(|c| c.branch()),
                        "due_on": p.state.current().map(|c| c.due_on.clone()),
                    }),
                    None => Value::Null,
                };
                // Durée réelle des sprints : celle de l'issue d'état une fois démarrés (N07), le
                // réglage du plugin sinon.
                let length = sprint_length(project.as_ref(), &settings);
                Ok(json!({
                    "sprints": sprints,
                    "repo": repo,
                    "full_name": r["full_name"],
                    "default_branch": r["default_branch"],
                    "private": r["private"],
                    "url": r["html_url"],
                    "open_issues": r["open_issues_count"],
                    "tag_prefix": settings.tag_prefix,
                    "sprint_length_days": length,
                }))
            }
            .await,
        )
    }

    #[tool(
        description = "Liste les issues (sans les pull requests), triées par dernière mise à jour. Avec `repo` : ce dépôt ; sans `repo` : tous les dépôts suivis, chaque issue portant son champ `repo`. Chaque issue porte son type (label type/*), son état (todo, doing, review, done), son estimation et sa version (milestone).",
        annotations(read_only_hint = true)
    )]
    async fn list_issues(&self, Parameters(p): Parameters<ListIssuesParams>) -> ToolResult {
        respond(self.do_list_issues(p).await)
    }

    #[tool(
        description = "Lit une issue d'un dépôt suivi : titre, description markdown, labels, version, assignés et commentaires.",
        annotations(read_only_hint = true)
    )]
    async fn get_issue(&self, Parameters(p): Parameters<GetIssueParams>) -> ToolResult {
        respond(self.do_get_issue(p).await)
    }

    #[tool(
        description = "Crée une issue dans un dépôt suivi. Le type et l'état deviennent des labels type/* et status/* ; la version est le titre d'un milestone existant.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn create_issue(&self, Parameters(p): Parameters<CreateIssueParams>) -> ToolResult {
        respond(self.do_create_issue(p).await)
    }

    #[tool(
        description = "Modifie une issue d'un dépôt suivi : titre, description, état ouvert/fermé, état d'avancement (status), labels (remplacer, ajouter, retirer), version, assignés.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true)
    )]
    async fn update_issue(&self, Parameters(p): Parameters<UpdateIssueParams>) -> ToolResult {
        respond(self.do_update_issue(p).await)
    }

    #[tool(
        description = "Ajoute un commentaire markdown à une issue ou à une pull request d'un dépôt suivi.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
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
        description = "Liste les versions (milestones) d'un dépôt suivi : un milestone daté est un sprint, un milestone sans date un palier de roadmap. La description d'un palier liste ses thèmes.",
        annotations(read_only_hint = true)
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
        description = "Crée une version (milestone) dans un dépôt suivi. Avec une échéance (AAAA-MM-JJ), c'est un sprint ; sans date, un palier de roadmap. La description peut commencer par « # Nom » et lister les thèmes (« - Thème »).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn create_milestone(&self, Parameters(p): Parameters<MilestoneParams>) -> ToolResult {
        respond(self.do_create_milestone(p).await)
    }

    #[tool(
        description = "Modifie une version (milestone) désignée par son titre : nouveau titre, description, échéance (chaîne vide pour la retirer), ou state « closed » pour la clore (« open » pour la rouvrir).",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true)
    )]
    async fn update_milestone(&self, Parameters(p): Parameters<UpdateMilestoneParams>) -> ToolResult {
        respond(self.do_update_milestone(p).await)
    }

    #[tool(
        description = "Liste les pull requests (ouvertes par défaut ; closed = 30 dernières fusionnées ou fermées) avec l'état des checks (CI), des revues, la branche, la version et les issues fermées. Avec `repo` : ce dépôt ; sans `repo` : tous les dépôts suivis, chaque PR portant son champ `repo`.",
        annotations(read_only_hint = true)
    )]
    async fn list_pull_requests(&self, Parameters(p): Parameters<ListPullRequestsParams>) -> ToolResult {
        respond(self.do_list_pull_requests(p).await)
    }

    #[tool(
        description = "Lit une pull request d'un dépôt suivi : description, branches, checks du dernier commit, revues, fichiers modifiés (sans les patchs : lire le code dans un worktree).",
        annotations(read_only_hint = true)
    )]
    async fn get_pull_request(&self, Parameters(p): Parameters<NumberParams>) -> ToolResult {
        respond(self.do_get_pull_request(p).await)
    }

    #[tool(
        description = "Ouvre une pull request (brouillon par défaut) depuis une branche déjà poussée vers la branche par défaut (ou `base`, la branche de release du sprint pour une issue). Refuse la branche par défaut comme source et, comme base, la branche d'une autre PR ouverte (PR empilée).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn create_pull_request(&self, Parameters(p): Parameters<CreatePullRequestParams>) -> ToolResult {
        respond(self.do_create_pull_request(p).await)
    }

    #[tool(
        description = "Modifie une pull request ouverte : `base` (repointer vers la branche de release du sprint ou la branche par défaut, par exemple quand sa base est la branche d'une autre PR), `title`, `body`. Refuse la branche d'une autre PR comme base.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn update_pull_request(&self, Parameters(p): Parameters<UpdatePullRequestParams>) -> ToolResult {
        respond(self.do_update_pull_request(p).await)
    }

    #[tool(
        description = "Sort une pull request du brouillon : elle devient prête pour la revue.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn mark_pull_request_ready(&self, Parameters(p): Parameters<NumberParams>) -> ToolResult {
        respond(self.do_mark_ready(p).await)
    }

    #[tool(
        description = "Diff d'une pull request (patchs par fichier) pour la relire : tous les fichiers tronqués à 60 000 caractères, ou un seul avec `file`. Pour le contexte complet, lire le code dans un worktree.",
        annotations(read_only_hint = true)
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
        description = "Publie une revue sur une pull request : APPROVE, REQUEST_CHANGES ou COMMENT, avec une synthèse et des remarques sur des lignes (`comments` : path, line côté nouvelle version, body). GitHub refuse d'approuver sa propre PR : la revue est alors publiée en commentaire et la réponse le signale.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
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
        description = "Fusionne une pull request prête (sortie du brouillon, sans conflit) avec la méthode `method` (squash, merge ou rebase ; absente : réglage du plugin, squash par défaut). Ferme ensuite comme terminées les issues `close_issues` et celles que la PR déclare fermer (« Ferme #12 »), label `status/*` retiré ; `delete_branch` supprime la branche source (jamais la branche par défaut, une branche `release/*` ou celle d'un fork). Jamais sans accord explicite de l'utilisateur.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false)
    )]
    async fn merge_pull_request(&self, Parameters(p): Parameters<MergeParams>) -> ToolResult {
        respond(self.do_merge(p).await)
    }

    #[tool(
        description = "Liste les releases d'un dépôt suivi (publiées et brouillons) : tag, version, état, date, lien.",
        annotations(read_only_hint = true)
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
        description = "Crée la release d'une version avec ses notes markdown, en brouillon par défaut (jamais publiée sans accord). Le tag est le préfixe réglé suivi de la version (v0.1.2) ; GitHub le crée sur `target` (ou la branche par défaut) s'il n'existe pas.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn create_release(&self, Parameters(p): Parameters<CreateReleaseParams>) -> ToolResult {
        respond(self.do_create_release(p).await)
    }

    #[tool(
        description = "Résumé du sprint en cours (sprints automatiques : leur état, durée, capacité, rythme, sprints terminés et livraison ; sinon le milestone daté ouvert le plus proche) ou d'une version donnée : issues par état, burndown jour par jour, rythme, retard sur la droite idéale. Tant que les sprints automatiques ne sont pas démarrés (`started: false`, `project: null`), `start_defaults` donne la durée, la capacité et la version proposées pour `project_start`.",
        annotations(read_only_hint = true)
    )]
    async fn sprint_summary(&self, Parameters(p): Parameters<SprintSummaryParams>) -> ToolResult {
        respond(self.do_sprint_summary(p).await)
    }

    #[tool(
        description = "Démarre les sprints automatiques d'un dépôt : crée l'issue d'état partagée (label cadence/sprints) ou reprend celle des jalons, le premier sprint (milestone daté + branche release/<version>) et le remplit par priorité dans la limite de la capacité. Seulement à la demande explicite de l'utilisateur (durée et capacité confirmées).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
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
        description = "Met en pause les sprints automatiques : plus de remplissage ni de clôture ; à la reprise, l'échéance du sprint en cours est repoussée de la durée de la pause. Seulement à la demande de l'utilisateur.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
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
        description = "Reprend les sprints automatiques mis en pause (échéance du sprint en cours repoussée de la durée de la pause).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
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
        description = "Change la durée des sprints automatiques (en jours : 14 = 2 semaines). `apply: next` (défaut) : à partir du sprint suivant, le sprint en cours ne change pas. `apply: current` : aussi le sprint en cours, dont l'échéance (milestone GitHub) est recalculée et la portée ajustée à la nouvelle capacité (issues ajoutées dans l'ordre de la roadmap puis par priorité, ou issues « à faire » les moins urgentes retirées). Seulement à la demande de l'utilisateur, `current` après sa confirmation explicite.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn project_set_duration(&self, Parameters(p): Parameters<ProjectDurationParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self
                    .set_duration(&repo, p.duration_days, p.apply == DurationApply::Current)
                    .await?;
                Ok(json!({ "repo": repo, "project": project_view(&project) }))
            }
            .await,
        )
    }

    #[tool(
        description = "Clôt le sprint automatique en cours avant son échéance, comme à l'échéance : story points relevés, issues ouvertes et PR reportées au sprint suivant (qui commence aujourd'hui), milestone fermé, branche de release fusionnée dans la branche par défaut quand la CI est verte. Seulement après confirmation explicite de l'utilisateur.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false)
    )]
    async fn project_close_sprint(&self, Parameters(p): Parameters<CloseSprintParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let closed = self
                    .load_project(&repo)
                    .await?
                    .and_then(|p| p.state.current().map(|c| c.version.clone()));
                let project = self
                    .close_sprint_now(&repo, p.version.as_deref(), &p.to_backlog)
                    .await?;
                Ok(json!({ "repo": repo, "closed": closed, "project": project_view(&project) }))
            }
            .await,
        )
    }

    #[tool(
        description = "Fusionne maintenant la branche de release d'un sprint terminé dans la branche par défaut (PR de release), sans attendre qu'une CI s'annonce — pour un dépôt sans CI. Refuse une CI en échec ou en cours et un conflit ; tague ensuite la version. Seulement à la demande de l'utilisateur.",
        meta = ui_only(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false)
    )]
    async fn project_ship_release(&self, Parameters(p): Parameters<ShipReleaseParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                let project = self.ship_release_now(&repo, p.version.trim()).await?;
                let release = project
                    .state
                    .sprints
                    .iter()
                    .find(|s| s.version == p.version.trim())
                    .and_then(|s| s.release.clone());
                Ok(json!({ "repo": repo, "release": release, "project": project_view(&project) }))
            }
            .await,
        )
    }

    #[tool(
        description = "Ajoute des issues ouvertes au sprint automatique en cours (`add` : elles prennent sa version) ou les en retire (`remove` : elles repartent au carnet, sans version). Rend les issues ajoutées, retirées et celles laissées de côté (fermée, introuvable, déjà à sa place).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn sprint_issues(&self, Parameters(p): Parameters<SprintIssuesParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                if p.add.is_empty() && p.remove.is_empty() {
                    bail!("Rien à modifier : précisez `add` ou `remove`.");
                }
                if let Some(n) = p.add.iter().find(|n| p.remove.contains(n)) {
                    bail!("L'issue #{n} est à la fois à ajouter et à retirer.");
                }
                self.move_sprint_issues(&repo, &p.add, &p.remove).await
            }
            .await,
        )
    }

    #[tool(
        description = "Carnet du sprint : issues ouvertes sans version, dans l'ordre où les sprints les prennent (jalons de la roadmap dans leur ordre, puis priorité, puis numéro), chacune avec son jalon et son poids en story points (3 sans estimation).",
        annotations(read_only_hint = true)
    )]
    async fn sprint_backlog(&self, Parameters(p): Parameters<RepoParams>) -> ToolResult {
        respond(
            async {
                let repo = self.repo(&p.repo)?;
                self.read_backlog(&repo).await
            }
            .await,
        )
    }

    #[tool(
        description = "Roadmap d'un dépôt : jalons (nom, objectif, issues, avancement, sprints concernés, date de fin estimée au rythme moyen avec une fourchette au plus tôt / au plus tard), sprints terminés, en cours et prévus, issues ouvertes sans jalon, fin estimée de tout le travail ouvert. Les dates se précisent à chaque sprint.",
        annotations(read_only_hint = true)
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
        description = "Crée ou modifie un jalon de la roadmap (nom clair, objectif, rang). Un jalon regroupe des issues réalisées en un ou plusieurs sprints ; il sert à l'affichage de la roadmap (ni branche ni milestone).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
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

    #[tool(
        description = "Supprime un jalon de la roadmap (ses issues restent, sans jalon).",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true)
    )]
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
        description = "Designs du projet (Claude Design) : nom, lien claude.ai, état (pending = lien seulement, imported = fichiers dans le dépôt sous `path`), branche, fichier d'entrée. À consulter quand l'utilisateur parle d'un design ou d'un écran à réaliser.",
        annotations(read_only_hint = true)
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
        description = "Lit un design importé : liste de ses fichiers dans le dépôt et contenu d'un fichier (le fichier d'entrée par défaut, tronqué à 60 000 caractères : lire le reste dans un worktree, sous `path`).",
        annotations(read_only_hint = true)
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
        description = "Ajoute un design au projet à partir de son lien claude.ai (état « pending » : fichiers à importer ensuite, comme le fait le skill « Importer un design »). Rend son identifiant.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
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
        description = "Met à jour un design : nom, description, et après import (fichiers commités et poussés) `imported: true` avec la branche (`ref`), le dossier (`path`) et le fichier d'entrée (`entry`).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
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
        meta = ui_only(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true)
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
        description = "Planning (Gantt) du dépôt : personnes, phases (étude, développement, recette…), tâches avec dates, personnes affectées, dépendances, avancement, jalons-dates. Rend aussi `revision`, à repasser à planning_save.",
        annotations(read_only_hint = true)
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
        description = "Enregistre le planning (Gantt) complet du dépôt, qui remplace le précédent. Vérifie dates (AAAA-MM-JJ, fin ≥ début), personnes, dépendances (sans boucle) ; refuse si `base_revision` n'est plus la révision courante. Un skill ne l'appelle qu'après accord explicite de l'utilisateur sur le planning proposé.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false)
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
        description = "Architecture du projet, à suivre en codant : services (proxy, front, back, base…) et leurs liens, puis pour chaque service ses couches (controller, service, DTO, repository…), les couches que chacune peut utiliser, ses règles et conventions. Lue dans `architecture/architecture.json` (branche de la PR d'architecture ouverte, sinon la base) ; aussi lisible en Markdown dans `architecture/ARCHITECTURE.md` du worktree.",
        annotations(read_only_hint = true)
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
        description = "Modèles d'architecture prêts à appliquer : systèmes complets (web classique, API + cache + tâches, microservices) et intérieurs de service (API REST en couches, hexagonale, NestJS, Spring Boot, Express, FastAPI, Django, React par fonctionnalités, Next.js, Tauri).",
        annotations(read_only_hint = true)
    )]
    async fn architecture_templates(&self, Parameters(_): Parameters<Empty>) -> ToolResult {
        respond(Ok(json!({ "templates": crate::architecture::templates() })))
    }

    #[tool(
        description = "Enregistre l'architecture complète du dépôt : commit de architecture/architecture.json et du ARCHITECTURE.md généré sur une branche archi/… et pull request (réutilisée tant qu'elle est ouverte). Vérifie identifiants, natures de service, liens et couches. Une IA ne l'appelle qu'après accord explicite de l'utilisateur.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
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
        description = "Range des issues dans un jalon (une issue n'appartient qu'à un jalon : elle quitte le précédent) ou les en retire.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
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

    /// Appel d'outil (routeur des `#[tool]`), puis, après une écriture réussie sur un dépôt,
    /// l'événement `sync.updated` (`{ repo, tool }`) pour les écrans du plugin : l'écran Sprint se
    /// met à jour quand l'IA passe une issue en revue ou fusionne une PR (N09).
    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: rmcp::service::RequestContext<RoleServer>,
    ) -> Result<rmcp::model::CallToolResponse, McpError> {
        let tool = request.name.to_string();
        let repo = request
            .arguments
            .as_ref()
            .and_then(|a| a.get("repo"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let peer = context.peer.clone();
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        let response = self.tool_router.call(tcc).await?;
        let ok = match &response {
            rmcp::model::CallToolResponse::Complete(r) => r.is_error != Some(true),
            _ => false,
        };
        if ok
            && WRITE_TOOLS.contains(&tool.as_str())
            && let Some(repo) = repo.and_then(|r| self.repo(&r).ok())
        {
            let params = json!({ "event": SYNC_EVENT, "data": { "repo": repo, "tool": tool } });
            let notification = rmcp::model::ServerNotification::CustomNotification(CustomNotification::new(
                EVENT_NOTIFICATION,
                Some(params),
            ));
            if let Err(err) = peer.send_notification(notification).await {
                tracing::debug!(tool, "événement {SYNC_EVENT} non envoyé : {err}");
            }
        }
        Ok(response)
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
            "update_pull_request",
            "mark_pull_request_ready",
            "list_releases",
            "create_release",
            "sprint_summary",
            "project_start",
            "project_pause",
            "project_resume",
            "project_set_duration",
            "project_close_sprint",
            "project_ship_release",
            "sprint_issues",
            "sprint_backlog",
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

    /// R01 : Cadence ne demande pas d'accord en mode « Demander » pour un outil déclaré en lecture
    /// seule. Chaque outil annonce donc `readOnlyHint` ; une écriture annonce aussi
    /// `destructiveHint` et `idempotentHint`.
    #[test]
    fn annotates_every_tool() {
        let tools = server(&[]).tool_router.list_all();
        assert!(tools.len() >= 44);
        for tool in &tools {
            let name = tool.name.as_ref();
            let a = tool
                .annotations
                .as_ref()
                .unwrap_or_else(|| panic!("{name} : annotations absentes"));
            let read_only = a
                .read_only_hint
                .unwrap_or_else(|| panic!("{name} : readOnlyHint absent"));
            // Les outils qui écrivent sur un dépôt (événement `sync.updated`) ne sont jamais en lecture seule.
            if WRITE_TOOLS.contains(&name) {
                assert!(!read_only, "{name} écrit sur le dépôt");
            }
            if read_only {
                assert!(
                    name.starts_with("get_")
                        || name.starts_with("list_")
                        || name.ends_with("_get")
                        || matches!(
                            name,
                            "sprint_summary" | "sprint_backlog" | "roadmap" | "architecture_templates"
                        ),
                    "{name} déclaré en lecture seule"
                );
            } else {
                assert!(a.destructive_hint.is_some(), "{name} : destructiveHint absent");
                assert!(a.idempotent_hint.is_some(), "{name} : idempotentHint absent");
            }
            // Le champ arrive à l'hôte sous son nom MCP.
            let wire = serde_json::to_value(tool).unwrap();
            assert_eq!(wire["annotations"]["readOnlyHint"], json!(read_only), "{name}");
        }
        let hint = |name: &str| {
            let t = tools.iter().find(|t| t.name == name).unwrap();
            t.annotations.clone().unwrap()
        };
        // Les lectures de la recette (cartes d'accord à tort en « Demander »).
        for name in [
            "get_repository",
            "sprint_summary",
            "get_issue",
            "list_pull_requests",
            "architecture_get",
            "get_pull_request",
            "get_pull_request_diff",
            "sprint_backlog",
            "roadmap",
            "planning_get",
            "architecture_templates",
        ] {
            assert_eq!(hint(name).read_only_hint, Some(true), "{name}");
        }
        for name in [
            "merge_pull_request",
            "jalon_delete",
            "design_delete",
            "update_issue",
            "update_milestone",
            "project_close_sprint",
            "project_ship_release",
        ] {
            assert_eq!(hint(name).destructive_hint, Some(true), "{name}");
        }
        for name in [
            "create_issue",
            "add_comment",
            "create_pull_request",
            "review_pull_request",
        ] {
            assert_eq!(hint(name).destructive_hint, Some(false), "{name}");
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
                apply: DurationApply::Next,
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

    /* ---------- Sprints automatiques sur un faux GitHub ---------- */

    const CRM: &str = "Remisdv/Go-Alternance-CRM-POC";

    /// Dépôt réel Remisdv/Go-Alternance-CRM-POC : 23 issues sans version (V1 et V2), une PR, et
    /// l'issue d'état #24 « idle » créée par les jalons de la roadmap, sprints jamais démarrés.
    async fn crm() -> (GestionProjet, Arc<Mutex<crate::fake_github::Repo>>) {
        let mut issues: Vec<Value> =
            serde_json::from_str(include_str!("../fixtures/go-alternance-crm-poc/issues.json")).unwrap();
        for i in &mut issues {
            if i["number"] == 24 {
                i["body"] = json!(include_str!("../fixtures/go-alternance-crm-poc/issue-24.md"));
            }
        }
        let (url, fake) = crate::fake_github::start(crate::fake_github::Repo::new(CRM, issues)).await;
        let env = Env {
            token: Some("test".into()),
            repos: vec![CRM.into()],
            settings: Settings::default(),
            api_url: url,
        };
        (GestionProjet::new(&env).unwrap(), fake)
    }

    fn data(r: &CallToolResult) -> Value {
        assert_ne!(r.is_error, Some(true), "{}", text(r));
        r.structured_content.clone().expect("résultat structuré")
    }

    async fn summary(s: &GestionProjet) -> Value {
        data(
            &s.sprint_summary(Parameters(SprintSummaryParams {
                repo: CRM.into(),
                version: None,
            }))
            .await
            .unwrap(),
        )
    }

    fn sprint_issues(fake: &Mutex<crate::fake_github::Repo>, version: &str) -> Vec<u64> {
        let f = fake.lock().unwrap();
        let mut out: Vec<u64> = f
            .issues
            .iter()
            .filter(|i| i["milestone"]["title"] == version)
            .filter_map(|i| i["number"].as_u64())
            .collect();
        out.sort();
        out
    }

    fn labels_of(fake: &Mutex<crate::fake_github::Repo>, number: u64) -> Vec<String> {
        let f = fake.lock().unwrap();
        f.issue(number).unwrap()["labels"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|l| l["name"].as_str().map(str::to_string))
            .collect()
    }

    fn review(number: u32, event: ReviewEvent, body: &str) -> Parameters<ReviewParams> {
        Parameters(ReviewParams {
            repo: CRM.into(),
            number,
            event,
            body: body.into(),
            comments: vec![],
        })
    }

    fn merge(
        number: u32,
        method: Option<MergeMethod>,
        delete_branch: bool,
        close_issues: Vec<u32>,
    ) -> Parameters<MergeParams> {
        Parameters(MergeParams {
            repo: CRM.into(),
            number,
            method,
            delete_branch,
            close_issues,
        })
    }

    /// « Relire et valider » : revue de chaque PR, puis fusion des validées (squash par défaut),
    /// issues fermées comme terminées, branche supprimée ; changements demandés sur les autres.
    #[tokio::test]
    async fn reviews_then_merges_validated_tasks() {
        let (s, fake) = crm().await;
        {
            let mut f = fake.lock().unwrap();
            f.branches.insert("release/0.1.0".into(), "r010".into());
            f.add_pull(
                30,
                "chore/1-socle",
                "release/0.1.0",
                "Socle du projet.\n\nFerme #1",
                "dev",
            );
            f.add_pull(31, "feat/2-fiches", "release/0.1.0", "Ferme #2", "cadence-bot");
            f.add_pull(32, "release/0.1.0", "main", "Livraison du sprint 0.1.0", "dev");
            f.add_pull(33, "feat/4-relances", "release/0.1.0", "Ferme #4", "dev");
            f.pulls.last_mut().unwrap()["draft"] = json!(true);
            for n in [1, 2, 3] {
                let issue = f.issues.iter_mut().find(|i| i["number"] == n).unwrap();
                issue["labels"] = json!([{ "name": "type/feat" }, { "name": "status/review" }]);
            }
        }

        // Verdicts : approbation, et changements demandés sur une PR du compte connecté (GitHub
        // refuse : publiés en commentaire).
        let approved = data(
            &s.review_pull_request(review(30, ReviewEvent::Approve, "✅ Critères remplis."))
                .await
                .unwrap(),
        );
        assert_eq!(approved["event"], "APPROVE");
        let refused = data(
            &s.review_pull_request(review(31, ReviewEvent::RequestChanges, "❌ Test manquant."))
                .await
                .unwrap(),
        );
        assert_eq!(refused["event"], "COMMENT", "{refused}");
        assert!(refused["note"].as_str().unwrap().contains("même compte"));
        let empty = s
            .review_pull_request(review(30, ReviewEvent::Comment, "  "))
            .await
            .unwrap();
        assert!(text(&empty).contains("sans synthèse"), "{}", text(&empty));
        {
            let f = fake.lock().unwrap();
            let events: Vec<&str> = f.reviews.iter().filter_map(|r| r["event"].as_str()).collect();
            assert_eq!(events, ["APPROVE", "COMMENT"]);
            assert!(
                f.reviews[1]["body"]
                    .as_str()
                    .unwrap()
                    .starts_with("**✋ Changements demandés**")
            );
        }

        // Fusion de la validée : squash (réglage par défaut), branche supprimée, issue déclarée
        // (#1) et issue de la tâche (#3) fermées comme terminées, sans label status/*.
        let merged = data(
            &s.merge_pull_request(merge(30, None, true, vec![3]))
                .await
                .unwrap(),
        );
        assert_eq!(
            (
                &merged["method"],
                &merged["base"],
                &merged["closed_issues"],
                &merged["branch_deleted"]
            ),
            (
                &json!("squash"),
                &json!("release/0.1.0"),
                &json!([3, 1]),
                &json!(true)
            ),
            "{merged}"
        );
        assert!(merged.get("errors").is_none(), "{merged}");
        {
            let f = fake.lock().unwrap();
            assert_eq!(f.pull(30).unwrap()["merge_method"], "squash");
            assert!(!f.branches.contains_key("chore/1-socle"));
            assert!(f.branches.contains_key("release/0.1.0"));
            for n in [1, 3] {
                let issue = f.issue(n).unwrap();
                assert_eq!(
                    (&issue["state"], &issue["state_reason"]),
                    (&json!("closed"), &json!("completed"))
                );
            }
            assert!(
                f.requests
                    .contains(&format!("DELETE /repos/{CRM}/git/refs/heads/chore/1-socle"))
            );
        }
        assert_eq!(labels_of(&fake, 1), ["type/feat"]);
        let issue = data(
            &s.get_issue(Parameters(GetIssueParams {
                repo: CRM.into(),
                number: 1,
                comments: Some(false),
            }))
            .await
            .unwrap(),
        );
        assert_eq!(issue["status"], "done");

        // Déjà fusionnée, brouillon : refusés sans rien changer.
        let again = s.merge_pull_request(merge(30, None, true, vec![])).await.unwrap();
        assert!(text(&again).contains("déjà fusionnée"), "{}", text(&again));
        let draft = s
            .merge_pull_request(merge(33, None, false, vec![]))
            .await
            .unwrap();
        assert!(text(&draft).contains("brouillon"), "{}", text(&draft));

        // Méthode du réglage (rebase) ; une branche de release n'est jamais supprimée.
        assert!(s.apply_notification(
            SETTINGS_NOTIFICATION,
            Some(&json!({ "settings": { "merge_method": "rebase" } }))
        ));
        let release = data(&s.merge_pull_request(merge(32, None, true, vec![])).await.unwrap());
        assert_eq!(
            (&release["method"], &release["branch_deleted"]),
            (&json!("rebase"), &json!(false))
        );
        assert!(release["note"].as_str().unwrap().contains("gardée"), "{release}");
        assert!(fake.lock().unwrap().branches.contains_key("release/0.1.0"));
        // Méthode explicite : prioritaire sur le réglage.
        fake.lock()
            .unwrap()
            .add_pull(34, "fix/5-doublons", "release/0.1.0", "", "dev");
        let explicit = data(
            &s.merge_pull_request(merge(34, Some(MergeMethod::Merge), false, vec![99]))
                .await
                .unwrap(),
        );
        assert_eq!(explicit["method"], "merge");
        // Issue introuvable : la fusion reste faite, l'erreur est rendue.
        assert_eq!(explicit["errors"][0]["issue"], 99, "{explicit}");
        assert_eq!(explicit["closed_issues"], json!([]));

        // Fermer une issue retire son label status/* : elle passe « terminé ».
        data(
            &s.update_issue(Parameters(UpdateIssueParams {
                repo: CRM.into(),
                number: 2,
                title: None,
                body: None,
                state: Some(IssueState::Closed),
                state_reason: Some(StateReason::Completed),
                status: None,
                points: None,
                priority: None,
                labels: None,
                add_labels: vec![],
                remove_labels: vec![],
                milestone: None,
                assignees: None,
            }))
            .await
            .unwrap(),
        );
        assert_eq!(labels_of(&fake, 2), ["type/feat"]);
        assert_eq!(fake.lock().unwrap().issue(2).unwrap()["state"], "closed");
    }

    #[tokio::test]
    async fn starts_one_day_sprints_from_an_idle_state_issue() {
        let (s, fake) = crm().await;

        // Avant : l'issue d'état ne porte que les jalons. Pas de projet affiché (l'écran Sprint
        // propose « Démarrer le projet »), durée proposée = celle de l'issue d'état (7 jours).
        let before = summary(&s).await;
        assert_eq!(before["started"], false, "{before}");
        assert!(before["project"].is_null(), "{before}");
        assert_eq!(
            before["start_defaults"],
            json!({ "duration_days": 7, "capacity": 10, "first_version": "0.1.0" })
        );
        assert_eq!(before["state_issue"]["number"], 24);
        assert!(before["sprint"].is_null());
        assert!(before["message"].as_str().unwrap().contains("Démarrer le projet"));
        let repo = data(
            &s.get_repository(Parameters(RepoParams { repo: CRM.into() }))
                .await
                .unwrap(),
        );
        assert_eq!(repo["sprints"]["started"], false);
        // Les issues du dépôt sont bien listées (ni l'issue d'état, ni la PR).
        let list = data(
            &s.list_issues(Parameters(ListIssuesParams {
                repo: Some(CRM.into()),
                per_page: Some(100),
                ..Default::default()
            }))
            .await
            .unwrap(),
        );
        assert_eq!(list["issues"].as_array().unwrap().len(), 23);

        // Démarrage avec des sprints d'un jour.
        let started = data(
            &s.project_start(Parameters(ProjectStartParams {
                repo: CRM.into(),
                duration_days: 1,
                capacity: 1,
                first_version: None,
            }))
            .await
            .unwrap(),
        );
        let today = sprint::today();
        let project = &started["project"];
        assert_eq!(
            (
                &project["status"],
                &project["issue"],
                &project["current"],
                &project["release_branch"]
            ),
            (
                &json!("running"),
                &json!(24),
                &json!("0.1.0"),
                &json!("release/0.1.0")
            )
        );
        {
            let f = fake.lock().unwrap();
            // L'issue d'état #24 est reprise (aucune nouvelle issue), ses jalons gardés.
            assert!(!f.requests.contains(&format!("POST /repos/{CRM}/issues")));
            let state = projet::parse_body(f.issue(24).unwrap()["body"].as_str().unwrap()).unwrap();
            assert!(state.started());
            assert_eq!((state.duration_days, state.jalons.len()), (1, 2));
            let first = &state.sprints[0];
            assert_eq!(
                (first.start_on.as_str(), first.due_on.as_str()),
                (today.as_str(), today.as_str())
            );
            assert_eq!(f.milestones.len(), 1);
            assert_eq!(f.milestones[0]["due_on"], json!(format!("{today}T12:00:00Z")));
            assert!(f.branches.contains_key("release/0.1.0"));
        }
        // Remplissage : #1 (socle), même plus grosse que la capacité d'un jour.
        assert_eq!(sprint_issues(&fake, "0.1.0"), [1]);

        // Après : le sprint d'un jour et ses issues s'affichent.
        let after = summary(&s).await;
        assert_eq!(after["started"], true);
        assert!(after.get("start_defaults").is_none());
        assert_eq!(after["project"]["duration_days"], 1);
        assert_eq!(after["sprint"]["title"], "0.1.0");
        let numbers: Vec<u64> = after["issues"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["number"].as_u64())
            .collect();
        assert_eq!(numbers, [1]);
        let pace = &after["pace"];
        assert_eq!((&pace["length_days"], &pace["days_left"]), (&json!(1), &json!(0)));
        assert_eq!(pace["burndown"].as_array().unwrap().len(), 2);

        // Deux jours : l'échéance passe à demain, le sprint garde son issue (au moins une).
        let longer = data(
            &s.project_set_duration(Parameters(ProjectDurationParams {
                repo: CRM.into(),
                duration_days: 2,
                apply: DurationApply::Current,
            }))
            .await
            .unwrap(),
        );
        assert_eq!(longer["project"]["duration_days"], 2);
        let tomorrow = sprint::add_days(&today, 1).unwrap();
        assert_eq!(
            fake.lock().unwrap().milestones[0]["due_on"],
            json!(format!("{tomorrow}T12:00:00Z"))
        );
        assert_eq!(sprint_issues(&fake, "0.1.0"), [1]);

        // Déjà démarrés : un second démarrage est refusé.
        let again = s
            .project_start(Parameters(ProjectStartParams {
                repo: CRM.into(),
                duration_days: 7,
                capacity: 10,
                first_version: None,
            }))
            .await
            .unwrap();
        assert!(text(&again).contains("déjà démarrés"), "{}", text(&again));
    }

    /// Constat P15 : les PR de sprint visent `release/x`, pour lesquelles GitHub ne relie pas
    /// « Closes #n » ; la liste les relie quand même à leur issue (corps, branche, liens manuels).
    #[tokio::test]
    async fn links_sprint_pull_requests_to_their_issues() {
        let (s, fake) = crm().await;
        {
            let mut f = fake.lock().unwrap();
            f.add_pull(
                18,
                "feat/2-fiches",
                "release/0.1.0",
                "Fiches.\n\nCloses #2",
                "dev",
            );
            f.add_pull(19, "feat/3-import", "release/0.1.0", "Dépend de #2.", "dev");
            f.add_pull(20, "chore/1-socle", "main", "Ferme #1", "dev");
            f.add_pull(21, "wip", "release/0.1.0", "", "dev");
            f.pulls.last_mut().unwrap()["links"] =
                json!([{ "__typename": "ConnectedEvent", "subject": { "number": 5 }, "source": {} }]);
        }
        let list = data(
            &s.list_pull_requests(Parameters(ListPullRequestsParams {
                repo: Some(CRM.into()),
                state: StateFilter::Open,
            }))
            .await
            .unwrap(),
        );
        let links: Vec<(u64, Value, Value)> = list["pull_requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["number"].as_u64().unwrap(),
                    p["closes"].clone(),
                    p["issues"].clone(),
                )
            })
            .collect();
        assert_eq!(
            links,
            [
                (18, json!([2]), json!([2])),
                (19, json!([]), json!([3])),
                (20, json!([1]), json!([1])),
                (21, json!([5]), json!([5])),
            ]
        );
    }

    /// Écran Sprint : carnet dans l'ordre de la roadmap, ajout et retrait d'issues, durée
    /// appliquée au sprint suivant sans toucher l'échéance (P09), clôture anticipée.
    #[tokio::test]
    async fn manages_the_current_sprint_from_the_screen() {
        let (s, fake) = crm().await;
        data(
            &s.project_start(Parameters(ProjectStartParams {
                repo: CRM.into(),
                duration_days: 7,
                capacity: 10,
                first_version: None,
            }))
            .await
            .unwrap(),
        );
        assert_eq!(sprint_issues(&fake, "0.1.0"), [1]);
        let today = sprint::today();
        let due = format!("{}T12:00:00Z", sprint::add_days(&today, 6).unwrap());
        assert_eq!(fake.lock().unwrap().milestones[0]["due_on"], json!(due));

        // Carnet : jalon V1 d'abord (par priorité), puis V2 ; poids en SP.
        let backlog = data(
            &s.sprint_backlog(Parameters(RepoParams { repo: CRM.into() }))
                .await
                .unwrap(),
        );
        let items = backlog["issues"].as_array().unwrap();
        let numbers: Vec<u64> = items.iter().filter_map(|i| i["number"].as_u64()).collect();
        assert_eq!(numbers.len(), 22);
        assert_eq!(&numbers[..3], [2, 3, 4]);
        assert_eq!(&numbers[19..], [21, 22, 23]);
        assert_eq!(items[0]["jalon"]["id"], "v1-crm-ecoles");
        assert_eq!(items[21]["jalon"]["id"], "v2-automatisation-commerciale");
        assert_eq!((&items[0]["weight"], items[0].get("body")), (&json!(8), None));

        // Ajout et retrait (P11) ; une issue inconnue est signalée sans bloquer.
        let moved = data(
            &s.sprint_issues(Parameters(SprintIssuesParams {
                repo: CRM.into(),
                add: vec![4, 999],
                remove: vec![1],
            }))
            .await
            .unwrap(),
        );
        assert_eq!((&moved["added"], &moved["removed"]), (&json!([4]), &json!([1])));
        assert_eq!(moved["skipped"][0]["issue"], 999, "{moved}");
        assert_eq!(sprint_issues(&fake, "0.1.0"), [4]);
        let again = data(
            &s.sprint_issues(Parameters(SprintIssuesParams {
                repo: CRM.into(),
                add: vec![4],
                remove: vec![],
            }))
            .await
            .unwrap(),
        );
        assert_eq!(again["skipped"][0]["reason"], "déjà dans le sprint");

        // Durée d'un jour, au sprint suivant : l'échéance du sprint en cours ne bouge pas.
        let next = data(
            &s.project_set_duration(Parameters(ProjectDurationParams {
                repo: CRM.into(),
                duration_days: 1,
                apply: DurationApply::Next,
            }))
            .await
            .unwrap(),
        );
        assert_eq!(next["project"]["duration_days"], 1);
        assert_eq!(next["project"]["capacity"], 10);
        assert_eq!(next["project"]["next_capacity"], 1);
        assert_eq!(fake.lock().unwrap().milestones[0]["due_on"], json!(due));
        assert_eq!(sprint_issues(&fake, "0.1.0"), [4]);

        // Clôture anticipée : refusée si le sprint vu n'est plus le sprint en cours.
        let stale = s
            .project_close_sprint(Parameters(CloseSprintParams {
                repo: CRM.into(),
                to_backlog: vec![],
                version: Some("0.9.0".into()),
            }))
            .await
            .unwrap();
        assert!(text(&stale).contains("rafraîchissez"), "{}", text(&stale));
        let closed = data(
            &s.project_close_sprint(Parameters(CloseSprintParams {
                repo: CRM.into(),
                to_backlog: vec![],
                version: Some("0.1.0".into()),
            }))
            .await
            .unwrap(),
        );
        assert_eq!(
            (&closed["closed"], &closed["project"]["current"]),
            (&json!("0.1.0"), &json!("0.2.0"))
        );
        {
            let f = fake.lock().unwrap();
            assert_eq!(f.milestones[0]["state"], "closed");
            let state = projet::parse_body(f.issue(24).unwrap()["body"].as_str().unwrap()).unwrap();
            let (old, cur) = (&state.sprints[0], &state.sprints[1]);
            assert_eq!(old.ended_on.as_deref(), Some(today.as_str()));
            assert_eq!(
                (cur.start_on.as_str(), cur.due_on.as_str()),
                (today.as_str(), today.as_str())
            );
            assert_eq!(cur.carried, [4]);
            assert!(f.branches.contains_key("release/0.2.0"));
        }
        // L'issue ouverte passe au sprint suivant.
        assert_eq!(sprint_issues(&fake, "0.2.0"), [4]);
        assert_eq!(summary(&s).await["sprint"]["title"], "0.2.0");
    }

    /// Démarre des sprints d'un jour de capacité `capacity` (sprint 0.1.0 avec l'issue #1).
    async fn start_one_day(s: &GestionProjet, capacity: u32) {
        data(
            &s.project_start(Parameters(ProjectStartParams {
                repo: CRM.into(),
                duration_days: 1,
                capacity,
                first_version: None,
            }))
            .await
            .unwrap(),
        );
    }

    /// N07 : `get_repository` et `sprint_summary` donnent la durée réelle des sprints automatiques
    /// (issue d'état), pas le réglage par défaut du plugin (14 jours).
    #[tokio::test]
    async fn reports_the_real_sprint_length() {
        let (s, _fake) = crm().await;
        start_one_day(&s, 1).await;
        let repo = data(
            &s.get_repository(Parameters(RepoParams { repo: CRM.into() }))
                .await
                .unwrap(),
        );
        assert_eq!(repo["sprint_length_days"], 1, "{repo}");
        assert_eq!(repo["sprints"]["duration_days"], 1);
        assert_eq!(repo["sprints"]["release_branch"], "release/0.1.0");
        let sum = summary(&s).await;
        assert_eq!(sum["sprint_length_days"], 1);
        assert_eq!(sum["pace"]["length_days"], 1, "{}", sum["pace"]);
    }

    /// N08 : juste après un ajout ou un retrait, les listes de GitHub ont quelques secondes de
    /// retard ; le résumé du sprint et le carnet suivent quand même l'écriture.
    #[tokio::test]
    async fn sprint_and_backlog_follow_moves_despite_stale_listings() {
        let (s, fake) = crm().await;
        start_one_day(&s, 10).await;
        let before: Vec<u64> = summary(&s).await["issues"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["number"].as_u64())
            .collect();
        assert!(before.contains(&1) && !before.contains(&20), "{before:?}");

        fake.lock().unwrap().listing_lag = true;
        let moved = data(
            &s.sprint_issues(Parameters(SprintIssuesParams {
                repo: CRM.into(),
                add: vec![20],
                remove: vec![1],
            }))
            .await
            .unwrap(),
        );
        assert_eq!((&moved["added"], &moved["removed"]), (&json!([20]), &json!([1])));
        // Le faux GitHub liste encore l'ancien état…
        assert!(
            fake.lock().unwrap().listed("milestone=1").contains(&1),
            "le faux GitHub devrait être en retard"
        );
        // … mais le sprint et le carnet suivent l'écriture.
        let after: Vec<u64> = summary(&s).await["issues"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["number"].as_u64())
            .collect();
        assert!(after.contains(&20) && !after.contains(&1), "{after:?}");
        let backlog: Vec<u64> = data(
            &s.sprint_backlog(Parameters(RepoParams { repo: CRM.into() }))
                .await
                .unwrap(),
        )["issues"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["number"].as_u64())
            .collect();
        assert!(backlog.contains(&1) && !backlog.contains(&20), "{backlog:?}");
    }

    /// N11 : une PR d'issue ne vise jamais la branche d'une autre PR ; une PR déjà empilée est
    /// repointée vers la release avant la suppression de la branche fusionnée (GitHub la
    /// fermerait), et `update_pull_request` repointe une base.
    #[tokio::test]
    async fn never_stacks_sprint_pull_requests() {
        let (s, fake) = crm().await;
        start_one_day(&s, 10).await;
        {
            let mut f = fake.lock().unwrap();
            f.add_pull(30, "feat/20-heure", "release/0.1.0", "Ferme #20", "dev");
            f.branches.insert("feat/21-majuscules".into(), "sha-21".into());
            f.branches.insert("feat/22-autre".into(), "sha-22".into());
        }
        let create = |head: &str, base: &str| {
            Parameters(CreatePullRequestParams {
                repo: CRM.into(),
                title: format!("PR {head}"),
                head: head.into(),
                base: Some(base.into()),
                body: Some("Ferme #21".into()),
                draft: Some(true),
            })
        };
        // Base = branche de #30 : refusé, avec la branche de release à viser.
        let stacked = s
            .create_pull_request(create("feat/21-majuscules", "feat/20-heure"))
            .await
            .unwrap();
        assert_eq!(stacked.is_error, Some(true));
        assert!(
            text(&stacked).contains("#30") && text(&stacked).contains("release/0.1.0"),
            "{}",
            text(&stacked)
        );
        // Sprints démarrés : une base quelconque (ni release ni défaut) est refusée aussi.
        let odd = s
            .create_pull_request(create("feat/21-majuscules", "feat/22-autre"))
            .await
            .unwrap();
        assert!(text(&odd).contains("sprints automatiques"), "{}", text(&odd));
        let ok = data(
            &s.create_pull_request(create("feat/21-majuscules", "release/0.1.0"))
                .await
                .unwrap(),
        );
        let n = ok["number"].as_u64().unwrap() as u32;
        assert_eq!(ok["base"], "release/0.1.0", "{ok}");

        // Une PR empilée malgré tout (créée hors de Cadence) : repointée puis fusion sans perte.
        fake.lock()
            .unwrap()
            .add_pull(40, "feat/22-autre", "feat/20-heure", "Ferme #22", "dev");
        let refused = s
            .update_pull_request(Parameters(UpdatePullRequestParams {
                repo: CRM.into(),
                number: n,
                base: Some("feat/22-autre".into()),
                title: None,
                body: None,
            }))
            .await
            .unwrap();
        assert!(text(&refused).contains("#40"), "{}", text(&refused));
        let merged = data(&s.merge_pull_request(merge(30, None, true, vec![])).await.unwrap());
        assert_eq!(merged["retargeted"], json!([40]), "{merged}");
        assert_eq!(merged["branch_deleted"], true);
        {
            let f = fake.lock().unwrap();
            let pr = f.pull(40).unwrap();
            assert_eq!(
                (&pr["state"], &pr["base"]["ref"]),
                (&json!("open"), &json!("release/0.1.0"))
            );
        }
        let renamed = data(
            &s.update_pull_request(Parameters(UpdatePullRequestParams {
                repo: CRM.into(),
                number: 40,
                base: Some("release/0.1.0".into()),
                title: Some("feat(#22) : autre".into()),
                body: None,
            }))
            .await
            .unwrap(),
        );
        assert_eq!(renamed["title"], "feat(#22) : autre");
    }

    /// N13 / N14 : clôture avec l'excédent rendu au carnet, portée relevée (« fait / portée »),
    /// numéro de milestone des sprints terminés (conversations), release fusionnée tout de suite
    /// sur un dépôt sans CI ; avec des workflows, attente puis « Fusionner maintenant ».
    #[tokio::test]
    async fn closes_a_sprint_and_ships_without_ci() {
        for workflows in [0, 1] {
            let (s, fake) = crm().await;
            start_one_day(&s, 1).await;
            data(
                &s.sprint_issues(Parameters(SprintIssuesParams {
                    repo: CRM.into(),
                    add: vec![2, 3],
                    remove: vec![],
                }))
                .await
                .unwrap(),
            );
            {
                let mut f = fake.lock().unwrap();
                f.workflows = workflows;
                // Du travail livré sur la release, et #1 fermée.
                f.branches.insert("release/0.1.0".into(), "travail".into());
                let one = f.issues.iter_mut().find(|i| i["number"] == 1).unwrap();
                one["state"] = json!("closed");
                // Fermée sur GitHub après le remplissage : la liste, plus récente, fait foi.
                one["updated_at"] = json!("2026-10-21T08:00:00Z");
            }
            let closed = data(
                &s.project_close_sprint(Parameters(CloseSprintParams {
                    repo: CRM.into(),
                    version: Some("0.1.0".into()),
                    to_backlog: vec![3],
                }))
                .await
                .unwrap(),
            );
            assert_eq!(closed["project"]["current"], "0.2.0", "{closed}");
            assert_eq!(sprint_issues(&fake, "0.2.0"), [2]);
            assert!(fake.lock().unwrap().issue(3).unwrap()["milestone"].is_null());
            let state = {
                let f = fake.lock().unwrap();
                projet::parse_body(f.issue(24).unwrap()["body"].as_str().unwrap()).unwrap()
            };
            let old = &state.sprints[0];
            assert_eq!(old.carried, Vec::<u32>::new());
            assert_eq!(state.sprints[1].carried, [2]);
            let one = projet::weight(&model::issue_from(fake.lock().unwrap().issue(1).unwrap(), false));
            assert_eq!(old.done_points, Some(one));
            assert!(old.scope_points.unwrap() > one, "{old:?}");

            let sum = summary(&s).await;
            let ended = sum["project"]["sprints"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["version"] == "0.1.0")
                .unwrap()
                .clone();
            assert_eq!(ended["milestone"], 1, "{ended}");
            let release = &ended["release"];
            if workflows == 0 {
                assert_eq!(release["status"], "merged", "{release}");
                assert_eq!(release["tag"], "v0.1.0");
            } else {
                assert_eq!(release["status"], "pending", "{release}");
                assert_eq!(release["no_ci"], true);
                let shipped = data(
                    &s.project_ship_release(Parameters(ShipReleaseParams {
                        repo: CRM.into(),
                        version: "0.1.0".into(),
                    }))
                    .await
                    .unwrap(),
                );
                assert_eq!(shipped["release"]["status"], "merged", "{shipped}");
            }
        }
    }
}

#[cfg(test)]
mod events {
    use super::*;
    use rmcp::ServiceExt;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// Session MCP en mémoire, côté Cadence : envoie chaque message (une ligne JSON-RPC), attend
    /// la réponse des requêtes et rend tout ce que le serveur a écrit.
    async fn session(server: GestionProjet, messages: &[Value]) -> Vec<Value> {
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
            write.write_all(format!("{message}\n").as_bytes()).await.unwrap();
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

    /// N09 : une écriture réussie (ici par l'IA) prévient les écrans (`sync.updated`) ; ni une
    /// lecture ni une écriture refusée.
    #[tokio::test]
    async fn notifies_screens_after_each_write() {
        const REPO: &str = "me/app";
        let issues = vec![
            json!({ "number": 1, "title": "Une issue", "state": "open", "labels": [], "milestone": null }),
        ];
        let (url, _fake) = crate::fake_github::start(crate::fake_github::Repo::new(REPO, issues)).await;
        let env = Env {
            token: Some("test".into()),
            repos: vec![REPO.into()],
            settings: Settings::default(),
            api_url: url,
        };
        let out = session(
            GestionProjet::new(&env).unwrap(),
            &[
                call(1, "list_issues", json!({ "repo": REPO })),
                call(
                    2,
                    "update_issue",
                    json!({ "repo": "ME/App", "number": 1, "add_labels": ["area/api"] }),
                ),
                call(
                    3,
                    "update_issue",
                    json!({ "repo": REPO, "number": 99, "add_labels": ["x"] }),
                ),
            ],
        )
        .await;
        let events: Vec<&Value> = out
            .iter()
            .filter(|m| m["method"] == EVENT_NOTIFICATION)
            .map(|m| &m["params"])
            .collect();
        assert_eq!(
            events,
            [&json!({ "event": SYNC_EVENT, "data": { "repo": REPO, "tool": "update_issue" } })],
            "{out:#?}"
        );
    }
}
