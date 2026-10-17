//! Outils MCP du plugin Exemple et notifications échangées avec Cadence.
//!
//! - `incrementer` : visible partout. Les IA le voient sous `exemple__incrementer` et l'écran
//!   l'appelle avec `cadence.call("incrementer")`. Il émet l'événement `compteur`.
//! - `etat` : réservé à l'écran (`_meta["cadence/visibility"] = "ui"`) ; Cadence ne l'expose
//!   jamais aux IA.
//! - Cadence → serveur : `notifications/cadence/settings` quand l'utilisateur change les réglages.
//! - Serveur → Cadence : `notifications/cadence/event` `{ "event", "data" }`, relayée aux écrans
//!   ouverts du plugin (`cadence.on("compteur", …)`).

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, anyhow};
use rmcp::{
    ErrorData as McpError, Peer, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, CustomNotification, Implementation, MetaObject, ServerCapabilities,
        ServerConfig, ServerNotification,
    },
    service::NotificationContext,
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

type ToolResult = Result<CallToolResult, McpError>;

/// Cadence → serveur : réglages globaux modifiés (`{ "settings": {…} }`).
pub const SETTINGS_NOTIFICATION: &str = "notifications/cadence/settings";
/// Serveur → Cadence : événement relayé aux écrans du plugin.
pub const EVENT_NOTIFICATION: &str = "notifications/cadence/event";

/// Réglages globaux du plugin (`settings.schema.json`), reçus en `CADENCE_SETTINGS` puis par
/// `notifications/cadence/settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Settings {
    /// Prénom saisi à l'étape de configuration (`[[setup]]`).
    pub prenom: String,
    /// Pas du compteur, de 1 à 10.
    pub pas: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            prenom: String::new(),
            pas: 1,
        }
    }
}

impl Settings {
    /// Réglages d'après un objet JSON, `{ "settings": {…} }` ou l'objet seul ; une clé absente
    /// ou invalide garde sa valeur par défaut.
    pub fn from_value(value: &Value) -> Self {
        let value = value.get("settings").unwrap_or(value);
        let default = Settings::default();
        Settings {
            prenom: value
                .get("prenom")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .unwrap_or(default.prenom),
            pas: value
                .get("pas")
                .and_then(Value::as_u64)
                .filter(|p| (1..=10).contains(p))
                .map(|p| p as u32)
                .unwrap_or(default.pas),
        }
    }

    pub fn from_json(json: &str) -> Self {
        match serde_json::from_str(json) {
            Ok(value) => Settings::from_value(&value),
            Err(err) => {
                tracing::warn!("CADENCE_SETTINGS illisible : {err}");
                Settings::default()
            }
        }
    }
}

/// Chemin d'un outil externe dans `CADENCE_TOOLS` (`{ "git": "/usr/bin/git" }`). Un serveur ne
/// lance jamais un outil par son nom : Cadence l'a détecté (ou l'utilisateur a réglé son chemin).
pub fn tool_path(cadence_tools: &str, tool: &str) -> Option<PathBuf> {
    let tools: HashMap<String, String> = serde_json::from_str(cadence_tools).ok()?;
    tools.get(tool).filter(|p| !p.is_empty()).map(PathBuf::from)
}

/// `_meta` d'un outil appelable seulement par l'écran du plugin (contrat Cadence).
fn ui_only() -> MetaObject {
    let mut meta = MetaObject::new();
    meta.0.insert("cadence/visibility".into(), json!("ui"));
    meta
}

/// Résultat d'outil : objet structuré (`structuredContent`, ce que renvoie `cadence.call`), ou
/// erreur d'outil lisible par l'IA (`isError`, `tool_error` côté écran).
fn respond(result: Result<Value>) -> ToolResult {
    Ok(match result {
        Ok(value) => CallToolResult::structured(value),
        Err(err) => CallToolResult::error(vec![ContentBlock::text(format!("{err:#}"))]),
    })
}

/// Envoie un événement aux écrans du plugin. Sans écran ouvert, Cadence l'ignore.
async fn emit(peer: &Peer<RoleServer>, event: &str, data: Value) {
    let params = json!({ "event": event, "data": data });
    let notification =
        ServerNotification::CustomNotification(CustomNotification::new(EVENT_NOTIFICATION, Some(params)));
    if let Err(err) = peer.send_notification(notification).await {
        tracing::warn!(event, "événement non envoyé : {err}");
    }
}

