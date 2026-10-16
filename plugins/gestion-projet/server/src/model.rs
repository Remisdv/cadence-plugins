//! Conventions de Cadence sur GitHub et forme des données rendues aux IA et à l'UI.
//!
//! - Type d'issue : label `type/feat|fix|chore|perf|docs`.
//! - État : `status/todo|doing|review` ; une issue fermée est « done ».
//! - Estimation : `estimate/S|M|L|XL`.
//! - Version : milestone semver (`0.1.2`) ; daté = sprint, sans date = palier de roadmap.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ISSUE_TYPES: [&str; 5] = ["feat", "fix", "chore", "perf", "docs"];
pub const ESTIMATES: [&str; 4] = ["S", "M", "L", "XL"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum IssueType {
    Feat,
    Fix,
    Chore,
    Perf,
    Docs,
}

impl IssueType {
    pub fn label(self) -> String {
        let slug = match self {
            IssueType::Feat => "feat",
            IssueType::Fix => "fix",
            IssueType::Chore => "chore",
            IssueType::Perf => "perf",
            IssueType::Docs => "docs",
        };
        format!("type/{slug}")
    }
}

/// État modifiable par label (« done » = fermer l'issue).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Todo,
    Doing,
    Review,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Status::Todo => "status/todo",
            Status::Doing => "status/doing",
            Status::Review => "status/review",
        }
    }
}

/// Labels après changement d'état : retire tout `status/*`, ajoute le nouveau.
pub fn with_status(labels: &[String], status: Status) -> Vec<String> {
    let mut out: Vec<String> = labels
        .iter()
        .filter(|l| !l.starts_with("status/"))
        .cloned()
        .collect();
    out.push(status.label().to_string());
    out
}

