//! Architecture du projet : un niveau système (services : proxy, front, back, base de données…
//! et leurs liens), puis l'intérieur de chaque service (couches : controller, service, DTO,
//! repository…, qui peut utiliser qui, règles et conventions).
//!
//! Elle vit dans le dépôt, versionnée avec le code : `architecture/architecture.json` (source) et
//! `architecture/ARCHITECTURE.md` (généré, lisible, schéma Mermaid). Les IA la lisent avant de
//! coder ; l'écran Architecture la modifie par une branche `archi/…` et une pull request.

use std::collections::HashSet;

use anyhow::{Context, Result, bail};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const JSON_PATH: &str = "architecture/architecture.json";
pub const MD_PATH: &str = "architecture/ARCHITECTURE.md";
/// Préfixe des branches de modification de l'architecture.
pub const BRANCH_PREFIX: &str = "archi/";

/// Natures de service reconnues (le schéma les range en colonnes, de l'entrée vers les données).
pub const KINDS: [&str; 9] = [
    "proxy", "frontend", "backend", "worker", "database", "cache", "queue", "external", "autre",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Architecture {
    /// Version du format (1).
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub services: Vec<Service>,
    #[serde(default)]
    pub links: Vec<Link>,
    /// Règles valables pour tout le projet.
    #[serde(default)]
    pub rules: Vec<String>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Service {
    /// Identifiant court (`api`, `web`, `nginx`, `db`).
    pub id: String,
    pub name: String,
    /// proxy, frontend, backend, worker, database, cache, queue, external ou autre.
    pub kind: String,
    /// Technologie (« NestJS », « React + Vite », « PostgreSQL 16 »).
    #[serde(default)]
    pub tech: String,
    /// Dossier du service dans le dépôt (`apps/api`), vide s'il n'y a pas de code (base, proxy géré).
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub description: String,
    /// Modèle appliqué (`rest-couches`, `nestjs`…), pour mémoire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Couches internes, de l'entrée (controller) vers les données (repository).
    #[serde(default)]
    pub layers: Vec<Layer>,
    /// Règles propres au service (« pas de logique métier dans les controllers »).
    #[serde(default)]
    pub rules: Vec<String>,
    /// Conventions de nommage et d'organisation (« un fichier par DTO, suffixe .dto.ts »).
    #[serde(default)]
    pub conventions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Layer {
    /// Identifiant court dans le service (`controller`, `dto`).
    pub id: String,
    pub name: String,
    /// Où vit le code de la couche (`src/**/*.controller.ts`, `src/main/java/**/web/`).
    #[serde(default)]
    pub path: String,
    /// Rôle de la couche, en une phrase.
    #[serde(default)]
    pub role: String,
    /// Couches qu'elle a le droit d'utiliser (identifiants) ; les autres lui sont interdites.
    #[serde(default)]
    pub uses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Link {
    /// Service appelant.
    pub from: String,
    /// Service appelé.
    pub to: String,
    /// Protocole ou nature (« HTTPS », « REST /api », « SQL », « WebSocket »).
    #[serde(default)]
    pub label: String,
}

fn check_id(kind: &str, id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !ok {
        bail!("Identifiant de {kind} invalide : « {id} » (minuscules, chiffres, - ou _, 40 au plus).");
    }
    Ok(())
}

/// Vérifie une architecture avant de l'écrire ; messages précis en français.
pub fn validate(a: &Architecture) -> Result<()> {
    let mut ids = HashSet::new();
    for s in &a.services {
        check_id("service", &s.id)?;
        if !ids.insert(s.id.as_str()) {
            bail!("Service en double : « {} ».", s.id);
        }
        if s.name.trim().is_empty() {
            bail!("Le service « {} » n'a pas de nom.", s.id);
        }
        if !KINDS.contains(&s.kind.as_str()) {
            bail!(
                "Nature inconnue pour « {} » : « {} » (attendu : {}).",
                s.name,
                s.kind,
                KINDS.join(", ")
            );
        }
        let mut layers = HashSet::new();
        for l in &s.layers {
            check_id("couche", &l.id)?;
            if !layers.insert(l.id.as_str()) {
                bail!("Couche en double dans « {} » : « {} ».", s.name, l.id);
            }
            if l.name.trim().is_empty() {
                bail!("La couche « {} » de « {} » n'a pas de nom.", l.id, s.name);
            }
        }
        for l in &s.layers {
            if let Some(u) = l
                .uses
                .iter()
                .find(|u| !layers.contains(u.as_str()) || *u == &l.id)
            {
                bail!(
                    "Dans « {} », la couche « {} » utilise « {u} », qui n'existe pas dans ce service (ou est elle-même).",
                    s.name,
                    l.name
                );
            }
        }
    }
    for link in &a.links {
        for end in [&link.from, &link.to] {
            if !ids.contains(end.as_str()) {
                bail!(
                    "Lien {} → {} : le service « {end} » n'existe pas.",
                    link.from,
                    link.to
                );
            }
        }
        if link.from == link.to {
            bail!("Lien de « {} » vers lui-même.", link.from);
        }
    }
    Ok(())
}

pub fn parse(json: &str) -> Result<Architecture> {
    serde_json::from_str(json).context("architecture/architecture.json illisible")
}

/// JSON écrit dans le dépôt (indenté, stable).
pub fn to_json(a: &Architecture) -> String {
    let mut out = serde_json::to_string_pretty(a).unwrap_or_else(|_| "{}".into());
    out.push('\n');
    out
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "proxy" => "Proxy / entrée",
        "frontend" => "Front-end",
        "backend" => "Back-end",
        "worker" => "Tâches de fond",
        "database" => "Base de données",
        "cache" => "Cache",
        "queue" => "File de messages",
        "external" => "Service externe",
        _ => "Autre",
    }
}

fn mermaid_id(id: &str) -> String {
    id.replace('-', "_")
}

fn cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

/// `ARCHITECTURE.md` : vue système (schéma Mermaid, services, liens), puis chaque service.
pub fn render_markdown(a: &Architecture, repo: &str) -> String {
    let mut md = String::new();
    md.push_str("# Architecture\n\n");
    md.push_str(&format!(
        "> Généré par Cadence depuis `{JSON_PATH}` ({repo}). Ne modifiez pas ce fichier à la main : \
         utilisez l'écran Architecture de Cadence (ou modifiez le JSON). Les IA de code suivent cette \
         architecture : couches, dépendances autorisées, règles et conventions.\n\n"
    ));
    md.push_str("## Système\n\n```mermaid\nflowchart LR\n");
    for s in &a.services {
        let tech = if s.tech.is_empty() {
            String::new()
        } else {
            format!("<br/><small>{}</small>", s.tech.replace('"', "'"))
        };
        md.push_str(&format!(
            "  {}[\"{}{}\"]\n",
            mermaid_id(&s.id),
            s.name.replace('"', "'"),
            tech
        ));
    }
    for l in &a.links {
        if l.label.is_empty() {
            md.push_str(&format!("  {} --> {}\n", mermaid_id(&l.from), mermaid_id(&l.to)));
        } else {
            md.push_str(&format!(
                "  {} -->|{}| {}\n",
                mermaid_id(&l.from),
                l.label.replace('|', "/").replace('"', "'"),
                mermaid_id(&l.to)
            ));
        }
    }
    md.push_str(
        "```\n\n| Service | Nature | Technologie | Dossier | Rôle |\n| --- | --- | --- | --- | --- |\n",
    );
    for s in &a.services {
        md.push_str(&format!(
            "| **{}** (`{}`) | {} | {} | {} | {} |\n",
            cell(&s.name),
            s.id,
            kind_label(&s.kind),
            cell(&s.tech),
            if s.path.is_empty() {
                "—".into()
            } else {
                format!("`{}`", s.path)
            },
            cell(&s.description)
        ));
    }
    if !a.rules.is_empty() {
        md.push_str("\n### Règles du projet\n\n");
        for r in &a.rules {
            md.push_str(&format!("- {r}\n"));
        }
    }
    for s in a
        .services
        .iter()
        .filter(|s| !s.layers.is_empty() || !s.rules.is_empty() || !s.conventions.is_empty())
    {
        md.push_str(&format!("\n## {} (`{}`)\n\n", s.name, s.id));
        let mut meta = vec![kind_label(&s.kind).to_string()];
        if !s.tech.is_empty() {
            meta.push(s.tech.clone());
        }
        if !s.path.is_empty() {
            meta.push(format!("`{}`", s.path));
        }
        if let Some(t) = &s.template {
            meta.push(format!("modèle « {t} »"));
        }
        md.push_str(&format!("{}\n\n", meta.join(" · ")));
        if !s.description.is_empty() {
            md.push_str(&format!("{}\n\n", s.description));
        }
        if !s.layers.is_empty() {
            md.push_str("| Couche | Emplacement | Rôle | Peut utiliser |\n| --- | --- | --- | --- |\n");
            for l in &s.layers {
                let uses: Vec<String> = l
                    .uses
                    .iter()
                    .filter_map(|u| s.layers.iter().find(|x| &x.id == u).map(|x| x.name.clone()))
                    .collect();
                md.push_str(&format!(
                    "| **{}** | {} | {} | {} |\n",
                    cell(&l.name),
                    if l.path.is_empty() {
                        "—".into()
                    } else {
                        format!("`{}`", l.path)
                    },
                    cell(&l.role),
                    if uses.is_empty() {
                        "rien".into()
                    } else {
                        uses.join(", ")
                    }
                ));
            }
            md.push_str("\nUne couche n'utilise que celles listées : toute autre dépendance est un écart.\n");
        }
        if !s.rules.is_empty() {
            md.push_str("\n**Règles**\n\n");
            for r in &s.rules {
                md.push_str(&format!("- {r}\n"));
            }
        }
        if !s.conventions.is_empty() {
            md.push_str("\n**Conventions**\n\n");
            for c in &s.conventions {
                md.push_str(&format!("- {c}\n"));
            }
        }
    }
    md
}

/* ---------- Modèles ---------- */

/// Modèle prêt à appliquer : un système complet (`scope: system`) ou l'intérieur d'un service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    /// `system` ou `service`.
    pub scope: String,
    pub description: String,
    /// Pour un modèle de service : nature et technologie proposées.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub tech: String,
    #[serde(default)]
    pub layers: Vec<Layer>,
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default)]
    pub conventions: Vec<String>,
    /// Pour un modèle de système.
    #[serde(default)]
    pub services: Vec<Service>,
    #[serde(default)]
    pub links: Vec<Link>,
}

