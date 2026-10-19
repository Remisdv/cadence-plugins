//! Pull requests : requêtes GraphQL (CI, revues, diffstat, issue liée en un appel), lecture des
//! réponses GitHub et garde-fou de branche. Repris de Cadence 1 (`api/github/pulls.rs`).

use anyhow::{Result, bail};
use serde::Serialize;
use serde_json::Value;

/// Champs communs d'une PR, pour la liste et le détail.
const PR_FIELDS: &str = r#"
  id number title state isDraft url
  headRefName baseRefName
  author { login }
  milestone { title }
  labels(first: 20) { nodes { name } }
  additions deletions changedFiles
  comments { totalCount }
  createdAt updatedAt
  closingIssuesReferences(first: 5) { nodes { number } }
  reviewDecision
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 1) { nodes { ... on ReviewRequestedEvent { createdAt } } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 1) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } }
  } } } }
"#;

/// PR ouvertes (50 au plus) et/ou 30 dernières fusionnées ou fermées, triées par activité.
pub fn list_query() -> String {
    format!(
        r#"query($owner: String!, $name: String!, $open: Boolean!, $done: Boolean!) {{
  repository(owner: $owner, name: $name) {{
    open: pullRequests(states: OPEN, first: 50, orderBy: {{field: UPDATED_AT, direction: DESC}}) @include(if: $open) {{ nodes {{ ...Pr }} }}
    done: pullRequests(states: [MERGED, CLOSED], first: 30, orderBy: {{field: UPDATED_AT, direction: DESC}}) @include(if: $done) {{ nodes {{ ...Pr }} }}
  }}
}}
fragment Pr on PullRequest {{{PR_FIELDS}}}"#
    )
}

/// Une PR avec sa description, ses revues et le détail de ses checks.
pub fn detail_query() -> String {
    format!(
        r#"query($owner: String!, $name: String!, $number: Int!) {{
  repository(owner: $owner, name: $name) {{
    pullRequest(number: $number) {{
      ...Pr
      body mergeable
      reviews(last: 30) {{ nodes {{ state submittedAt body author {{ login }} }} }}
      checks: commits(last: 1) {{ nodes {{ commit {{ oid statusCheckRollup {{ contexts(first: 50) {{ nodes {{
        __typename
        ... on CheckRun {{ name status conclusion detailsUrl }}
        ... on StatusContext {{ context state targetUrl }}
      }} }} }} }} }} }}
    }}
  }}
}}
fragment Pr on PullRequest {{{PR_FIELDS}}}"#
    )
}

/// Identifiant GraphQL et état de brouillon d'une PR (avant `markPullRequestReadyForReview`).
pub const NODE_QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id isDraft state url } }
}"#;

