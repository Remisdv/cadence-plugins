//! `cadence-exemple` : serveur MCP (stdio) du plugin Cadence « Exemple ».
//!
//! Plugin de référence pour les auteurs : un compteur rangé dans le dossier de données du plugin.
//! Ce fichier montre ce que Cadence donne au serveur au lancement ; `server.rs`, les outils et
//! les notifications.
//!
//! - Cadence lance **un seul processus** pour le plugin et lui parle MCP sur stdin/stdout :
//!   stdout est réservé au protocole, le journal va sur **stderr** (Cadence le range dans le
//!   journal du plugin) ;
//! - environnement : `CADENCE_API` (`1`), `CADENCE_DATA_DIR` (dossier de données du plugin),
//!   `CADENCE_SETTINGS` (réglages globaux en JSON), `CADENCE_TOOLS` (outils externes détectés :
//!   identifiant → chemin absolu de l'exécutable).

mod server;

use std::path::PathBuf;

use anyhow::{Result, bail};
use rmcp::{ServiceExt, transport::stdio};
use tracing_subscriber::EnvFilter;

use crate::server::{Exemple, Settings};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    if let Some(api) = var("CADENCE_API")
        && api != "1"
    {
        tracing::warn!("Cadence annonce l'API {api}, ce serveur implémente l'API 1");
    }
    let Some(data_dir) = var("CADENCE_DATA_DIR").map(PathBuf::from) else {
        bail!("CADENCE_DATA_DIR absent : ce serveur est lancé par Cadence.");
    };
    let settings = var("CADENCE_SETTINGS")
        .map(|json| Settings::from_json(&json))
        .unwrap_or_default();
    let git = var("CADENCE_TOOLS").and_then(|json| server::tool_path(&json, "git"));

    tracing::info!(data = %data_dir.display(), ?settings, git = ?git, "serveur exemple prêt");
    let service = Exemple::new(data_dir, settings, git).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