/// Bibliothèque de modèles livrée avec le plugin (`templates.json`).
pub fn templates() -> Vec<Template> {
    serde_json::from_str(include_str!("templates.json")).unwrap_or_default()
}

/* ---------- Lecture et écriture dans le dépôt ---------- */

/// Où l'architecture a été lue.
#[derive(Debug, Clone, Serialize)]
pub struct Source {
    pub branch: String,
    /// Pull request ouverte de la branche `archi/…`, s'il y en a une.
    pub pull_request: Option<u32>,
    pub url: Option<String>,
}

impl crate::server::GestionProjet {
    /// PR ouverte d'une branche `archi/…` du dépôt : (numéro, branche, lien).
    async fn open_archi_pr(&self, repo: &str) -> Result<Option<(u32, String, String)>> {
        let prs = self
            .gh
            .get(
                &format!("/repos/{repo}/pulls"),
                &[("state", "open".into()), ("per_page", "100".into())],
            )
            .await?;
        Ok(prs.as_array().into_iter().flatten().find_map(|p| {
            let head = p["head"]["ref"].as_str()?;
            head.starts_with(BRANCH_PREFIX).then(|| {
                (
                    p["number"].as_u64().unwrap_or(0) as u32,
                    head.to_string(),
                    p["html_url"].as_str().unwrap_or("").to_string(),
                )
            })
        }))
    }