pub const READY_MUTATION: &str = r#"mutation($id: ID!) {
  markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } }
}"#;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ci {
    /// `none`, `pending`, `success` ou `failure`.
    pub state: &'static str,
    /// Checks réussis (ou neutres / ignorés) sur le dernier commit, parmi `total`.
    pub passed: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PullRequest {
    pub repo: String,
    pub number: u32,
    pub title: String,
    /// `draft`, `open`, `merged` ou `closed`.
    pub state: &'static str,
    /// Branche source.
    pub head: String,
    /// Branche cible.
    pub base: String,
    pub author: Option<String>,
    pub url: String,
    /// Titre du milestone (version).
    pub milestone: Option<String>,
    pub labels: Vec<String>,
    /// Issues fermées par la PR (`Closes #42`).
    pub closes: Vec<u32>,
    pub ci: Ci,
    /// `approved`, `changes_requested`, `pending` (revue demandée ou requise) ou absent.
    pub review: Option<&'static str>,
    pub approvals: u32,
    pub changes_requested: u32,
    /// Relecteurs encore attendus (logins ou équipes).
    pub reviewers: Vec<String>,
    /// Dernière demande de revue encore ouverte.
    pub review_requested_at: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub comments: u32,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

fn u32_of(v: &Value) -> u32 {
    v.as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(0)
}

fn nodes(v: &Value) -> impl Iterator<Item = &Value> {
    v["nodes"].as_array().into_iter().flatten()
}

/// PR GraphQL → forme Cadence.
pub fn from_graphql(repo: &str, raw: &Value) -> PullRequest {
    let open = raw["state"].as_str() == Some("OPEN");
    let state = match raw["state"].as_str() {
        Some("MERGED") => "merged",
        Some("CLOSED") => "closed",
        _ if raw["isDraft"].as_bool() == Some(true) => "draft",
        _ => "open",
    };
    let reviewers: Vec<String> = nodes(&raw["reviewRequests"])
        .filter_map(|r| {
            let who = &r["requestedReviewer"];
            str_of(&who["login"]).or_else(|| str_of(&who["name"]))
        })
        .collect();
    let count = |s: &str| {
        nodes(&raw["latestOpinionatedReviews"])
            .filter(|r| r["state"] == s)
            .count() as u32
    };
    let review = match raw["reviewDecision"].as_str() {
        Some("APPROVED") => Some("approved"),
        Some("CHANGES_REQUESTED") => Some("changes_requested"),
        _ if !reviewers.is_empty() => Some("pending"),
        Some("REVIEW_REQUIRED") => Some("pending"),
        _ => None,
    };
    PullRequest {
        repo: repo.to_string(),
        number: u32_of(&raw["number"]),
        title: str_of(&raw["title"]).unwrap_or_default(),
        state,
        head: str_of(&raw["headRefName"]).unwrap_or_default(),
        base: str_of(&raw["baseRefName"]).unwrap_or_default(),
        author: str_of(&raw["author"]["login"]),
        url: str_of(&raw["url"]).unwrap_or_default(),
        milestone: str_of(&raw["milestone"]["title"]),
        labels: nodes(&raw["labels"]).filter_map(|l| str_of(&l["name"])).collect(),
        closes: nodes(&raw["closingIssuesReferences"])
            .map(|i| u32_of(&i["number"]))
            .collect(),
        ci: ci_of(raw),
        review,
        approvals: count("APPROVED"),
        changes_requested: count("CHANGES_REQUESTED"),
        review_requested_at: (open && !reviewers.is_empty())
            .then(|| {
                nodes(&raw["timelineItems"])
                    .last()
                    .and_then(|d| str_of(&d["createdAt"]))
            })
            .flatten(),
        reviewers,
        additions: u32_of(&raw["additions"]),
        deletions: u32_of(&raw["deletions"]),
        changed_files: u32_of(&raw["changedFiles"]),
        comments: u32_of(&raw["comments"]["totalCount"]),
        created_at: str_of(&raw["createdAt"]),
        updated_at: str_of(&raw["updatedAt"]),
    }
}

/// État de CI du dernier commit.
fn ci_of(raw: &Value) -> Ci {
    let rollup = nodes(&raw["commits"])
        .last()
        .map(|c| &c["commit"]["statusCheckRollup"]);
    let Some(rollup) = rollup.filter(|r| !r.is_null()) else {
        return Ci {
            state: "none",
            passed: 0,
            total: 0,
        };
    };
    let state = match rollup["state"].as_str() {
        Some("SUCCESS") => "success",
        Some("FAILURE" | "ERROR") => "failure",
        _ => "pending",
    };
    let ctx = &rollup["contexts"];
    let ok = |counts: &Value, states: &[&str]| -> u32 {
        counts
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["state"].as_str().is_some_and(|s| states.contains(&s)))
            .map(|c| u32_of(&c["count"]))
            .sum()
    };
    Ci {
        state,
        passed: ok(&ctx["checkRunCountsByState"], &["SUCCESS", "NEUTRAL", "SKIPPED"])
            + ok(&ctx["statusContextCountsByState"], &["SUCCESS"]),
        total: u32_of(&ctx["totalCount"]),
    }
}

/// PR de la réponse de `list_query`, ouvertes d'abord puis fusionnées ou fermées.
pub fn parse_list(repo: &str, data: &Value) -> Vec<PullRequest> {
    let r = &data["repository"];
    ["open", "done"]
        .iter()
        .flat_map(|key| nodes(&r[*key]))
        .filter(|n| n["number"].is_u64())
        .map(|n| from_graphql(repo, n))
        .collect()
}

/// Checks du dernier commit (détail d'une PR) : nom, état lisible, lien.
pub fn checks_of(raw: &Value) -> Vec<Value> {
    let Some(commit) = nodes(&raw["checks"]).last() else {
        return vec![];
    };
    nodes(&commit["commit"]["statusCheckRollup"]["contexts"])
        .map(|c| {
            if c["__typename"] == "StatusContext" {
                let state = match c["state"].as_str() {
                    Some("SUCCESS") => "success",
                    Some("FAILURE" | "ERROR") => "failure",
                    _ => "pending",
                };
                serde_json::json!({ "name": c["context"], "state": state, "url": c["targetUrl"] })
            } else {
                let state = match (c["status"].as_str(), c["conclusion"].as_str()) {
                    (Some("COMPLETED"), Some("SUCCESS")) => "success",
                    (Some("COMPLETED"), Some("NEUTRAL" | "SKIPPED")) => "skipped",
                    (Some("COMPLETED"), _) => "failure",
                    _ => "pending",
                };
                serde_json::json!({ "name": c["name"], "state": state, "url": c["detailsUrl"] })
            }
        })
        .collect()
}