/* ---------- Paramètres des outils (le schéma JSON vient des types) ---------- */

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct IncrementerParams {
    /// Pas de l'incrément, de 1 à 10 ; le réglage « Pas du compteur » si absent.
    pub pas: Option<u32>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct Empty {}

/* ---------- Serveur ---------- */

/// Ce que le serveur garde en mémoire ; le compteur est aussi écrit sur disque.
#[derive(Debug)]
struct State {
    settings: Settings,
    valeur: u64,
}

#[derive(Clone)]
pub struct Exemple {
    data_dir: PathBuf,
    /// Chemin de git d'après `CADENCE_TOOLS` (`[[requires]]` optionnel du manifeste).
    git: Option<PathBuf>,
    state: Arc<Mutex<State>>,
    #[allow(dead_code)] // lu par #[tool_handler]
    tool_router: ToolRouter<Self>,
}

/// Compteur rangé dans `CADENCE_DATA_DIR/compteur.json`.
fn counter_path(data_dir: &Path) -> PathBuf {
    data_dir.join("compteur.json")
}

fn read_counter(data_dir: &Path) -> u64 {
    fs::read_to_string(counter_path(data_dir))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v["valeur"].as_u64())
        .unwrap_or(0)
}

fn write_counter(data_dir: &Path, valeur: u64) -> Result<()> {
    fs::create_dir_all(data_dir).with_context(|| format!("création de {}", data_dir.display()))?;
    let path = counter_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&json!({ "valeur": valeur }))?)?;
    fs::rename(&tmp, &path).with_context(|| format!("écriture de {}", path.display()))
}

impl Exemple {
    pub fn new(data_dir: PathBuf, settings: Settings, git: Option<PathBuf>) -> Self {
        let valeur = read_counter(&data_dir);
        Exemple {
            data_dir,
            git,
            state: Arc::new(Mutex::new(State { settings, valeur })),
            tool_router: Self::tool_router(),
        }
    }

    /// Applique une notification de Cadence ; faux si elle ne concerne pas ce serveur.
    pub async fn apply_notification(&self, method: &str, params: Option<&Value>) -> bool {
        if method != SETTINGS_NOTIFICATION {
            return false;
        }
        let settings = params.map(Settings::from_value).unwrap_or_default();
        tracing::info!(?settings, "réglages mis à jour");
        self.state.lock().await.settings = settings;
        true
    }

    /// Incrémente le compteur et l'enregistre ; renvoie `{ valeur, pas, prenom }`.
    async fn increment(&self, pas: Option<u32>) -> Result<Value> {
        let mut state = self.state.lock().await;
        let pas = match pas {
            Some(p) if (1..=10).contains(&p) => p,
            Some(p) => return Err(anyhow!("Pas {p} invalide : de 1 à 10.")),
            None => state.settings.pas,
        };
        let valeur = state.valeur + u64::from(pas);
        write_counter(&self.data_dir, valeur)?;
        state.valeur = valeur;
        Ok(json!({ "valeur": valeur, "pas": pas, "prenom": state.settings.prenom }))
    }
}

#[tool_router]
impl Exemple {
    /// Le pair MCP (`Peer<RoleServer>`) est injecté par rmcp : il sert à envoyer l'événement.
    #[tool(
        description = "Incrémente le compteur du plugin Exemple (du pas réglé, ou de `pas`) et renvoie sa nouvelle valeur, le pas utilisé et le prénom de l'utilisateur."
    )]
    async fn incrementer(
        &self,
        Parameters(p): Parameters<IncrementerParams>,
        peer: Peer<RoleServer>,
    ) -> ToolResult {
        let result = self.increment(p.pas).await;
        if let Ok(value) = &result {
            emit(&peer, "compteur", json!({ "valeur": value["valeur"] })).await;
        }
        respond(result)
    }

    /// Réservé à l'écran : `meta = ui_only()`.
    #[tool(
        description = "État du plugin pour son écran : compteur, réglages, chemin de git et version du serveur.",
        meta = ui_only()
    )]
    async fn etat(&self, Parameters(_): Parameters<Empty>) -> ToolResult {
        let state = self.state.lock().await;
        respond(Ok(json!({
            "valeur": state.valeur,
            "settings": state.settings,
            "git": self.git.as_ref().map(|p| p.to_string_lossy().replace('\\', "/")),
            "version": env!("CARGO_PKG_VERSION"),
        })))
    }
}