    /// Branche de base des modifications : release du sprint en cours, sinon branche par défaut.
    async fn archi_base(&self, repo: &str) -> Result<String> {
        if let Some(branch) = self
            .load_project(repo)
            .await?
            .and_then(|p| p.state.current().map(|c| c.branch()))
            && self.branch_sha(repo, &branch).await?.is_some()
        {
            return Ok(branch);
        }
        self.default_branch(repo).await
    }

    /// Architecture du dépôt : celle de la PR `archi/…` ouverte (modifications en cours de revue),
    /// sinon celle de la base. `None` si le dépôt n'en a pas encore.
    pub(crate) async fn load_architecture(&self, repo: &str) -> Result<(Option<Architecture>, Source)> {
        let pr = self.open_archi_pr(repo).await?;
        let branch = match &pr {
            Some((_, head, _)) => head.clone(),
            None => self.archi_base(repo).await?,
        };
        let source = Source {
            branch: branch.clone(),
            pull_request: pr.as_ref().map(|(n, _, _)| *n),
            url: pr.map(|(_, _, url)| url),
        };
        let exists = self
            .gh
            .get_opt(
                &format!("/repos/{repo}/contents/{JSON_PATH}"),
                &[("ref", branch.clone())],
            )
            .await?
            .is_some();
        if !exists {
            return Ok((None, source));
        }
        let bytes = self.file_bytes(repo, JSON_PATH, &branch).await?;
        Ok((Some(parse(&String::from_utf8_lossy(&bytes))?), source))
    }

