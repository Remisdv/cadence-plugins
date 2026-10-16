//! `cadence-documents` : serveur MCP (stdio) du plugin Cadence « Documents ».
//!
//! Lancé par Cadence, un seul processus pour le plugin. Données dans `CADENCE_DATA_DIR`
//! (`<données de l'app>/plugins-data/documents/`) ; dossier des cours dans les réglages globaux
//! (`CADENCE_SETTINGS`, clé `dossier_cours`). Journal sur stderr.

mod extract;
mod library;
mod server;

use std::path::PathBuf;

use anyhow::{Result, bail};
use rmcp::{ServiceExt, transport::stdio};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let Some(data_dir) = var("CADENCE_DATA_DIR").map(PathBuf::from) else {
        bail!("CADENCE_DATA_DIR absent : ce serveur est lancé par Cadence.");
    };
    if let Ok(api) = std::env::var("CADENCE_API")
        && api != "1"
    {
        tracing::warn!("Cadence annonce l'API {api}, ce serveur implémente l'API 1");
    }
    let courses_dir = var("CADENCE_SETTINGS").and_then(|json| match serde_json::from_str(&json) {
        Ok(settings) => server::courses_dir_from_settings(&settings),
        Err(err) => {
            tracing::warn!("CADENCE_SETTINGS illisible : {err}");
            None
        }
    });

    tracing::info!(data = %data_dir.display(), cours = ?courses_dir, "serveur documents prêt");
    let service = server::Documents::new(data_dir, courses_dir)
        .serve(stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}
