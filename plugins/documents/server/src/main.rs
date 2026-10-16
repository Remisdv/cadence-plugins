//! `cadence-documents` : serveur MCP (stdio) du plugin Cadence « Documents ».
//!
//! Lancé par Cadence, un processus par espace de travail. Données dans `CADENCE_DATA_DIR`
//! (à défaut `<CADENCE_WORKSPACE>/.cadence/plugins/documents`). Journal sur stderr.

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

    let var = |k: &str| {
        std::env::var(k)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
    };
    let workspace = var("CADENCE_WORKSPACE");
    let data_dir = match (var("CADENCE_DATA_DIR"), &workspace) {
        (Some(dir), _) => dir,
        (None, Some(ws)) => ws.join(".cadence").join("plugins").join("documents"),
        (None, None) => bail!("CADENCE_DATA_DIR absent : ce serveur est lancé par Cadence."),
    };
    if let Ok(api) = std::env::var("CADENCE_API")
        && api != "1"
    {
        tracing::warn!("Cadence annonce l'API {api}, ce serveur implémente l'API 1");
    }

    tracing::info!(data = %data_dir.display(), "serveur documents prêt");
    let service = server::Documents::new(data_dir, workspace).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
