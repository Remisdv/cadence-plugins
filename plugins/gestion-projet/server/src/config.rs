//! Environnement fourni par Cadence, réglages globaux et dépôts suivis.
//!
//! Cadence lance un seul processus par plugin avec `CADENCE_API=1`, `CADENCE_DATA_DIR` (inutilisé :
//! ce plugin ne garde rien en local), `CADENCE_SETTINGS` (réglages globaux, JSON) et, grâce au service `repos` déclaré dans le
//! manifeste, `CADENCE_GITHUB_TOKEN` (si GitHub est connecté) et `CADENCE_REPOS` (dépôts suivis,
//! JSON). Les changements arrivent ensuite par `notifications/cadence/settings` et
//! `notifications/cadence/repos`.

use serde::Deserialize;
use serde_json::Value;

pub const SUPPORTED_API: &str = "1";

#[derive(Debug, Clone)]
pub struct Env {
    /// Jeton du service `repos` (connexion GitHub gérée par Cadence).
    pub token: Option<String>,
    /// Dépôts suivis, `owner/name`.
    pub repos: Vec<String>,
    pub settings: Settings,
    /// API REST GitHub (`GITHUB_API_URL` pour GitHub Enterprise ou les tests).
    pub api_url: String,
}

impl Env {
    pub fn from_process() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let repos = match var("CADENCE_REPOS").map(|json| parse_repos_json(&json)) {
            Some(Ok(repos)) => repos,
            Some(Err(err)) => {
                tracing::warn!("CADENCE_REPOS illisible, aucun dépôt suivi : {err}");
                Vec::new()
            }
            None => Vec::new(),
        };
        Env {
            token: var("CADENCE_GITHUB_TOKEN"),
            repos,
            settings: var("CADENCE_SETTINGS")
                .map(|json| Settings::parse_or_default(&json))
                .unwrap_or_default(),
            api_url: var("GITHUB_API_URL").unwrap_or_else(|| "https://api.github.com".into()),
        }
    }
}

/// Réglages globaux du plugin (voir `settings.schema.json`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Préfixe des tags de version : `v` → `v0.1.2`.
    pub tag_prefix: String,
    pub sprint_length_days: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            tag_prefix: "v".into(),
            sprint_length_days: 14,
        }
    }
}

impl Settings {
    pub fn parse(json: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(json)?)
    }

    /// Réglages illisibles : valeurs par défaut, avec un avertissement au journal.
    pub fn parse_or_default(json: &str) -> Self {
        Settings::parse(json).unwrap_or_else(|err| {
            tracing::warn!("réglages illisibles, valeurs par défaut : {err}");
            Settings::default()
        })
    }

    /// Paramètres de `notifications/cadence/settings` : `{ "settings": {…} }` ou l'objet seul.
    pub fn from_notification(params: &Value) -> anyhow::Result<Self> {
        let value = params.get("settings").unwrap_or(params);
        Ok(serde_json::from_value(value.clone())?)
    }
}

/// `owner/name` validé (espaces retirés, suffixe `.git` toléré).
pub fn normalize_repo(value: &str) -> Option<String> {
    let v = value.trim().trim_end_matches('/').trim_end_matches(".git");
    let (owner, name) = v.split_once('/')?;
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (ok(owner) && ok(name)).then(|| format!("{owner}/{name}"))
}

/// Dépôts suivis lus dans `CADENCE_REPOS` ou `notifications/cadence/repos`.
///
/// Formes acceptées : `["owner/name", …]`, `[{ "fullName" | "full_name" | "repo": "owner/name", … }]`,
/// ou l'une des deux sous une clé `repos`. Les doublons et les noms invalides sont écartés.
pub fn parse_repos(value: &Value) -> anyhow::Result<Vec<String>> {
    let list = match value {
        Value::Array(items) => items,
        Value::Object(map) => match map.get("repos") {
            Some(Value::Array(items)) => items,
            _ => anyhow::bail!("liste de dépôts attendue (clé « repos »)"),
        },
        _ => anyhow::bail!("liste de dépôts attendue"),
    };
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let name = match item {
            Value::String(s) => Some(s.as_str()),
            Value::Object(o) => ["fullName", "full_name", "repo"]
                .iter()
                .find_map(|k| o.get(*k).and_then(Value::as_str)),
            _ => None,
        };
        match name.and_then(normalize_repo) {
            Some(repo) if !out.iter().any(|r| r.eq_ignore_ascii_case(&repo)) => out.push(repo),
            Some(_) => {}
            None => tracing::warn!("dépôt suivi ignoré : {item}"),
        }
    }
    Ok(out)
}

pub fn parse_repos_json(json: &str) -> anyhow::Result<Vec<String>> {
    parse_repos(&serde_json::from_str(json)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_settings_with_defaults() {
        let s = Settings::parse(r#"{"tag_prefix": "", "sprint_length_days": 7}"#).unwrap();
        assert_eq!((s.tag_prefix.as_str(), s.sprint_length_days), ("", 7));
        assert_eq!(Settings::parse("{}").unwrap(), Settings::default());
        assert_eq!(Settings::parse_or_default("pas du json"), Settings::default());
        let s = Settings::from_notification(&json!({ "settings": { "tag_prefix": "release-" } })).unwrap();
        assert_eq!((s.tag_prefix.as_str(), s.sprint_length_days), ("release-", 14));
        let s = Settings::from_notification(&json!({ "sprint_length_days": 10 })).unwrap();
        assert_eq!(s.sprint_length_days, 10);
    }

    #[test]
    fn reads_followed_repos() {
        assert_eq!(
            parse_repos_json(r#"["me/app", " me/site.git ", "ME/APP", "pas un dépôt"]"#).unwrap(),
            ["me/app", "me/site"]
        );
        assert_eq!(
            parse_repos(&json!({ "repos": [{ "fullName": "me/app", "defaultBranch": "main" }, { "full_name": "org/lib" }] }))
                .unwrap(),
            ["me/app", "org/lib"]
        );
        assert_eq!(parse_repos(&json!([])).unwrap(), Vec::<String>::new());
        assert!(parse_repos(&json!("me/app")).is_err());
        assert!(parse_repos_json("{").is_err());
    }

    #[test]
    fn normalizes_repo_names() {
        assert_eq!(
            normalize_repo(" RemiSDV/cadence.git ").as_deref(),
            Some("RemiSDV/cadence")
        );
        assert_eq!(normalize_repo("me/my.app/").as_deref(), Some("me/my.app"));
        assert_eq!(normalize_repo("pas un dépôt"), None);
        assert_eq!(normalize_repo("me/"), None);
    }
}
