//! Client REST GitHub minimal : jeton porteur, erreurs lisibles, pagination par en-tête `Link`.

use anyhow::{Context, Result, anyhow, bail};
use reqwest::{Method, StatusCode, header::HeaderMap};
use serde_json::Value;

pub struct GitHub {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

/// Réponse JSON et indicateur de page suivante.
pub struct Page {
    pub body: Value,
    pub has_next: bool,
}

impl GitHub {
    pub fn new(base: &str, token: Option<String>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("cadence-gestion-projet/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("client HTTP")?;
        Ok(GitHub {
            http,
            base: base.trim_end_matches('/').to_string(),
            token,
        })
    }

    pub async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        Ok(self.send(Method::GET, path, query, None).await?.body)
    }

    pub async fn get_page(&self, path: &str, query: &[(&str, String)]) -> Result<Page> {
        self.send(Method::GET, path, query, None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        Ok(self.send(Method::POST, path, &[], Some(body)).await?.body)
    }

    pub async fn patch(&self, path: &str, body: &Value) -> Result<Value> {
        Ok(self.send(Method::PATCH, path, &[], Some(body)).await?.body)
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Page> {
        let token = self.token.as_deref().ok_or_else(|| {
            anyhow!("Jeton GitHub absent : renseignez-le dans l'étape « Compte GitHub » du plugin Gestion de projet.")
        })?;
        let mut req = self
            .http
            .request(method.clone(), format!("{}{path}", self.base))
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        let res = req
            .send()
            .await
            .with_context(|| format!("GitHub injoignable ({method} {path})"))?;
        let status = res.status();
        let headers = res.headers().clone();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!(describe_error(status, &headers, &text, path));
        }
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text)?
        };
        Ok(Page {
            body,
            has_next: has_next(&headers),
        })
    }
}

fn has_next(headers: &HeaderMap) -> bool {
    headers
        .get("link")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|l| l.contains("rel=\"next\""))
}

/// Message d'erreur en français, avec la raison donnée par GitHub.
pub fn describe_error(status: StatusCode, headers: &HeaderMap, body: &str, path: &str) -> String {
    let json: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let message = json["message"].as_str().unwrap_or("").to_string();
    let details: Vec<String> = json["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            e["message"]
                .as_str()
                .map(str::to_string)
                .or_else(|| e["code"].as_str().map(str::to_string))
        })
        .collect();
    let remaining = headers.get("x-ratelimit-remaining").and_then(|v| v.to_str().ok());
    match status.as_u16() {
        401 => "Jeton GitHub refusé (401) : il a expiré ou a été révoqué.".into(),
        403 | 429 if remaining == Some("0") => {
            let reset = headers
                .get("x-ratelimit-reset")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("?");
            format!(
                "Quota de l'API GitHub épuisé : réessayez après la réinitialisation (horodatage {reset})."
            )
        }
        403 => format!("Accès refusé par GitHub (403) : {message}"),
        404 => {
            format!("Introuvable sur GitHub (404) : {path}. Vérifiez le dépôt réglé et les droits du jeton.")
        }
        422 => format!(
            "GitHub a refusé la requête (422) : {message}{}",
            if details.is_empty() {
                String::new()
            } else {
                format!(" — {}", details.join(", "))
            }
        ),
        code => format!("Erreur GitHub {code} sur {path} : {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn explains_errors_in_french() {
        let mut h = HeaderMap::new();
        assert!(describe_error(StatusCode::UNAUTHORIZED, &h, "", "/user").contains("expiré"));
        let body = r#"{"message": "Validation Failed", "errors": [{"code": "missing_field"}]}"#;
        assert_eq!(
            describe_error(StatusCode::UNPROCESSABLE_ENTITY, &h, body, "/x"),
            "GitHub a refusé la requête (422) : Validation Failed — missing_field"
        );
        h.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
        assert!(describe_error(StatusCode::FORBIDDEN, &h, "{}", "/x").starts_with("Quota"));
    }

    #[test]
    fn reads_the_link_header() {
        let mut h = HeaderMap::new();
        assert!(!has_next(&h));
        h.insert(
            "link",
            HeaderValue::from_static("<https://api.github.com/x?page=2>; rel=\"next\""),
        );
        assert!(has_next(&h));
    }
}