#[tool_handler]
impl ServerHandler for Exemple {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                env!("CARGO_PKG_NAME"),
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Plugin d'exemple de Cadence : un compteur. incrementer l'augmente et renvoie le prénom \
                 de l'utilisateur pour le saluer.",
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
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, ReadHalf, WriteHalf};

    use super::*;

    #[test]
    fn reads_settings_and_tools() {
        assert_eq!(
            Settings::from_json(r#"{ "prenom": " Rémi ", "pas": 3 }"#),
            Settings {
                prenom: "Rémi".into(),
                pas: 3
            }
        );
        // Forme de la notification, pas hors bornes, JSON illisible.
        let s = Settings::from_value(&json!({ "settings": { "prenom": "Léa", "pas": 42 } }));
        assert_eq!(
            s,
            Settings {
                prenom: "Léa".into(),
                pas: 1
            }
        );
        assert_eq!(Settings::from_json("pas du json"), Settings::default());

        let tools = r#"{ "git": "/usr/bin/git", "node": "" }"#;
        assert_eq!(tool_path(tools, "git"), Some(PathBuf::from("/usr/bin/git")));
        assert_eq!(tool_path(tools, "node"), None);
        assert_eq!(tool_path(tools, "gh"), None);
        assert_eq!(tool_path("{", "git"), None);
    }

    #[test]
    fn declares_one_tool_for_all_and_one_for_the_ui() {
        let server = Exemple::new(PathBuf::from("."), Settings::default(), None);
        let tools = server.tool_router.list_all();
        let meta = |name: &str| tools.iter().find(|t| t.name == name).map(|t| t.meta.clone());
        assert_eq!(meta("incrementer"), Some(None), "incrementer : visible des IA");
        let etat = meta("etat").flatten().expect("etat : _meta");
        assert_eq!(etat.0.get("cadence/visibility"), Some(&json!("ui")));
        assert_eq!(tools.len(), 2);
    }

    #[tokio::test]
    async fn counts_persists_and_follows_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let server = Exemple::new(
            tmp.path().to_path_buf(),
            Settings {
                prenom: "Rémi".into(),
                pas: 2,
            },
            None,
        );
        assert_eq!(
            server.increment(None).await.unwrap(),
            json!({ "valeur": 2, "pas": 2, "prenom": "Rémi" })
        );
        assert_eq!(server.increment(Some(5)).await.unwrap()["valeur"], 7);
        assert!(server.increment(Some(11)).await.is_err());

        let settings = json!({ "settings": { "prenom": "Léa", "pas": 4 } });
        assert!(
            server
                .apply_notification(SETTINGS_NOTIFICATION, Some(&settings))
                .await
        );
        assert!(!server.apply_notification("notifications/autre", None).await);
        assert_eq!(
            server.increment(None).await.unwrap(),
            json!({ "valeur": 11, "pas": 4, "prenom": "Léa" })
        );

        // Un nouveau processus relit le compteur dans CADENCE_DATA_DIR.
        let again = Exemple::new(tmp.path().to_path_buf(), Settings::default(), None);
        assert_eq!(again.state.lock().await.valeur, 11);
    }

    /* ---------- Session MCP de bout en bout ---------- */

    /// Côté Cadence d'une session MCP en mémoire : des messages JSON-RPC écrits à la main, comme
    /// ceux que Cadence échange avec le serveur sur stdin/stdout.
    struct Client {
        write: WriteHalf<DuplexStream>,
        lines: Lines<BufReader<ReadHalf<DuplexStream>>>,
    }

    impl Client {
        async fn start(server: Exemple) -> Client {
            let (client, transport) = tokio::io::duplex(64 * 1024);
            tokio::spawn(async move {
                let service = server
                    .serve(tokio::io::split(transport))
                    .await
                    .expect("initialisation MCP");
                let _ = service.waiting().await;
            });
            let (read, write) = tokio::io::split(client);
            let mut c = Client {
                write,
                lines: BufReader::new(read).lines(),
            };
            c.send(json!({
                "jsonrpc": "2.0", "id": 0, "method": "initialize",
                "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                            "clientInfo": { "name": "cadence-test", "version": "0.0.0" } }
            }))
            .await;
            let (init, _) = c.response(0).await;
            assert_eq!(init["result"]["serverInfo"]["name"], "cadence-exemple");
            c.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
                .await;
            c
        }

        async fn send(&mut self, message: Value) {
            let mut line = serde_json::to_vec(&message).unwrap();
            line.push(b'\n');
            self.write.write_all(&line).await.unwrap();
        }

        /// Réponse à la requête `id`, et les notifications reçues avant elle.
        async fn response(&mut self, id: u64) -> (Value, Vec<Value>) {
            let mut notifications = Vec::new();
            loop {
                let line = tokio::time::timeout(Duration::from_secs(10), self.lines.next_line())
                    .await
                    .expect("pas de réponse du serveur")
                    .unwrap()
                    .expect("flux fermé");
                let message: Value = serde_json::from_str(&line).unwrap();
                if message["id"] == json!(id) {
                    return (message, notifications);
                }
                notifications.push(message);
            }
        }

        async fn call(&mut self, id: u64, tool: &str, args: Value) -> (Value, Vec<Value>) {
            self.send(json!({
                "jsonrpc": "2.0", "id": id, "method": "tools/call",
                "params": { "name": tool, "arguments": args }
            }))
            .await;
            self.response(id).await
        }
    }

    #[tokio::test]
    async fn speaks_mcp_like_cadence() {
        let tmp = tempfile::tempdir().unwrap();
        let server = Exemple::new(
            tmp.path().to_path_buf(),
            Settings::default(),
            Some(PathBuf::from("/usr/bin/git")),
        );
        let mut cadence = Client::start(server).await;

        // tools/list : les deux outils, `etat` marqué pour l'écran seulement.
        cadence
            .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
            .await;
        let (list, _) = cadence.response(1).await;
        let tools = list["result"]["tools"].as_array().unwrap();
        let etat = tools.iter().find(|t| t["name"] == "etat").unwrap();
        assert_eq!(etat["_meta"]["cadence/visibility"], "ui");

        // Notification de réglages. rmcp la traite dans sa propre tâche : on attend que `etat`
        // la reflète avant d'incrémenter.
        cadence
            .send(json!({ "jsonrpc": "2.0", "method": SETTINGS_NOTIFICATION,
                          "params": { "settings": { "prenom": "Rémi", "pas": 3 } } }))
            .await;
        let mut id = 10;
        loop {
            id += 1;
            let (state, _) = cadence.call(id, "etat", json!({})).await;
            if state["result"]["structuredContent"]["settings"]["pas"] == 3 {
                break;
            }
            assert!(id < 100, "réglages jamais appliqués");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // incrementer : résultat structuré et événement émis avant la réponse.
        let (result, notifications) = cadence.call(2, "incrementer", json!({})).await;
        assert_eq!(
            result["result"]["structuredContent"],
            json!({ "valeur": 3, "pas": 3, "prenom": "Rémi" })
        );
        assert_eq!(
            notifications,
            [json!({ "jsonrpc": "2.0", "method": EVENT_NOTIFICATION,
                     "params": { "event": "compteur", "data": { "valeur": 3 } } })]
        );

        // Erreur d'outil : `isError`, message lisible.
        let (bad, _) = cadence.call(3, "incrementer", json!({ "pas": 50 })).await;
        assert_eq!(bad["result"]["isError"], true);
        assert!(
            bad["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("de 1 à 10")
        );

        let (state, _) = cadence.call(4, "etat", json!({})).await;
        let state = &state["result"]["structuredContent"];
        assert_eq!(
            (state["valeur"].clone(), state["git"].clone()),
            (json!(3), json!("/usr/bin/git"))
        );
        assert_eq!(state["settings"], json!({ "prenom": "Rémi", "pas": 3 }));
    }
}
