//! Faux GitHub pour les tests : un petit serveur HTTP/1.1 local qui imite, sur un état en mémoire,
//! les routes REST dont se servent les issues, les milestones et le moteur des sprints
//! automatiques (issues, milestones, branches, releases, pull requests).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// État du faux dépôt.
pub struct Repo {
    pub name: String,
    pub default_branch: String,
    /// Issues brutes (forme de l'API, pull requests comprises).
    pub issues: Vec<Value>,
    pub milestones: Vec<Value>,
    /// Branches et leur commit.
    pub branches: HashMap<String, String>,
    /// Requêtes reçues : « MÉTHODE /chemin ».
    pub requests: Vec<String>,
}

impl Repo {
    pub fn new(name: &str, issues: Vec<Value>) -> Self {
        let issues = issues
            .into_iter()
            .map(|mut i| {
                let n = i["number"].as_u64().unwrap_or(0);
                i["html_url"] = json!(format!("https://github.com/{name}/issues/{n}"));
                i
            })
            .collect();
        Repo {
            name: name.to_string(),
            default_branch: "main".into(),
            issues,
            milestones: Vec::new(),
            branches: HashMap::from([("main".to_string(), "c0ffee".to_string())]),
            requests: Vec::new(),
        }
    }

    pub fn issue(&self, number: u64) -> Option<&Value> {
        self.issues.iter().find(|i| i["number"].as_u64() == Some(number))
    }

    fn handle(&mut self, method: &str, target: &str, body: Value) -> (u16, Value) {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        self.requests.push(format!("{method} {path}"));
        let q: HashMap<String, String> = query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (decode(k), decode(v)))
            .collect();
        let prefix = format!("/repos/{}", self.name);
        let Some(rest) = path.strip_prefix(&prefix) else {
            return not_found(path);
        };
        let segs: Vec<String> = rest.split('/').filter(|s| !s.is_empty()).map(decode).collect();
        let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
        match (method, segs.as_slice()) {
            ("GET", []) => (
                200,
                json!({
                    "full_name": self.name, "default_branch": self.default_branch, "private": true,
                    "html_url": format!("https://github.com/{}", self.name),
                    "open_issues_count": self.issues.iter().filter(|i| i["state"] == "open").count(),
                }),
            ),
            ("GET", ["issues"]) => (200, Value::Array(self.list_issues(&q))),
            ("POST", ["issues"]) => {
                let number = self
                    .issues
                    .iter()
                    .filter_map(|i| i["number"].as_u64())
                    .max()
                    .unwrap_or(0)
                    + 1;
                let labels: Vec<Value> = body["labels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|l| json!({ "name": l }))
                    .collect();
                let issue = json!({
                    "number": number, "title": body["title"], "body": body["body"], "state": "open",
                    "labels": labels, "milestone": null,
                    "html_url": format!("https://github.com/{}/issues/{number}", self.name),
                });
                self.issues.push(issue.clone());
                (201, issue)
            }
            ("GET", ["issues", n]) => match self.issue_mut(n) {
                Some(i) => (200, i.clone()),
                None => not_found(path),
            },
            ("PATCH", ["issues", n]) => {
                let milestone = match body.get("milestone") {
                    Some(Value::Null) => Some(Value::Null),
                    Some(m) => Some(
                        self.milestones
                            .iter()
                            .find(|x| x["number"] == *m)
                            .map(|x| json!({ "number": x["number"], "title": x["title"] }))
                            .unwrap_or(Value::Null),
                    ),
                    None => None,
                };
                let Some(issue) = self.issue_mut(n) else {
                    return not_found(path);
                };
                if let Some(m) = milestone {
                    issue["milestone"] = m;
                }
                for key in ["body", "title", "state"] {
                    if let Some(v) = body.get(key) {
                        issue[key] = v.clone();
                    }
                }
                (200, issue.clone())
            }
            ("GET", ["milestones"]) => {
                let state = q.get("state").map(String::as_str).unwrap_or("open");
                let list = self
                    .milestones
                    .iter()
                    .filter(|m| state == "all" || m["state"] == state)
                    .cloned()
                    .collect();
                (200, Value::Array(list))
            }
            ("POST", ["milestones"]) => {
                let number = self.milestones.len() + 1;
                let m = json!({
                    "number": number, "title": body["title"], "state": "open", "due_on": body["due_on"],
                    "description": body["description"], "open_issues": 0, "closed_issues": 0,
                    "html_url": format!("https://github.com/{}/milestone/{number}", self.name),
                });
                self.milestones.push(m.clone());
                (201, m)
            }
            ("PATCH", ["milestones", n]) => {
                let Some(m) = self.milestones.iter_mut().find(|m| number_is(&m["number"], n)) else {
                    return not_found(path);
                };
                if let Some(fields) = body.as_object() {
                    for (k, v) in fields {
                        m[k] = v.clone();
                    }
                }
                (200, m.clone())
            }
            ("GET", ["git", "ref", "heads", branch @ ..]) => match self.branches.get(&branch.join("/")) {
                Some(sha) => (200, json!({ "object": { "sha": sha } })),
                None => not_found(path),
            },
            ("POST", ["git", "refs"]) => {
                let name = body["ref"].as_str().unwrap_or("");
                let name = name.strip_prefix("refs/heads/").unwrap_or(name).to_string();
                if self.branches.contains_key(&name) {
                    return (422, json!({ "message": "Reference already exists" }));
                }
                let sha = body["sha"].as_str().unwrap_or("").to_string();
                self.branches.insert(name.clone(), sha.clone());
                (
                    201,
                    json!({ "ref": format!("refs/heads/{name}"), "object": { "sha": sha } }),
                )
            }
            ("GET", ["releases"] | ["pulls"]) => (200, json!([])),
            _ => not_found(path),
        }
    }

