//! Catégories d'issues : une taxonomie à deux niveaux, domaine › catégorie.
//!
//! - Sur GitHub, une issue porte au plus une catégorie, label `cat/<catégorie>` ; son domaine se
//!   déduit de la taxonomie (les identifiants de catégorie sont uniques tous domaines confondus).
//! - Un domaine peut avoir un **pipeline** (échanges client : à préparer, envoyé, en attente…) :
//!   l'étape de l'issue est le label `etape/<étape>`, et chaque changement d'étape est historisé
//!   par un commentaire.
//! - La taxonomie par défaut vient de `categories.json` (partagé avec l'écran de dev). Chaque
//!   dépôt la complète dans l'état partagé (`CategoryConfig`) : domaines et catégories ajoutés,
//!   éléments par défaut masqués. Toute l'équipe voit donc les mêmes catégories.

use std::collections::HashSet;

use anyhow::{Result, bail};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const CATEGORY_PREFIX: &str = "cat/";
pub const STAGE_PREFIX: &str = "etape/";
/// Longueur maximale d'un identifiant (un label GitHub fait 50 caractères au plus).
const MAX_ID: usize = 40;
const MAX_LABEL: usize = 60;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Stage {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Category {
    /// Identifiant (minuscules, chiffres, tirets), unique tous domaines confondus.
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Domain {
    pub id: String,
    pub label: String,
    /// Couleur `#rrggbb`.
    pub color: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Étapes successives des issues du domaine ; absent : pas de pipeline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<Vec<Stage>>,
    #[serde(default)]
    pub categories: Vec<Category>,
}

/// Catégorie ajoutée à un domaine qui existe déjà (par défaut ou ajouté).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AddedCategory {
    pub domain: String,
    #[serde(flatten)]
    pub category: Category,
}

/// Personnalisation d'un dépôt, rangée dans l'état partagé.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CategoryConfig {
    /// Domaines ajoutés, avec leurs catégories.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub domains: Vec<Domain>,
    /// Catégories ajoutées à un domaine existant.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<AddedCategory>,
    /// Domaines ou catégories par défaut masqués (identifiants) : plus proposés, toujours lus.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden: Vec<String>,
}

impl CategoryConfig {
    pub fn is_empty(&self) -> bool {
        self.domains.is_empty() && self.categories.is_empty() && self.hidden.is_empty()
    }
}

#[derive(Deserialize)]
struct Defaults {
    domains: Vec<Domain>,
}

