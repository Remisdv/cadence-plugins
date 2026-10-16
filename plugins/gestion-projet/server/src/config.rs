//! Environnement fourni par Cadence et réglages de l'espace.
//!
//! Cadence lance le serveur avec `CADENCE_API=1`, `CADENCE_WORKSPACE`, `CADENCE_DATA_DIR`,
//! `CADENCE_GLOBAL_DIR` et `CADENCE_SECRET_GITHUB_TOKEN`. Les réglages de l'espace
//! (`settings.schema.json`) sont lus, dans l'ordre, dans `CADENCE_SETTINGS` (JSON), puis dans
//! `<CADENCE_DATA_DIR>/settings.json` ; à défaut de dépôt réglé, on lit le remote `origin` du
//! dossier de l'espace.

use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const SUPPORTED_API: &str = "1";

#[derive(Debug, Clone)]
pub struct Env {
    pub workspace: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub token: Option<String>,
    /// API REST GitHub (`GITHUB_API_URL` pour GitHub Enterprise ou les tests).
    pub api_url: String,
}

impl Env {
    pub fn from_process() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Env {
            workspace: var("CADENCE_WORKSPACE").map(PathBuf::from),
            data_dir: var("CADENCE_DATA_DIR").map(PathBuf::from),
            token: var("CADENCE_SECRET_GITHUB_TOKEN"),
            api_url: var("GITHUB_API_URL").unwrap_or_else(|| "https://api.github.com".into()),
        }
    }
}

/// Réglages par espace (voir `settings.schema.json`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// `owner/name`.
    pub repository: Option<String>,
    /// Préfixe des tags de version : `v` → `v0.1.2`.
    pub tag_prefix: String,
    pub sprint_length_days: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            repository: None,
            tag_prefix: "v".into(),
            sprint_length_days: 14,
        }
    }
}

impl Settings {
    pub fn parse(json: &str) -> anyhow::Result<Self> {
        let mut s: Settings = serde_json::from_str(json)?;
        s.repository = s.repository.as_deref().and_then(normalize_repo);
        Ok(s)
    }

    /// Réglages de l'espace, puis dépôt déduit du remote `origin` s'il manque.
    pub fn load(env: &Env) -> Self {
        let from_env = std::env::var("CADENCE_SETTINGS").ok();
        let from_file = env
            .data_dir
            .as_ref()
            .and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok());
        let mut settings = from_env
            .or(from_file)
            .and_then(|json| match Settings::parse(&json) {
                Ok(s) => Some(s),
                Err(err) => {
                    tracing::warn!("réglages illisibles, valeurs par défaut : {err}");
                    None
                }
            })
            .unwrap_or_default();
        if settings.repository.is_none() {
            settings.repository = env.workspace.as_deref().and_then(origin_repo);
        }
        settings
    }
}

/// `owner/name` validé (espaces retirés, suffixe `.git` toléré).
pub fn normalize_repo(value: &str) -> Option<String> {
    let v = value.trim().trim_end_matches('/').trim_end_matches(".git");
    let (owner, name) = v.split_once('/')?;
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (ok(owner) && ok(name)).then(|| format!("{owner}/{name}"))
}

/// `owner/name` d'une URL de remote GitHub (https ou ssh).
pub fn parse_remote_url(url: &str) -> Option<String> {
    let url = url.trim();
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.split_once("github.com/").map(|(_, rest)| rest))?;
    normalize_repo(path)
}

fn origin_repo(workspace: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(workspace)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).to_string())
        .as_deref()
        .and_then(parse_remote_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_settings_with_defaults() {
        let s = Settings::parse(r#"{"repository": " RemiSDV/cadence.git "}"#).unwrap();
        assert_eq!(s.repository.as_deref(), Some("RemiSDV/cadence"));
        assert_eq!((s.tag_prefix.as_str(), s.sprint_length_days), ("v", 14));
        let s = Settings::parse(r#"{"tag_prefix": "", "sprint_length_days": 7}"#).unwrap();
        assert_eq!(
            (s.repository, s.tag_prefix.as_str(), s.sprint_length_days),
            (None, "", 7)
        );
    }

    #[test]
    fn parses_remote_urls() {
        assert_eq!(
            parse_remote_url("https://github.com/me/app.git").as_deref(),
            Some("me/app")
        );
        assert_eq!(
            parse_remote_url("git@github.com:me/app.git\n").as_deref(),
            Some("me/app")
        );
        assert_eq!(
            parse_remote_url("ssh://git@github.com/me/my.app").as_deref(),
            Some("me/my.app")
        );
        assert_eq!(parse_remote_url("https://gitlab.com/me/app"), None);
        assert_eq!(normalize_repo("pas un dépôt"), None);
    }
}
