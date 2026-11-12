//! Documents du projet : cahier des charges, sujet, fiches de mission, données attendues,
//! comptes-rendus… rangés dans le dépôt, sur la branche par défaut, sous le dossier
//! `documents_dir` (réglage, `docs/intern` par défaut). Ils sont donc partagés avec toute
//! l'équipe et versionnés comme le reste du projet.
//!
//! - Lecture : arbre Git de la branche par défaut (`GET /git/trees/{branche}?recursive=1`), puis
//!   blobs (`GET /git/blobs/{sha}`), gardés en cache local par sha (`CADENCE_DATA_DIR`).
//! - Écriture : un commit par opération (dépôt de fichiers, dossier, renommage, suppression)
//!   avec l'API Git de GitHub (blobs, arbre, commit, avance de la branche). Un ZIP déposé est
//!   décompressé dans un sous-dossier à son nom. Un dossier vide garde un `.gitkeep`.
//! - IA : texte de chaque document (PDF, Word, PowerPoint, Markdown, texte, CSV, Excel) découpé
//!   en pages, et recherche plein texte, pour piocher dans les documents sans qu'on les envoie.

use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::github::GitHub;

/// Dossier des documents par défaut (réglage `documents_dir`).
pub const DEFAULT_DIR: &str = "docs/intern";
/// Fichier qui garde un dossier vide dans Git (masqué des listes).
pub const KEEP: &str = ".gitkeep";
/// Dossiers proposés à la création (renommables, supprimables).
pub const TEMPLATE_FOLDERS: &[&str] = &[
    "Sujet et cahier des charges",
    "Missions",
    "Données",
    "Comptes-rendus",
    "Divers",
];
/// GitHub refuse les fichiers de plus de 100 Mo.
pub const MAX_FILE: usize = 95 * 1024 * 1024;
/// Taille d'un morceau lu par la visionneuse (`docs_bytes`).
pub const CHUNK: usize = 2 * 1024 * 1024;
/// Texte rendu au plus par `docs_read` en une fois.
pub const READ_CHARS: usize = 12_000;
/// Lignes d'un tableau (CSV, Excel) rendues au plus.
pub const TABLE_ROWS: usize = 200;
/// Fichiers ajoutés au plus par un ZIP.
const ZIP_MAX_FILES: usize = 2_000;

/* ---------- Chemins ---------- */

/// Dossier des documents validé (`docs/intern`) : relatif, sans `..`, sans `/` final.
pub fn root_dir(setting: &str) -> String {
    clean_rel(setting).unwrap_or_else(|_| DEFAULT_DIR.to_string())
}

/// Chemin relatif validé : séparateurs `/`, sans `.` ni `..`, sans nom vide ni caractère de
/// contrôle. `\` est accepté et converti (chemins Windows).
pub fn clean_rel(path: &str) -> Result<String> {
    let path = path.replace('\\', "/");
    let parts: Vec<&str> = path.split('/').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        bail!("Chemin vide.");
    }
    for part in &parts {
        if *part == "." || *part == ".." {
            bail!("Chemin invalide : « {path} » (« . » et « .. » interdits).");
        }
        if part
            .chars()
            .any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            bail!("Nom invalide : « {part} » (caractères : * ? \" < > | interdits).");
        }
        if part.len() > 200 {
            bail!("Nom trop long : « {part} ».");
        }
    }
    Ok(parts.join("/"))
}

/// Chemin optionnel (racine des documents si vide).
pub fn clean_opt(path: Option<&str>) -> Result<String> {
    match path.map(str::trim).filter(|p| !p.is_empty() && *p != "/") {
        Some(p) => clean_rel(p),
        None => Ok(String::new()),
    }
}

fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}/{b}"),
    }
}

/* ---------- Formats ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pdf,
    Word,
    Powerpoint,
    Markdown,
    Text,
    Csv,
    Excel,
    Image,
    Other,
}

const TEXT_EXT: &[&str] = &[
    "txt", "text", "json", "yaml", "yml", "xml", "html", "htm", "sql", "log", "ini", "toml", "tsv", "py",
    "js", "ts", "java", "rs", "go", "c", "cpp", "cs", "php", "rb", "sh", "css",
];

pub fn kind_of(path: &str) -> Kind {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => Kind::Pdf,
        "docx" => Kind::Word,
        "pptx" => Kind::Powerpoint,
        "md" | "markdown" => Kind::Markdown,
        "csv" => Kind::Csv,
        "xlsx" | "xlsm" | "xls" | "ods" => Kind::Excel,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" => Kind::Image,
        e if TEXT_EXT.contains(&e) => Kind::Text,
        _ => Kind::Other,
    }
}

/// Type MIME pour la visionneuse.
pub fn mime_of(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "csv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        _ if kind_of(path) == Kind::Text => "text/plain",
        _ => "application/octet-stream",
    }
}

/* ---------- Arbre ---------- */