/// Revues soumises (les commentaires seuls sans texte sont écartés).
pub fn reviews_of(raw: &Value) -> Vec<Value> {
    nodes(&raw["reviews"])
        .filter(|r| r["state"] != "COMMENTED" || r["body"].as_str().is_some_and(|b| !b.trim().is_empty()))
        .map(|r| {
            serde_json::json!({
                "author": r["author"]["login"],
                "state": r["state"].as_str().map(str::to_lowercase),
                "submitted_at": r["submittedAt"],
                "body": r["body"],
            })
        })
        .collect()
}

/// PR de l'API REST (création) → forme Cadence ; CI et revues ne sont pas encore connues.
pub fn from_rest(repo: &str, raw: &Value) -> PullRequest {
    let state = match (
        raw["state"].as_str(),
        raw["merged_at"].is_string(),
        raw["draft"].as_bool(),
    ) {
        (Some("closed"), true, _) => "merged",
        (Some("closed"), false, _) => "closed",
        (_, _, Some(true)) => "draft",
        _ => "open",
    };
    PullRequest {
        repo: repo.to_string(),
        number: u32_of(&raw["number"]),
        title: str_of(&raw["title"]).unwrap_or_default(),
        state,
        head: str_of(&raw["head"]["ref"]).unwrap_or_default(),
        base: str_of(&raw["base"]["ref"]).unwrap_or_default(),
        author: str_of(&raw["user"]["login"]),
        url: str_of(&raw["html_url"]).unwrap_or_default(),
        milestone: str_of(&raw["milestone"]["title"]),
        labels: raw["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| str_of(&l["name"]))
            .collect(),
        closes: vec![],
        ci: Ci {
            state: "none",
            passed: 0,
            total: 0,
        },
        review: None,
        approvals: 0,
        changes_requested: 0,
        reviewers: vec![],
        review_requested_at: None,
        additions: u32_of(&raw["additions"]),
        deletions: u32_of(&raw["deletions"]),
        changed_files: u32_of(&raw["changed_files"]),
        comments: u32_of(&raw["comments"]),
        created_at: str_of(&raw["created_at"]),
        updated_at: str_of(&raw["updated_at"]),
    }
}

/// Garde-fou : une PR ne part jamais de la branche par défaut (ni d'une branche vide).
/// `head` peut être `owner:branche` (fork).
pub fn check_head(head: &str, base: &str, default_branch: &str) -> Result<()> {
    let branch = head.trim().rsplit_once(':').map_or(head.trim(), |(_, b)| b);
    if branch.is_empty() {
        bail!("Branche source vide : poussez d'abord une branche de travail (ex. feat/42-connexion).");
    }
    if branch == default_branch {
        bail!(
            "Refusé : « {branch} » est la branche par défaut du dépôt. Une pull request part \
             toujours d'une branche de travail (ex. feat/42-connexion), jamais de {default_branch}."
        );
    }
    if !head.contains(':') && branch == base.trim() {
        bail!("La branche source et la branche cible sont identiques (« {branch} »).");
    }
    Ok(())
}

/// Issues qu'une PR déclare fermer (`Ferme #12`, `Closes #3`, `fixes #7`, `Résout #4`…).
/// GitHub ne les ferme d'elle-même qu'en fusionnant dans la branche par défaut : vers une branche
/// de release, c'est à nous de le faire.
pub fn closing_refs(body: &str) -> Vec<u32> {
    const WORDS: [&str; 12] = [
        "ferme", "fermes", "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves",
        "résout", "corrige",
    ];
    let lower = body.to_lowercase();
    let mut out = Vec::new();
    for (i, _) in lower.match_indices('#') {
        let digits: String = lower[i + 1..].chars().take_while(char::is_ascii_digit).collect();
        let Ok(n) = digits.parse::<u32>() else { continue };
        // Le mot juste avant le #, ponctuation (« : ») tolérée.
        let before = lower[..i].trim_end().trim_end_matches(':').trim_end();
        let word = before
            .rsplit(|c: char| c.is_whitespace() || "([".contains(c))
            .next()
            .unwrap_or("");
        if WORDS.contains(&word) && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// Diff d'une PR, fichier par fichier, tronqué à `budget` caractères au total (les fichiers
/// suivants sont listés sans patch).
pub fn diff_text(files: &[Value], only: Option<&str>, budget: usize) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut skipped = Vec::new();
    for f in files {
        let name = f["filename"].as_str().unwrap_or("");
        if only.is_some_and(|o| o != name) {
            continue;
        }
        let patch = f["patch"]
            .as_str()
            .unwrap_or("(binaire ou trop gros : pas de patch)");
        let block = format!(
            "--- {name} ({}, +{} −{})\n{patch}\n\n",
            f["status"].as_str().unwrap_or("?"),
            f["additions"].as_u64().unwrap_or(0),
            f["deletions"].as_u64().unwrap_or(0)
        );
        if out.len() + block.len() > budget {
            skipped.push(name.to_string());
        } else {
            out.push_str(&block);
        }
    }
    (out, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Nœud au format exact renvoyé par GitHub (relevé sur un dépôt public).
    fn node(patch: Value) -> Value {
        let mut base = json!({
            "id": "PR_kw1", "number": 86, "title": "feat(roadmap) : lanes", "state": "OPEN",
            "isDraft": false, "url": "https://github.com/me/app/pull/86",
            "headRefName": "feat/138-roadmap-lanes", "baseRefName": "main",
            "author": {"login": "marc"},
            "milestone": {"title": "0.1.2"},
            "labels": {"nodes": [{"name": "type/feat"}]},
            "additions": 412, "deletions": 87, "changedFiles": 11, "comments": {"totalCount": 3},
            "createdAt": "2026-10-13T09:00:00Z", "updatedAt": "2026-10-15T09:00:00Z",
            "closingIssuesReferences": {"nodes": [{"number": 138}]},
            "reviewDecision": "REVIEW_REQUIRED",
            "latestOpinionatedReviews": {"nodes": [{"state": "COMMENTED"}]},
            "reviewRequests": {"nodes": [{"requestedReviewer": {"__typename": "User", "login": "remisdv"}}]},
            "timelineItems": {"nodes": [{"createdAt": "2026-10-14T08:00:00Z"}]},
            "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE", "contexts": {
                "totalCount": 4,
                "checkRunCountsByState": [{"state": "SUCCESS", "count": 2}, {"state": "SKIPPED", "count": 1},
                                          {"state": "FAILURE", "count": 1}],
                "statusContextCountsByState": [{"state": "SUCCESS", "count": 0}]}}}}]}
        });
        if let (Some(base), Some(patch)) = (base.as_object_mut(), patch.as_object()) {
            for (k, v) in patch {
                base.insert(k.clone(), v.clone());
            }
        }
        base
    }

    #[test]
    fn reads_both_lists_of_the_query() {
        let data = json!({"repository": {
            "open": {"nodes": [node(json!({}))]},
            "done": {"nodes": [node(json!({"number": 80, "state": "MERGED"})), {"number": "illisible"}]}
        }});
        let pulls = parse_list("me/app", &data);
        assert_eq!(pulls.iter().map(|p| p.number).collect::<Vec<_>>(), [86, 80]);
        assert_eq!(pulls[1].state, "merged");
        // Branche absente de la requête (@include faux) : rien.
        assert!(parse_list("me/app", &json!({"repository": {"open": {"nodes": []}}})).is_empty());
        assert!(list_query().contains("@include(if: $done)"));
        assert!(detail_query().contains("pullRequest(number: $number)"));
    }

    #[test]
    fn converts_ci_reviews_and_links() {
        let pr = from_graphql("me/app", &node(json!({})));
        assert_eq!(
            (pr.state, pr.repo.as_str(), pr.head.as_str()),
            ("open", "me/app", "feat/138-roadmap-lanes")
        );
        assert_eq!(
            pr.ci,
            Ci {
                state: "failure",
                passed: 3,
                total: 4
            }
        );
        assert_eq!(pr.review, Some("pending"));
        assert_eq!(pr.reviewers, ["remisdv"]);
        assert_eq!(pr.review_requested_at.as_deref(), Some("2026-10-14T08:00:00Z"));
        assert_eq!(
            (pr.closes.clone(), pr.milestone.as_deref()),
            (vec![138], Some("0.1.2"))
        );
        assert_eq!((pr.additions, pr.deletions, pr.comments), (412, 87, 3));
    }

    #[test]
    fn reads_drafts_merges_and_missing_ci() {
        let draft = from_graphql(
            "me/app",
            &node(json!({"isDraft": true, "commits": {"nodes": []}})),
        );
        assert_eq!((draft.state, draft.ci.state), ("draft", "none"));
        let merged = from_graphql(
            "me/app",
            &node(
                json!({"state": "MERGED", "reviewDecision": "APPROVED", "reviewRequests": {"nodes": []},
                "latestOpinionatedReviews": {"nodes": [{"state": "APPROVED"}, {"state": "APPROVED"}]}}),
            ),
        );
        assert_eq!(
            (merged.state, merged.review, merged.approvals),
            ("merged", Some("approved"), 2)
        );
        assert_eq!(merged.review_requested_at, None);
        let ghost = from_graphql(
            "me/app",
            &node(json!({"author": null, "reviewDecision": null, "reviewRequests": {"nodes": []}})),
        );
        assert_eq!((ghost.author, ghost.review), (None, None));
    }

    #[test]
    fn reads_checks_and_reviews_of_a_detail() {
        let raw = json!({
            "checks": {"nodes": [{"commit": {"oid": "abc", "statusCheckRollup": {"contexts": {"nodes": [
                {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "u1"},
                {"__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": null, "detailsUrl": "u2"},
                {"__typename": "CheckRun", "name": "e2e", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "u3"},
                {"__typename": "StatusContext", "context": "ci/legacy", "state": "SUCCESS", "targetUrl": "u4"}
            ]}}}}]},
            "reviews": {"nodes": [
                {"state": "COMMENTED", "body": "", "author": {"login": "bot"}, "submittedAt": "t"},
                {"state": "CHANGES_REQUESTED", "body": "À revoir", "author": {"login": "marc"}, "submittedAt": "t"}
            ]}
        });
        let states: Vec<String> = checks_of(&raw)
            .iter()
            .map(|c| c["state"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(states, ["success", "pending", "failure", "success"]);
        let reviews = reviews_of(&raw);
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0]["state"], "changes_requested");
        assert!(checks_of(&json!({})).is_empty());
    }

    #[test]
    fn reads_a_created_pull_request() {
        let raw = json!({"number": 90, "title": "fix: quota", "state": "open", "draft": true,
            "head": {"ref": "fix/156-quota"}, "base": {"ref": "main"}, "user": {"login": "RemiSDV"},
            "html_url": "https://github.com/me/app/pull/90", "merged_at": null});
        let pr = from_rest("me/app", &raw);
        assert_eq!(
            (pr.number, pr.state, pr.head.as_str(), pr.base.as_str()),
            (90, "draft", "fix/156-quota", "main")
        );
        let merged = from_rest(
            "me/app",
            &json!({"state": "closed", "merged_at": "2026-10-01T00:00:00Z"}),
        );
        assert_eq!(merged.state, "merged");
    }

    #[test]
    fn refuses_the_default_branch_as_head() {
        assert!(check_head("feat/42-connexion", "main", "main").is_ok());
        assert!(check_head("fork-owner:main", "main", "main").is_err());
        let err = check_head("main", "main", "main").unwrap_err().to_string();
        assert!(err.contains("branche par défaut"), "{err}");
        assert!(check_head(" ", "main", "main").is_err());
        assert!(
            check_head("develop", "develop", "main")
                .unwrap_err()
                .to_string()
                .contains("identiques")
        );
        assert!(check_head("fork:develop", "develop", "main").is_ok());
    }

    #[test]
    fn finds_the_issues_a_pr_closes() {
        let body = "Ferme #12\n\nVoir aussi #13. Closes: #3 et fixes #7 (lié à #8) ; Résout #4, corrige #4";
        assert_eq!(closing_refs(body), [12, 3, 7, 4]);
        assert!(closing_refs("Aucune référence, juste #5").is_empty());
    }

    #[test]
    fn truncates_a_diff_by_file() {
        let files = vec![
            serde_json::json!({ "filename": "a.rs", "status": "modified", "additions": 1, "deletions": 0, "patch": "@@ +1 @@\n+x" }),
            serde_json::json!({ "filename": "b.rs", "status": "added", "additions": 9, "deletions": 0, "patch": "x".repeat(500) }),
        ];
        let (text, skipped) = diff_text(&files, None, 200);
        assert!(text.contains("--- a.rs (modified, +1 −0)"));
        assert_eq!(skipped, ["b.rs"]);
        let (only, _) = diff_text(&files, Some("b.rs"), 10_000);
        assert!(only.starts_with("--- b.rs"));
    }
}