/// Labels après ajout et retrait, sans doublon, dans l'ordre d'origine.
pub fn edit_labels(labels: &[String], add: &[String], remove: &[String]) -> Vec<String> {
    let mut out: Vec<String> = labels.iter().filter(|l| !remove.contains(l)).cloned().collect();
    for l in add {
        if !out.contains(l) {
            out.push(l.clone());
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    pub number: u32,
    pub title: String,
    /// `open` ou `closed`.
    pub state: String,
    /// `todo`, `doing`, `review` (labels) ou `done` (fermée).
    pub status: &'static str,
    #[serde(rename = "type")]
    pub issue_type: Option<String>,
    pub estimate: Option<String>,
    pub labels: Vec<String>,
    /// Titre du milestone (version).
    pub milestone: Option<String>,
    pub assignees: Vec<String>,
    pub author: Option<String>,
    pub comments: u32,
    pub url: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub closed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

fn u32_of(v: &Value) -> u32 {
    v.as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(0)
}

/// Vrai pour une pull request renvoyée par l'API issues.
pub fn is_pull_request(raw: &Value) -> bool {
    raw.get("pull_request").is_some_and(|v| !v.is_null())
}

/// Issue de l'API REST → forme Cadence. `with_body` garde la description.
pub fn issue_from(raw: &Value, with_body: bool) -> Issue {
    let labels: Vec<String> = raw["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l["name"].as_str().or_else(|| l.as_str()).map(str::to_string))
        .collect();
    let state = str_of(&raw["state"]).unwrap_or_else(|| "open".into());
    let status = if state == "closed" {
        "done"
    } else if labels.iter().any(|l| l == "status/review") {
        "review"
    } else if labels.iter().any(|l| l == "status/doing") {
        "doing"
    } else {
        "todo"
    };
    let suffix = |prefix: &str, allowed: &[&str]| {
        labels
            .iter()
            .filter_map(|l| l.strip_prefix(prefix))
            .find(|s| allowed.contains(s))
            .map(str::to_string)
    };
    Issue {
        number: u32_of(&raw["number"]),
        title: str_of(&raw["title"]).unwrap_or_default(),
        state,
        status,
        issue_type: suffix("type/", &ISSUE_TYPES),
        estimate: suffix("estimate/", &ESTIMATES),
        milestone: str_of(&raw["milestone"]["title"]),
        assignees: raw["assignees"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| str_of(&a["login"]))
            .collect(),
        author: str_of(&raw["user"]["login"]),
        comments: u32_of(&raw["comments"]),
        url: str_of(&raw["html_url"]).unwrap_or_default(),
        created_at: str_of(&raw["created_at"]),
        updated_at: str_of(&raw["updated_at"]),
        closed_at: str_of(&raw["closed_at"]),
        body: with_body.then(|| str_of(&raw["body"]).unwrap_or_default()),
        labels,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Version {
    pub title: String,
    pub number: u32,
    /// `sprint` (milestone daté) ou `palier` (sans date).
    pub kind: &'static str,
    pub state: String,
    pub due_on: Option<String>,
    pub description: Option<String>,
    pub open_issues: u32,
    pub closed_issues: u32,
    pub url: String,
}

pub fn version_from(raw: &Value) -> Version {
    let due_on = str_of(&raw["due_on"]);
    Version {
        title: str_of(&raw["title"]).unwrap_or_default(),
        number: u32_of(&raw["number"]),
        kind: if due_on.is_some() { "sprint" } else { "palier" },
        state: str_of(&raw["state"]).unwrap_or_else(|| "open".into()),
        due_on,
        description: str_of(&raw["description"]).filter(|d| !d.trim().is_empty()),
        open_issues: u32_of(&raw["open_issues"]),
        closed_issues: u32_of(&raw["closed_issues"]),
        url: str_of(&raw["html_url"]).unwrap_or_default(),
    }
}

/// Milestone désigné par son titre, avec ou sans préfixe de tag (`v0.1.2` ≡ `0.1.2`).
pub fn find_milestone<'a>(milestones: &'a [Value], wanted: &str, tag_prefix: &str) -> Option<&'a Value> {
    let norm = |s: &str| {
        let s = s.trim();
        let s = if tag_prefix.is_empty() {
            s
        } else {
            s.strip_prefix(tag_prefix).unwrap_or(s)
        };
        s.to_lowercase()
    };
    let wanted = norm(wanted);
    milestones
        .iter()
        .find(|m| m["title"].as_str().is_some_and(|t| norm(t) == wanted))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw() -> Value {
        json!({
            "number": 42, "title": "Connexion GitHub", "state": "open", "body": "## Contexte",
            "labels": [{"name": "type/feat"}, {"name": "status/doing"}, {"name": "estimate/M"}, {"name": "area/auth"}],
            "milestone": {"title": "0.1.2"}, "assignees": [{"login": "RemiSDV"}], "user": {"login": "RemiSDV"},
            "comments": 3, "html_url": "https://github.com/me/app/issues/42",
            "updated_at": "2026-10-01T10:00:00Z"
        })
    }

    #[test]
    fn maps_issues_with_conventions() {
        let issue = issue_from(&raw(), false);
        assert_eq!((issue.number, issue.status), (42, "doing"));
        assert_eq!(issue.issue_type.as_deref(), Some("feat"));
        assert_eq!(issue.estimate.as_deref(), Some("M"));
        assert_eq!(issue.milestone.as_deref(), Some("0.1.2"));
        assert_eq!(issue.body, None);
        assert_eq!(issue_from(&raw(), true).body.as_deref(), Some("## Contexte"));

        let mut closed = raw();
        closed["state"] = json!("closed");
        assert_eq!(issue_from(&closed, false).status, "done");
        assert!(!is_pull_request(&raw()));
        assert!(is_pull_request(&json!({"pull_request": {"url": "x"}})));
    }

    #[test]
    fn edits_labels() {
        let labels = vec!["type/fix".to_string(), "status/todo".to_string()];
        assert_eq!(
            with_status(&labels, Status::Review),
            ["type/fix", "status/review"]
        );
        let edited = edit_labels(
            &labels,
            &["area/ui".into(), "type/fix".into()],
            &["status/todo".into()],
        );
        assert_eq!(edited, ["type/fix", "area/ui"]);
        assert_eq!(IssueType::Perf.label(), "type/perf");
    }

    #[test]
    fn maps_versions_and_finds_milestones() {
        let ms = vec![
            json!({"title": "0.1.2", "number": 3, "due_on": "2026-10-20T00:00:00Z", "state": "open"}),
            json!({"title": "0.2.0", "number": 4, "due_on": null, "state": "open", "description": "- Rôles"}),
        ];
        assert_eq!(version_from(&ms[0]).kind, "sprint");
        assert_eq!(version_from(&ms[1]).kind, "palier");
        assert_eq!(
            find_milestone(&ms, "v0.2.0", "v").map(|m| m["number"].clone()),
            Some(json!(4))
        );
        assert!(find_milestone(&ms, "0.3.0", "v").is_none());
    }
}