/// Entrée de la liste des documents ; `path` relatif au dossier des documents.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub folder: bool,
    pub size: u64,
    pub sha: String,
    pub kind: Option<Kind>,
}

/// Branche par défaut du dépôt.
pub async fn default_branch(gh: &GitHub, repo: &str) -> Result<String> {
    let r = gh.get(&format!("/repos/{repo}"), &[]).await?;
    Ok(r["default_branch"].as_str().unwrap_or("main").to_string())
}

/// Documents (fichiers et dossiers) sous `root`, triés : dossiers d'abord, puis par nom.
/// Un dépôt vide (aucun commit) ou sans dossier des documents rend une liste vide.
pub async fn list(gh: &GitHub, repo: &str, branch: &str, root: &str) -> Result<Vec<Entry>> {
    let tree = match gh
        .get_opt(
            &format!("/repos/{repo}/git/trees/{branch}"),
            &[("recursive", "1".into())],
        )
        .await
    {
        Ok(Some(t)) => t,
        Ok(None) => return Ok(Vec::new()),
        Err(err) if format!("{err:#}").contains("409") => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let prefix = format!("{root}/");
    let mut entries: Vec<Entry> = tree["tree"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let full = e["path"].as_str()?;
            let rel = full.strip_prefix(&prefix)?;
            let folder = e["type"] == "tree";
            if !folder && (rel == KEEP || rel.ends_with(&format!("/{KEEP}"))) {
                return None;
            }
            let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
            Some(Entry {
                path: rel.to_string(),
                name,
                folder,
                size: e["size"].as_u64().unwrap_or(0),
                sha: e["sha"].as_str().unwrap_or_default().to_string(),
                kind: (!folder).then(|| kind_of(rel)),
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        let key = |e: &Entry| {
            (
                e.path
                    .rsplit_once('/')
                    .map(|(p, _)| p.to_string())
                    .unwrap_or_default(),
                !e.folder,
                e.name.to_lowercase(),
            )
        };
        key(a).cmp(&key(b))
    });
    Ok(entries)
}

/// Fichier `path` (relatif aux documents) dans la liste, ou erreur lisible.
pub fn find<'a>(entries: &'a [Entry], path: &str) -> Result<&'a Entry> {
    entries
        .iter()
        .find(|e| !e.folder && e.path == path)
        .ok_or_else(|| anyhow!("Document introuvable : « {path} ». Appelez docs_list pour la liste."))
}

/* ---------- Écriture (un commit par opération) ---------- */

pub enum Change {
    /// Nouveau contenu.
    Put {
        path: String,
        content: Vec<u8>,
    },
    /// Blob existant à un nouveau chemin (renommage).
    Copy {
        path: String,
        sha: String,
    },
    Delete {
        path: String,
    },
}