/// Taxonomie livrée avec le plugin.
pub fn defaults() -> Vec<Domain> {
    serde_json::from_str::<Defaults>(include_str!("categories.json"))
        .map(|d| d.domains)
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CategoryView {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Ajoutée sur ce dépôt (sinon : par défaut).
    pub custom: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DomainView {
    pub id: String,
    pub label: String,
    pub color: String,
    pub description: String,
    pub pipeline: Option<Vec<Stage>>,
    pub custom: bool,
    pub hidden: bool,
    pub categories: Vec<CategoryView>,
}

/// Taxonomie d'un dépôt : défauts, puis domaines ajoutés ; catégories ajoutées à la fin de leur
/// domaine. Les éléments masqués restent (marqués `hidden`) pour afficher les issues qui les
/// portent encore.
pub fn resolve(config: &CategoryConfig) -> Vec<DomainView> {
    let hidden: HashSet<&str> = config.hidden.iter().map(String::as_str).collect();
    let view = |c: &Category, custom: bool| CategoryView {
        id: c.id.clone(),
        label: c.label.clone(),
        description: c.description.clone(),
        custom,
        hidden: !custom && hidden.contains(c.id.as_str()),
    };
    let mut out: Vec<DomainView> = defaults()
        .iter()
        .map(|d| (d, false))
        .chain(config.domains.iter().map(|d| (d, true)))
        .map(|(d, custom)| DomainView {
            id: d.id.clone(),
            label: d.label.clone(),
            color: d.color.clone(),
            description: d.description.clone(),
            pipeline: d.pipeline.clone(),
            custom,
            hidden: !custom && hidden.contains(d.id.as_str()),
            categories: d.categories.iter().map(|c| view(c, custom)).collect(),
        })
        .collect();
    for added in &config.categories {
        if let Some(d) = out.iter_mut().find(|d| d.id == added.domain) {
            d.categories.push(view(&added.category, true));
        }
    }
    out
}

/// Domaine et catégorie d'un identifiant de catégorie.
pub fn find<'a>(domains: &'a [DomainView], id: &str) -> Option<(&'a DomainView, &'a CategoryView)> {
    domains
        .iter()
        .find_map(|d| d.categories.iter().find(|c| c.id == id).map(|c| (d, c)))
}

/// Vrai si `id` est une catégorie par défaut (pas besoin de lire l'état du dépôt).
pub fn is_default(id: &str) -> bool {
    defaults().iter().any(|d| d.categories.iter().any(|c| c.id == id))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && !id.starts_with('-')
        && !id.ends_with('-')
        && !id.contains("--")
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn check_label(what: &str, label: &str) -> Result<()> {
    let n = label.trim().chars().count();
    if n == 0 || n > MAX_LABEL {
        bail!("{what} : nom vide ou trop long ({MAX_LABEL} caractères au plus).");
    }
    Ok(())
}

/// Vérifie une personnalisation avant de l'enregistrer : identifiants valides et uniques
/// (défauts compris), domaines existants, couleurs, étapes. Retourne la config nettoyée
/// (libellés sans espaces superflus, masqués inconnus retirés).
pub fn validate(mut config: CategoryConfig) -> Result<CategoryConfig> {
    let defaults = defaults();
    let mut domain_ids: HashSet<String> = defaults.iter().map(|d| d.id.clone()).collect();
    let mut category_ids: HashSet<String> = defaults
        .iter()
        .flat_map(|d| d.categories.iter().map(|c| c.id.clone()))
        .collect();
    let known: HashSet<String> = domain_ids.union(&category_ids).cloned().collect();

    let mut check_category = |c: &mut Category| -> Result<()> {
        if !valid_id(&c.id) {
            bail!(
                "Catégorie « {} » : identifiant invalide (minuscules, chiffres et tirets, {MAX_ID} caractères au plus).",
                c.id
            );
        }
        check_label(&format!("Catégorie « {} »", c.id), &c.label)?;
        if !category_ids.insert(c.id.clone()) {
            bail!("Catégorie « {} » : cet identifiant existe déjà.", c.id);
        }
        c.label = c.label.trim().to_string();
        c.description = c.description.trim().to_string();
        Ok(())
    };

    for d in &mut config.domains {
        if !valid_id(&d.id) {
            bail!(
                "Domaine « {} » : identifiant invalide (minuscules, chiffres et tirets).",
                d.id
            );
        }
        check_label(&format!("Domaine « {} »", d.id), &d.label)?;
        if !domain_ids.insert(d.id.clone()) {
            bail!("Domaine « {} » : cet identifiant existe déjà.", d.id);
        }
        if !valid_color(&d.color) {
            bail!(
                "Domaine « {} » : couleur « {} » invalide (#rrggbb).",
                d.label,
                d.color
            );
        }
        d.label = d.label.trim().to_string();
        d.description = d.description.trim().to_string();
        if let Some(stages) = &mut d.pipeline {
            let mut seen = HashSet::new();
            for s in stages.iter_mut() {
                if !valid_id(&s.id) || !seen.insert(s.id.clone()) {
                    bail!(
                        "Domaine « {} » : étape « {} » invalide ou en double.",
                        d.label,
                        s.id
                    );
                }
                check_label(&format!("Étape « {} »", s.id), &s.label)?;
                s.label = s.label.trim().to_string();
            }
            if stages.is_empty() {
                d.pipeline = None;
            }
        }
        for c in &mut d.categories {
            check_category(c)?;
        }
    }
    for added in &mut config.categories {
        if !domain_ids.contains(&added.domain) {
            bail!(
                "Catégorie « {} » : domaine « {} » introuvable.",
                added.category.label,
                added.domain
            );
        }
        check_category(&mut added.category)?;
    }
    config.hidden.retain(|id| known.contains(id));
    config.hidden.sort();
    config.hidden.dedup();
    Ok(config)
}

/// Labels d'une issue qui passe dans la catégorie `category` (`None` : sans catégorie), à
/// l'étape `stage` si elle est donnée. L'étape est gardée si le nouveau domaine la connaît,
/// sinon remplacée par la première étape de son pipeline (ou retirée sans pipeline).
pub fn with_category(
    labels: &[String],
    domains: &[DomainView],
    category: Option<&str>,
    stage: Option<&str>,
) -> Result<Vec<String>> {
    let current_stage = labels
        .iter()
        .find_map(|l| l.strip_prefix(STAGE_PREFIX))
        .map(str::to_string);
    let mut out: Vec<String> = labels
        .iter()
        .filter(|l| !l.starts_with(CATEGORY_PREFIX) && !l.starts_with(STAGE_PREFIX))
        .cloned()
        .collect();
    let Some(id) = category else {
        if stage.is_some() {
            bail!("Une étape demande une catégorie dont le domaine a un pipeline.");
        }
        return Ok(out);
    };
    let Some((domain, _)) = find(domains, id) else {
        bail!("Catégorie « {id} » inconnue : voir `list_categories`.");
    };
    out.push(format!("{CATEGORY_PREFIX}{id}"));
    match &domain.pipeline {
        None => {
            if let Some(s) = stage {
                bail!(
                    "Le domaine « {} » n'a pas de pipeline : pas d'étape « {s} ».",
                    domain.label
                );
            }
        }
        Some(stages) => {
            let chosen = match stage {
                Some(s) => {
                    if !stages.iter().any(|st| st.id == s) {
                        let ids: Vec<&str> = stages.iter().map(|st| st.id.as_str()).collect();
                        bail!(
                            "Étape « {s} » inconnue pour « {} » : {}.",
                            domain.label,
                            ids.join(", ")
                        );
                    }
                    Some(s.to_string())
                }
                None => current_stage
                    .filter(|c| stages.iter().any(|st| &st.id == c))
                    .or_else(|| stages.first().map(|st| st.id.clone())),
            };
            out.extend(chosen.map(|s| format!("{STAGE_PREFIX}{s}")));
        }
    }
    Ok(out)
}

/// Libellé d'une étape (l'identifiant si elle n'existe plus).
pub fn stage_label(domains: &[DomainView], category: Option<&str>, stage: &str) -> String {
    category
        .and_then(|c| find(domains, c))
        .and_then(|(d, _)| d.pipeline.as_ref())
        .and_then(|p| p.iter().find(|s| s.id == stage))
        .map(|s| s.label.clone())
        .unwrap_or_else(|| stage.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_are_valid_and_unique() {
        let d = defaults();
        assert!(d.len() >= 8, "taxonomie par défaut chargée");
        let mut ids = HashSet::new();
        for domain in &d {
            assert!(
                valid_id(&domain.id) && valid_color(&domain.color),
                "{}",
                domain.id
            );
            for c in &domain.categories {
                assert!(valid_id(&c.id), "{}", c.id);
                assert!(ids.insert(c.id.clone()), "catégorie en double : {}", c.id);
            }
        }
        assert!(is_default("dat") && is_default("back-end") && !is_default("inconnue"));
    }

    #[test]
    fn category_sets_first_stage_and_keeps_known_one() {
        let domains = resolve(&CategoryConfig::default());
        let out = with_category(&labels(&["type/feat"]), &domains, Some("questions-client"), None).unwrap();
        assert_eq!(out, ["type/feat", "cat/questions-client", "etape/a-preparer"]);
        let moved = with_category(&out, &domains, Some("relance-client"), None).unwrap();
        assert_eq!(moved, ["type/feat", "cat/relance-client", "etape/a-preparer"]);
        let staged = with_category(&moved, &domains, Some("relance-client"), Some("en-attente")).unwrap();
        assert!(staged.contains(&"etape/en-attente".to_string()));
        // Domaine sans pipeline : l'étape disparaît.
        let dev = with_category(&staged, &domains, Some("back-end"), None).unwrap();
        assert_eq!(dev, ["type/feat", "cat/back-end"]);
        assert!(with_category(&dev, &domains, Some("back-end"), Some("envoye")).is_err());
        assert!(with_category(&dev, &domains, Some("nope"), None).is_err());
        assert_eq!(with_category(&dev, &domains, None, None).unwrap(), ["type/feat"]);
    }

    #[test]
    fn custom_domains_and_categories() {
        let config = CategoryConfig {
            domains: vec![Domain {
                id: "marketing".into(),
                label: " Marketing ".into(),
                color: "#112233".into(),
                description: String::new(),
                pipeline: None,
                categories: vec![Category {
                    id: "seo".into(),
                    label: "SEO".into(),
                    description: String::new(),
                }],
            }],
            categories: vec![AddedCategory {
                domain: "dev".into(),
                category: Category {
                    id: "rust".into(),
                    label: "Rust".into(),
                    description: String::new(),
                },
            }],
            hidden: vec!["mobile".into(), "inconnu".into()],
        };
        let config = validate(config).unwrap();
        assert_eq!(config.hidden, ["mobile"]);
        assert_eq!(config.domains[0].label, "Marketing");
        let domains = resolve(&config);
        let (d, c) = find(&domains, "rust").unwrap();
        assert_eq!((d.id.as_str(), c.custom), ("dev", true));
        assert!(find(&domains, "mobile").unwrap().1.hidden);
        assert_eq!(find(&domains, "seo").unwrap().0.id, "marketing");

        let dup = CategoryConfig {
            categories: vec![AddedCategory {
                domain: "dev".into(),
                category: Category {
                    id: "dat".into(),
                    label: "DAT".into(),
                    description: String::new(),
                },
            }],
            ..Default::default()
        };
        assert!(validate(dup).is_err(), "identifiant déjà pris par un défaut");
        let orphan = CategoryConfig {
            categories: vec![AddedCategory {
                domain: "absent".into(),
                category: Category {
                    id: "x".into(),
                    label: "X".into(),
                    description: String::new(),
                },
            }],
            ..Default::default()
        };
        assert!(validate(orphan).is_err());
    }
}
