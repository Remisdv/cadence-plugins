//! `cadence-gestion-projet` : serveur MCP (stdio) du plugin Cadence « Gestion de projet ».
//!
//! Lancé par Cadence, un processus par espace de travail. Journal sur stderr (stdout porte le
//! protocole MCP) ; niveau réglable avec `RUST_LOG`.

mod config;
mod github;
mod model;
mod server;

use anyhow::Result;
use rmcp::{ServiceExt, transport::stdio};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    if let Ok(api) = std::env::var("CADENCE_API")
        && api != config::SUPPORTED_API
    {
        tracing::warn!(
            "Cadence annonce l'API {api}, ce serveur implémente l'API {}",
            config::SUPPORTED_API
        );
    }

    let env = config::Env::from_process();
    let server = server::GestionProjet::new(&env)?;
    tracing::info!(token = env.token.is_some(), "serveur gestion-projet prêt");
    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