/// Applique `changes` (chemins complets dans le dépôt) en un commit sur `branch`.
/// Réessaie si la branche a avancé entre-temps (push concurrent d'un coéquipier).
pub async fn commit(
    gh: &GitHub,
    repo: &str,
    branch: &str,
    changes: Vec<Change>,
    message: &str,
) -> Result<String> {
    if changes.is_empty() {
        bail!("Rien à enregistrer.");
    }
    // Blobs d'abord (une fois) : seuls les arbres et le commit dépendent de la tête de branche.
    let mut items: Vec<Value> = Vec::with_capacity(changes.len());
    for change in changes {
        items.push(match change {
            Change::Put { path, content } => {
                if content.len() > MAX_FILE {
                    bail!(
                        "« {path} » fait {} Mo : GitHub refuse les fichiers de plus de 100 Mo.",
                        content.len() / (1024 * 1024)
                    );
                }
                let blob = gh
                    .post(
                        &format!("/repos/{repo}/git/blobs"),
                        &json!({
                            "content": base64::engine::general_purpose::STANDARD.encode(&content),
                            "encoding": "base64",
                        }),
                    )
                    .await
                    .with_context(|| format!("envoi de « {path} »"))?;
                json!({ "path": path, "mode": "100644", "type": "blob", "sha": blob["sha"] })
            }
            Change::Copy { path, sha } => {
                json!({ "path": path, "mode": "100644", "type": "blob", "sha": sha })
            }
            Change::Delete { path } => json!({ "path": path, "mode": "100644", "type": "blob", "sha": null }),
        });
    }
    let mut last_err = None;
    for _ in 0..3 {
        let head = match gh
            .get_opt(&format!("/repos/{repo}/git/ref/heads/{branch}"), &[])
            .await
        {
            Ok(Some(r)) => r["object"]["sha"].as_str().unwrap_or_default().to_string(),
            Ok(None) => bail!(empty_repo_message()),
            Err(err) if format!("{err:#}").contains("409") => bail!(empty_repo_message()),
            Err(err) => return Err(err),
        };
        let parent = gh.get(&format!("/repos/{repo}/git/commits/{head}"), &[]).await?;
        let tree = gh
            .post(
                &format!("/repos/{repo}/git/trees"),
                &json!({ "base_tree": parent["tree"]["sha"], "tree": items }),
            )
            .await?;
        let commit = gh
            .post(
                &format!("/repos/{repo}/git/commits"),
                &json!({ "message": message, "tree": tree["sha"], "parents": [head] }),
            )
            .await?;
        let sha = commit["sha"].as_str().unwrap_or_default().to_string();
        match gh
            .patch(
                &format!("/repos/{repo}/git/refs/heads/{branch}"),
                &json!({ "sha": sha, "force": false }),
            )
            .await
        {
            Ok(_) => return Ok(sha),
            // 422 : la branche a avancé (« not a fast forward ») ; on rejoue sur la nouvelle tête.
            Err(err) if format!("{err:#}").contains("422") => last_err = Some(err),
            Err(err) => {
                return Err(err.context(format!(
                    "Impossible d'écrire sur la branche « {branch} » (branche protégée ?)."
                )));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("Écriture refusée par GitHub.")))
}

fn empty_repo_message() -> String {
    "Le dépôt est vide (aucun commit) : créez-y un premier fichier (README) avant d'y ranger des documents."
        .into()
}

/// Fichier déposé : nom (avec extension) et contenu.
pub struct Upload {
    pub name: String,
    pub content: Vec<u8>,
}

/// Fichiers à écrire pour un dépôt dans `folder` (chemin complet) : un ZIP est décompressé dans
/// un sous-dossier à son nom (sans les dossiers techniques `__MACOSX`, `.DS_Store`…).
pub fn expand_uploads(folder: &str, uploads: Vec<Upload>) -> Result<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    for up in uploads {
        let name = clean_rel(&up.name)?;
        let name = name.rsplit('/').next().unwrap_or(&name).to_string();
        let is_zip = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
        if !is_zip {
            out.push((join(folder, &name), up.content));
            continue;
        }
        let stem = Path::new(&name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("archive")
            .to_string();
        let base = join(folder, &stem);
        let mut archive = zip::ZipArchive::new(Cursor::new(up.content))
            .with_context(|| format!("« {name} » n'est pas un ZIP lisible"))?;
        let before = out.len();
        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            if file.is_dir() {
                continue;
            }
            let Some(inner) = file.enclosed_name() else {
                continue;
            };
            let inner = inner.to_string_lossy().replace('\\', "/");
            if inner
                .split('/')
                .any(|p| p == "__MACOSX" || p == ".DS_Store" || p.starts_with("._"))
            {
                continue;
            }
            if out.len() - before >= ZIP_MAX_FILES {
                bail!("« {name} » contient plus de {ZIP_MAX_FILES} fichiers.");
            }
            let size = file.size() as usize;
            if size > MAX_FILE {
                bail!("« {inner} » (dans {name}) dépasse 100 Mo.");
            }
            let mut content = Vec::with_capacity(size);
            file.read_to_end(&mut content)?;
            let inner = clean_rel(&inner).with_context(|| format!("dans {name}"))?;
            out.push((join(&base, &inner), content));
        }
        if out.len() == before {
            bail!("« {name} » est vide.");
        }
    }
    Ok(out)
}

/* ---------- Lecture ---------- */

fn cache_dir() -> PathBuf {
    std::env::var_os("CADENCE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("docs-cache")
}

fn safe_sha(sha: &str) -> Result<&str> {
    if sha.len() >= 7 && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(sha)
    } else {
        bail!("Identifiant de blob invalide.")
    }
}