    /// Écrit un fichier sur une branche (création ou mise à jour), un commit par fichier.
    async fn put_file(
        &self,
        repo: &str,
        path: &str,
        branch: &str,
        content: &str,
        message: &str,
    ) -> Result<()> {
        use base64::Engine as _;
        let sha = self
            .gh
            .get_opt(
                &format!("/repos/{repo}/contents/{path}"),
                &[("ref", branch.to_string())],
            )
            .await?
            .and_then(|f| f["sha"].as_str().map(str::to_string));
        let mut body = serde_json::json!({
            "message": message,
            "branch": branch,
            "content": base64::engine::general_purpose::STANDARD.encode(content.as_bytes()),
        });
        if let Some(sha) = sha {
            body["sha"] = serde_json::json!(sha);
        }
        self.gh
            .put(&format!("/repos/{repo}/contents/{path}"), &body)
            .await?;
        Ok(())
    }

    /// Enregistre l'architecture : commit du JSON et du Markdown sur la branche `archi/…` de la PR
    /// ouverte, ou sur une nouvelle branche partant de la base, puis PR (ouverte si besoin).
    pub(crate) async fn save_architecture(
        &self,
        repo: &str,
        a: &Architecture,
        message: &str,
    ) -> Result<Source> {
        validate(a)?;
        let message = message.trim();
        let message = if message.is_empty() {
            "mise à jour"
        } else {
            message
        };
        let _guard = self.engine_lock.lock().await;
        let open = self.open_archi_pr(repo).await?;
        let base = self.archi_base(repo).await?;
        let branch = match &open {
            Some((_, head, _)) => head.clone(),
            None => {
                let mut n = 1;
                let today = crate::sprint::today();
                let mut name = format!("{BRANCH_PREFIX}{today}");
                while self.branch_sha(repo, &name).await?.is_some() {
                    n += 1;
                    name = format!("{BRANCH_PREFIX}{today}-{n}");
                }
                self.ensure_branch(repo, &name, &base).await?;
                name
            }
        };
        let commit = format!("architecture: {message}");
        self.put_file(repo, JSON_PATH, &branch, &to_json(a), &commit)
            .await?;
        self.put_file(repo, MD_PATH, &branch, &render_markdown(a, repo), &commit)
            .await?;
        let (number, url) = match open {
            Some((n, _, url)) => (n, url),
            None => {
                let pr = self
                    .gh
                    .post(
                        &format!("/repos/{repo}/pulls"),
                        &serde_json::json!({
                            "title": format!("architecture : {message}"),
                            "head": branch,
                            "base": base,
                            "draft": false,
                            "body": "Modification de l'architecture du projet depuis l'écran Architecture de Cadence.\n\n\
                                     - `architecture/architecture.json` : la source, lue par les IA de code ;\n\
                                     - `architecture/ARCHITECTURE.md` : la version lisible (schéma Mermaid).\n\n\
                                     Les modifications suivantes s'ajoutent à cette PR tant qu'elle est ouverte.\n\n\
                                     _PR ouverte par Cadence (plugin Gestion de projet)._",
                        }),
                    )
                    .await?;
                (
                    pr["number"].as_u64().unwrap_or(0) as u32,
                    pr["html_url"].as_str().unwrap_or("").to_string(),
                )
            }
        };
        Ok(Source {
            branch,
            pull_request: Some(number),
            url: Some(url),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Architecture {
        let rest = templates().into_iter().find(|t| t.id == "rest-couches").unwrap();
        Architecture {
            version: 1,
            services: vec![
                Service {
                    id: "nginx".into(),
                    name: "Nginx".into(),
                    kind: "proxy".into(),
                    tech: "Nginx".into(),
                    path: "deploy/nginx".into(),
                    description: "Entrée HTTPS".into(),
                    template: None,
                    layers: vec![],
                    rules: vec![],
                    conventions: vec![],
                },
                Service {
                    id: "api".into(),
                    name: "API".into(),
                    kind: "backend".into(),
                    tech: "NestJS".into(),
                    path: "apps/api".into(),
                    description: String::new(),
                    template: Some(rest.id.clone()),
                    layers: rest.layers.clone(),
                    rules: rest.rules.clone(),
                    conventions: vec![],
                },
            ],
            links: vec![Link {
                from: "nginx".into(),
                to: "api".into(),
                label: "REST /api".into(),
            }],
            rules: vec!["Pas de secret dans le dépôt.".into()],
        }
    }

    #[test]
    fn ships_valid_templates() {
        let all = templates();
        assert!(all.len() >= 10, "{} modèles", all.len());
        for t in &all {
            let a = if t.scope == "system" {
                Architecture {
                    version: 1,
                    services: t.services.clone(),
                    links: t.links.clone(),
                    rules: t.rules.clone(),
                }
            } else {
                Architecture {
                    version: 1,
                    services: vec![Service {
                        id: "svc".into(),
                        name: "Service".into(),
                        kind: t.kind.clone(),
                        tech: t.tech.clone(),
                        path: String::new(),
                        description: String::new(),
                        template: Some(t.id.clone()),
                        layers: t.layers.clone(),
                        rules: t.rules.clone(),
                        conventions: t.conventions.clone(),
                    }],
                    links: vec![],
                    rules: vec![],
                }
            };
            validate(&a).unwrap_or_else(|e| panic!("modèle {} : {e}", t.id));
        }
    }

    #[test]
    fn renders_markdown_with_a_mermaid_system_view() {
        let a = sample();
        validate(&a).unwrap();
        let md = render_markdown(&a, "me/app");
        assert!(md.contains("flowchart LR"));
        assert!(md.contains("  nginx -->|REST /api| api"));
        assert!(md.contains("| **API** (`api`) | Back-end | NestJS | `apps/api` |"));
        assert!(md.contains("## API (`api`)"));
        assert!(md.contains("| **Controller** |"));
        assert_eq!(parse(&to_json(&a)).unwrap(), a);
    }

    #[test]
    fn explains_what_is_wrong() {
        let err = |a: &Architecture| validate(a).unwrap_err().to_string();
        let mut a = sample();
        a.links[0].to = "db".into();
        assert!(err(&a).contains("le service « db » n'existe pas"));
        let mut a = sample();
        a.services[1].layers[0].uses.push("inconnue".into());
        assert!(err(&a).contains("utilise « inconnue »"), "{}", err(&a));
        let mut a = sample();
        a.services[0].kind = "serveur".into();
        assert!(err(&a).contains("Nature inconnue"));
        let mut a = sample();
        a.services[1].id = "Api".into();
        assert!(err(&a).contains("Identifiant de service invalide"));
    }
}