    fn issue_mut(&mut self, n: &str) -> Option<&mut Value> {
        self.issues.iter_mut().find(|i| number_is(&i["number"], n))
    }

    /// `GET /issues` : filtres `state`, `labels` (tous requis) et `milestone` (numéro, `none`, `*`).
    fn list_issues(&self, q: &HashMap<String, String>) -> Vec<Value> {
        let state = q.get("state").map(String::as_str).unwrap_or("open");
        let labels: Vec<&str> = q
            .get("labels")
            .map(|l| l.split(',').filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
        self.issues
            .iter()
            .filter(|i| state == "all" || i["state"] == state)
            .filter(|i| {
                labels.iter().all(|l| {
                    i["labels"]
                        .as_array()
                        .is_some_and(|ls| ls.iter().any(|x| x["name"] == *l))
                })
            })
            .filter(|i| match q.get("milestone").map(String::as_str) {
                None => true,
                Some("none") => i["milestone"].is_null(),
                Some("*") => !i["milestone"].is_null(),
                Some(n) => number_is(&i["milestone"]["number"], n),
            })
            .cloned()
            .collect()
    }
}

/// Le numéro JSON `v` vaut-il `n` (segment de chemin ou paramètre) ?
fn number_is(v: &Value, n: &str) -> bool {
    v.as_u64().is_some_and(|x| n.parse::<u64>() == Ok(x))
}

fn not_found(path: &str) -> (u16, Value) {
    (404, json!({ "message": format!("Not Found: {path}") }))
}

/// Décodage `%XX` et `+` d'une URL.
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    None => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Lance le faux GitHub ; rend son URL de base et son état partagé.
pub async fn start(repo: Repo) -> (String, Arc<Mutex<Repo>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("port local");
    let url = format!("http://{}", listener.local_addr().expect("adresse locale"));
    let state = Arc::new(Mutex::new(repo));
    let shared = state.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let state = shared.clone();
            tokio::spawn(async move {
                let _ = serve(socket, state).await;
            });
        }
    });
    (url, state)
}

/// Une connexion (requêtes successives, connexion gardée ouverte par le client).
async fn serve(mut socket: TcpStream, state: Arc<Mutex<Repo>>) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let head_end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            let n = socket.read(&mut chunk).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let mut lines = head.split("\r\n");
        let mut request = lines.next().unwrap_or("").split(' ');
        let (method, target) = (
            request.next().unwrap_or("").to_string(),
            request.next().unwrap_or("").to_string(),
        );
        let length = lines
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let start = head_end + 4;
        while buf.len() < start + length {
            let n = socket.read(&mut chunk).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let body = serde_json::from_slice(&buf[start..start + length]).unwrap_or(Value::Null);
        buf.drain(..start + length);
        let (status, json) = state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .handle(&method, &target, body);
        let text = json.to_string();
        let response = format!(
            "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}",
            if status < 300 { "OK" } else { "Error" },
            text.len()
        );
        socket.write_all(response.as_bytes()).await?;
    }
}