/// Contenu d'un blob, depuis le cache local (par sha) ou GitHub.
pub async fn blob(gh: &GitHub, repo: &str, sha: &str) -> Result<Vec<u8>> {
    let sha = safe_sha(sha)?;
    let path = cache_dir().join(sha);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return Ok(bytes);
    }
    let b = gh.get(&format!("/repos/{repo}/git/blobs/{sha}"), &[]).await?;
    let encoded: String = b["content"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("blob GitHub illisible")?;
    let _ = tokio::fs::create_dir_all(cache_dir()).await;
    let _ = tokio::fs::write(&path, &bytes).await;
    Ok(bytes)
}

/// Tableau lu dans un CSV ou une feuille Excel.
#[derive(Debug, Clone, Serialize)]
pub struct Table {
    pub sheets: Vec<String>,
    pub sheet: Option<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// Lignes de données au total (hors en-tête).
    pub total: usize,
}

/// Séparateur d'un CSV : `;` (Excel en français), tabulation ou `,`, d'après la première ligne.
fn csv_delimiter(bytes: &[u8]) -> u8 {
    let first = bytes.split(|b| *b == b'\n').next().unwrap_or_default();
    let count = |d: u8| first.iter().filter(|b| **b == d).count();
    (*b";\t,")
        .into_iter()
        .max_by_key(|d| count(*d))
        .filter(|d| count(*d) > 0)
        .unwrap_or(b',')
}

pub fn csv_table(bytes: &[u8], limit: usize) -> Result<Table> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start_matches('\u{feff}');
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(csv_delimiter(text.as_bytes()))
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut records = reader.records();
    let columns: Vec<String> = match records.next() {
        Some(r) => r?.iter().map(str::to_string).collect(),
        None => Vec::new(),
    };
    let mut rows = Vec::new();
    let mut total = 0;
    for r in records {
        let r = r?;
        total += 1;
        if rows.len() < limit {
            rows.push(r.iter().map(str::to_string).collect());
        }
    }
    Ok(Table {
        sheets: Vec::new(),
        sheet: None,
        columns,
        rows,
        total,
    })
}

pub fn excel_table(bytes: &[u8], sheet: Option<&str>, limit: usize) -> Result<Table> {
    use calamine::{Reader, open_workbook_auto_from_rs};
    let mut wb = open_workbook_auto_from_rs(Cursor::new(bytes.to_vec())).context("classeur illisible")?;
    let sheets = wb.sheet_names().to_vec();
    let name = match sheet {
        Some(s) if sheets.iter().any(|n| n == s) => s.to_string(),
        Some(s) => bail!("Feuille « {s} » absente. Feuilles : {}.", sheets.join(", ")),
        None => sheets
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("Classeur sans feuille."))?,
    };
    let range = wb
        .worksheet_range(&name)
        .with_context(|| format!("feuille « {name} »"))?;
    let mut iter = range.rows();
    let columns: Vec<String> = iter
        .next()
        .map(|r| r.iter().map(|c| c.to_string()).collect())
        .unwrap_or_default();
    let mut rows = Vec::new();
    let mut total = 0;
    for r in iter {
        total += 1;
        if rows.len() < limit {
            rows.push(r.iter().map(|c| c.to_string()).collect());
        }
    }
    Ok(Table {
        sheets,
        sheet: Some(name),
        columns,
        rows,
        total,
    })
}

/// Tableau en Markdown (cellules échappées, retours à la ligne aplatis).
pub fn table_markdown(t: &Table) -> String {
    let cell = |s: &str| s.replace('|', "\\|").replace(['\n', '\r'], " ");
    let width = t
        .rows
        .iter()
        .map(Vec::len)
        .chain([t.columns.len()])
        .max()
        .unwrap_or(0);
    if width == 0 {
        return "(tableau vide)".into();
    }
    let pad = |r: &[String]| {
        (0..width)
            .map(|i| cell(r.get(i).map(String::as_str).unwrap_or("")))
            .collect::<Vec<_>>()
    };
    let mut out = format!(
        "| {} |\n|{}|\n",
        pad(&t.columns).join(" | "),
        vec!["---"; width].join("|")
    );
    for r in &t.rows {
        out.push_str(&format!("| {} |\n", pad(r).join(" | ")));
    }
    if t.total > t.rows.len() {
        out.push_str(&format!(
            "\n… {} lignes au total, {} affichées.\n",
            t.total,
            t.rows.len()
        ));
    }
    out
}

/// Texte d'un document, découpé en pages (PDF : pages ; PowerPoint : diapositives ; tableaux :
/// une feuille par page ; texte et Word : blocs d'environ 3000 caractères). `None` : format sans
/// texte lisible (image, binaire).
pub fn pages_of(path: &str, bytes: &[u8]) -> Result<Option<Vec<String>>> {
    use cadence_extract::{DocKind, extract_bytes};
    let pages = match kind_of(path) {
        Kind::Pdf => extract_bytes(DocKind::Pdf, bytes)?,
        Kind::Word => extract_bytes(DocKind::Docx, bytes)?,
        Kind::Powerpoint => extract_bytes(DocKind::Pptx, bytes)?,
        Kind::Markdown => extract_bytes(DocKind::Markdown, bytes)?,
        Kind::Text => extract_bytes(DocKind::Text, bytes)?,
        Kind::Csv => vec![table_markdown(&csv_table(bytes, TABLE_ROWS)?)],
        Kind::Excel => {
            let first = excel_table(bytes, None, TABLE_ROWS)?;
            let mut pages = Vec::new();
            for name in &first.sheets {
                let t = excel_table(bytes, Some(name), TABLE_ROWS)?;
                pages.push(format!("Feuille « {name} »\n\n{}", table_markdown(&t)));
            }
            pages
        }
        Kind::Image | Kind::Other => return Ok(None),
    };
    Ok(Some(pages))
}

/// Pages en cache (JSON par sha), extraites au besoin.
pub async fn cached_pages(gh: &GitHub, repo: &str, entry: &Entry) -> Result<Option<Vec<String>>> {
    let sha = safe_sha(&entry.sha)?;
    let path = cache_dir().join(format!("{sha}.pages.json"));
    if let Ok(json) = tokio::fs::read_to_string(&path).await
        && let Ok(pages) = serde_json::from_str::<Option<Vec<String>>>(&json)
    {
        return Ok(pages);
    }
    let bytes = blob(gh, repo, sha).await?;
    let name = entry.path.clone();
    let pages = tokio::task::spawn_blocking(move || pages_of(&name, &bytes))
        .await
        .map_err(|e| anyhow!("extraction interrompue : {e}"))??;
    let _ = tokio::fs::create_dir_all(cache_dir()).await;
    let _ = tokio::fs::write(&path, serde_json::to_string(&pages)?).await;
    Ok(pages)
}

/// Extrait de `text` autour de la première occurrence de `needle` (minuscules).
pub fn snippet(text: &str, needle: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let at = lower.find(needle)?;
    // Positions en caractères (le texte en minuscules peut changer de longueur en octets).
    let chars: Vec<char> = text.chars().collect();
    let at_char = lower[..at].chars().count();
    let start = at_char.saturating_sub(120);
    let end = (at_char + needle.chars().count() + 160).min(chars.len());
    let mut s: String = chars[start..end].iter().collect::<String>().replace('\n', " ");
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s.push('…');
    }
    Some(s)
}

/// Taille lisible : « 1,2 Mo », « 340 Ko ».
pub fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} Mo", bytes as f64 / (1024.0 * 1024.0)).replace('.', ",")
    } else if bytes >= 1024 {
        format!("{} Ko", bytes / 1024)
    } else {
        format!("{bytes} o")
    }
}

/// Arborescence en texte pour l'IA (« Missions/fiche-1.pdf (PDF, 340 Ko) »).
pub fn outline(entries: &[Entry]) -> String {
    let mut lines = Vec::new();
    for e in entries {
        let depth = e.path.matches('/').count();
        let indent = "  ".repeat(depth);
        if e.folder {
            lines.push(format!("{indent}{}/", e.name));
        } else {
            let kind = e.kind.map(kind_label).unwrap_or("fichier");
            lines.push(format!("{indent}{} ({kind}, {})", e.name, human_size(e.size)));
        }
    }
    lines.join("\n")
}

pub fn kind_label(kind: Kind) -> &'static str {
    match kind {
        Kind::Pdf => "PDF",
        Kind::Word => "Word",
        Kind::Powerpoint => "PowerPoint",
        Kind::Markdown => "Markdown",
        Kind::Text => "texte",
        Kind::Csv => "CSV",
        Kind::Excel => "Excel",
        Kind::Image => "image",
        Kind::Other => "fichier",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn validates_paths() {
        assert_eq!(
            clean_rel(" Missions / fiche 1.pdf ").unwrap(),
            "Missions/fiche 1.pdf"
        );
        assert_eq!(clean_rel("a\\b").unwrap(), "a/b");
        for bad in ["", "/", "../x", "a/./b", "a/../../b", "x?.pdf", "a:b"] {
            assert!(clean_rel(bad).is_err(), "{bad}");
        }
        assert_eq!(root_dir("../hors"), DEFAULT_DIR);
        assert_eq!(root_dir("docs/intern/"), "docs/intern");
        assert_eq!(clean_opt(Some("  ")).unwrap(), "");
    }

    #[test]
    fn recognizes_kinds() {
        assert_eq!(kind_of("a/Sujet.PDF"), Kind::Pdf);
        assert_eq!(kind_of("donnees.xlsx"), Kind::Excel);
        assert_eq!(kind_of("export.csv"), Kind::Csv);
        assert_eq!(kind_of("notes.json"), Kind::Text);
        assert_eq!(kind_of("schema.png"), Kind::Image);
        assert_eq!(kind_of("archive.7z"), Kind::Other);
        assert_eq!(mime_of("x.pdf"), "application/pdf");
    }

    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(content).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn expands_zips_into_a_folder() {
        let zip = zip_bytes(&[
            ("modalites/grille.csv", b"a;b\n1;2"),
            ("__MACOSX/._grille.csv", b"x"),
            ("sujet.md", b"# Sujet"),
        ]);
        let files = expand_uploads(
            "docs/intern/Missions",
            vec![
                Upload {
                    name: "Livrables.zip".into(),
                    content: zip,
                },
                Upload {
                    name: "fiche.pdf".into(),
                    content: b"%PDF".to_vec(),
                },
            ],
        )
        .unwrap();
        let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            paths,
            [
                "docs/intern/Missions/Livrables/modalites/grille.csv",
                "docs/intern/Missions/Livrables/sujet.md",
                "docs/intern/Missions/fiche.pdf",
            ]
        );
        assert!(
            expand_uploads(
                "d",
                vec![Upload {
                    name: "x.zip".into(),
                    content: b"pas un zip".to_vec()
                }]
            )
            .is_err()
        );
    }

    #[test]
    fn reads_csv_with_french_separator() {
        let t = csv_table("\u{feff}nom;âge\nAda;36\nAlan;41\n".as_bytes(), 1).unwrap();
        assert_eq!(t.columns, ["nom", "âge"]);
        assert_eq!(t.rows, [["Ada", "36"]]);
        assert_eq!(t.total, 2);
        let md = table_markdown(&t);
        assert!(md.contains("| nom | âge |"), "{md}");
        assert!(md.contains("2 lignes au total"), "{md}");
    }

    #[test]
    fn extracts_pages_by_format() {
        use cadence_extract::tests::{docx, pdf};
        let pages = pages_of("Sujet.pdf", &pdf(&["Contexte du projet", "Livrables attendus"]))
            .unwrap()
            .unwrap();
        assert_eq!(pages.len(), 2);
        assert!(pages[1].contains("Livrables"));
        let pages = pages_of("fiche.docx", &docx(&["Mission : POC CRM"]))
            .unwrap()
            .unwrap();
        assert!(pages[0].contains("POC CRM"));
        let pages = pages_of("data.csv", b"col1,col2\n1,2").unwrap().unwrap();
        assert!(pages[0].contains("| col1 | col2 |"));
        assert!(pages_of("photo.png", b"...").unwrap().is_none());
    }

    #[test]
    fn makes_snippets_and_outline() {
        let s = snippet("Le livrable final est une API REST documentée.", "api rest").unwrap();
        assert!(s.contains("API REST"));
        assert!(snippet("rien", "absent").is_none());
        let entries = vec![
            Entry {
                path: "Missions".into(),
                name: "Missions".into(),
                folder: true,
                size: 0,
                sha: "a".repeat(40),
                kind: None,
            },
            Entry {
                path: "Missions/fiche.pdf".into(),
                name: "fiche.pdf".into(),
                folder: false,
                size: 2048,
                sha: "b".repeat(40),
                kind: Some(Kind::Pdf),
            },
        ];
        assert_eq!(outline(&entries), "Missions/\n  fiche.pdf (PDF, 2 Ko)");
        assert_eq!(human_size(1_572_864), "1,5 Mo");
    }
}
