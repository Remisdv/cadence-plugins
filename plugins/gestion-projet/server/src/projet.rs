//! Sprints automatiques : état partagé du projet et planification (fonctions pures).
//!
//! L'état vit dans une issue GitHub du dépôt, label `cadence/sprints` : toute l'équipe le voit et
//! chaque Cadence ouvert le fait avancer. L'issue est masquée dans les listes d'issues. Son corps
//! est un texte lisible suivi d'un bloc ```json``` (`ProjectState`), seule partie lue.
//!
//! Règles :
//! - un sprint = une version (milestone daté `0.2.0`) et une branche `release/0.2.0` ; les
//!   branches `feat/…` partent de la branche de release et y sont fusionnées ;
//! - à la création, un sprint prend les issues sans version par priorité (0 = socle, puis 1 à 5,
//!   sans priorité en dernier), dans la limite de sa capacité en story points, en respectant les
//!   dépendances (« Dépend de #12 ») ; une issue sans story points compte pour `DEFAULT_POINTS` ;
//! - capacité = rythme (SP fermés par jour sur les trois derniers sprints, ou le rythme saisi au
//!   démarrage) × durée ; un sprint fini en avance tire les issues suivantes ;
//! - à l'échéance, les issues ouvertes passent en tête du sprint suivant (leur poids réduit la
//!   place des nouvelles), la branche de release est fusionnée dans la branche par défaut.
//!
//! Roadmap : des **jalons** (nom clair, description, issues) rangés dans l'état, pour l'affichage
//! seulement (ni branche ni milestone ; les sprints restent remplis par priorité). La prévision
//! simule les sprints à venir au rythme moyen, puis aux rythmes haut et bas pour la fourchette :
//! un jalon finit avec le sprint qui prend sa dernière issue ouverte.

use std::collections::HashSet;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::model::Issue;
use crate::sprint::{add_days, days_between};

/// Label de l'issue d'état.
pub const STATE_LABEL: &str = "cadence/sprints";
/// Titre de l'issue d'état.
pub const STATE_TITLE: &str = "Sprints automatiques (Cadence)";
/// Poids d'une issue sans story points.
pub const DEFAULT_POINTS: u32 = 3;
/// Bornes de la durée d'un sprint, en jours.
pub const MIN_DAYS: u32 = 1;
pub const MAX_DAYS: u32 = 90;
/// Sprints terminés pris en compte dans le rythme.
const RATE_WINDOW: usize = 3;
const MARKER: &str = "<!-- cadence:sprints -->";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    /// Pas encore démarrés : l'état ne porte que les jalons de la roadmap.
    Idle,
    Running,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseStatus {
    /// Fusion de `release/x` dans la branche par défaut à faire (CI en cours, PR à créer…).
    Pending,
    /// Fusionnée et taguée.
    Merged,
    /// Rien à livrer : la branche n'a aucun commit de plus que la branche par défaut.
    Empty,
    /// Bloquée (CI en échec, conflit, PR encore ouvertes vers la branche) : nouvel essai à chaque passe.
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReleaseRecord {
    pub status: ReleaseStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ReleaseRecord {
    pub fn pending() -> Self {
        ReleaseRecord {
            status: ReleaseStatus::Pending,
            pull_request: None,
            tag: None,
            message: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SprintRecord {
    /// Version semver, titre du milestone.
    pub version: String,
    pub start_on: String,
    pub due_on: String,
    /// Jours de pause pendant ce sprint (l'échéance a été repoussée d'autant).
    #[serde(default)]
    pub paused_days: u32,
    /// Capacité visée, en story points.
    pub capacity: u32,
    /// Remplissage initial fait (les issues reportées y sont déjà).
    #[serde(default)]
    pub filled: bool,
    /// Issues reportées depuis le sprint précédent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub carried: Vec<u32>,
    /// Story points fermés, relevés à la fin du sprint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_points: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<ReleaseRecord>,
}

impl SprintRecord {
    pub fn branch(&self) -> String {
        release_branch(&self.version)
    }

    /// Jours de travail effectifs (pauses retirées), au moins un.
    pub fn working_days(&self) -> u32 {
        let end = self.ended_on.as_deref().unwrap_or(&self.due_on);
        let days = days_between(&self.start_on, end).unwrap_or(0) - i64::from(self.paused_days);
        days.max(1) as u32
    }
}

/// Jalon de la roadmap : un objectif nommé, atteint en un ou plusieurs sprints.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Jalon {
    /// Identifiant stable (`mvp`, `beta-publique`), tiré du nom à la création.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Issues du jalon (une issue appartient à un seul jalon).
    #[serde(default)]
    pub issues: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesignStatus {
    /// Lien enregistré, fichiers pas encore dans le dépôt.
    Pending,
    /// Fichiers commités sous `path` (branche `ref`).
    Imported,
}

/// Design de Claude Design : lien d'origine et, une fois importé, ses fichiers dans le dépôt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Design {
    pub id: String,
    pub name: String,
    /// Lien claude.ai du design.
    pub url: String,
    pub status: DesignStatus,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Dossier des fichiers dans le dépôt (`design/<id>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Branche où les fichiers ont été commités (avant fusion dans la base).
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Fichier à afficher d'abord (`index.html`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    pub added_on: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_on: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectState {
    pub status: RunStatus,
    pub duration_days: u32,
    /// Rythme de départ (capacité saisie / durée), utilisé tant qu'aucun sprint n'est terminé.
    pub initial_points_per_day: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_since: Option<String>,
    /// Sprints, du plus ancien au sprint en cours (le dernier).
    #[serde(default)]
    pub sprints: Vec<SprintRecord>,
    /// Jalons de la roadmap, dans l'ordre d'affichage.
    #[serde(default)]
    pub jalons: Vec<Jalon>,
    /// Designs (Claude Design) du projet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub designs: Vec<Design>,
}

impl ProjectState {
    pub fn current(&self) -> Option<&SprintRecord> {
        self.sprints.last()
    }

    pub fn current_mut(&mut self) -> Option<&mut SprintRecord> {
        self.sprints.last_mut()
    }

    /// Story points par jour : trois derniers sprints terminés, sinon le rythme de départ.
    pub fn points_per_day(&self) -> f32 {
        let ended: Vec<&SprintRecord> = self
            .sprints
            .iter()
            .filter(|s| s.done_points.is_some())
            .rev()
            .take(RATE_WINDOW)
            .collect();
        if ended.is_empty() {
            return self.initial_points_per_day;
        }
        let done: u32 = ended.iter().filter_map(|s| s.done_points).sum();
        let days: u32 = ended.iter().map(|s| s.working_days()).sum();
        done as f32 / days.max(1) as f32
    }

    /// Capacité d'un sprint de la durée réglée, au rythme actuel.
    pub fn next_capacity(&self) -> u32 {
        capacity_for(self.points_per_day(), self.duration_days)
    }

    /// Rythmes (bas, moyen, haut) de la fourchette des dates : le moins bon et le meilleur des
    /// trois derniers sprints ; sans historique, ±40 % puis ±25 % après un premier sprint.
    pub fn rate_range(&self) -> (f32, f32, f32) {
        let avg = self.points_per_day();
        let rates: Vec<f32> = self
            .sprints
            .iter()
            .filter_map(|s| s.done_points.map(|d| d as f32 / s.working_days() as f32))
            .rev()
            .take(RATE_WINDOW)
            .collect();
        match rates.len() {
            0 => (avg * 0.6, avg, avg * 1.4),
            1 => (avg * 0.75, avg, avg * 1.25),
            _ => {
                let low = rates.iter().copied().fold(f32::INFINITY, f32::min);
                let high = rates.iter().copied().fold(0.0, f32::max);
                (low.min(avg), avg, high.max(avg))
            }
        }
    }

    pub fn jalon(&self, id: &str) -> Option<&Jalon> {
        self.jalons.iter().find(|j| j.id == id)
    }

    /// Identifiant libre tiré d'un nom (`MVP privé` → `mvp-prive`, puis `mvp-prive-2`…).
    pub fn new_jalon_id(&self, name: &str) -> String {
        unique_id(name, "jalon", |id| self.jalon(id).is_some())
    }

    pub fn design(&self, id: &str) -> Option<&Design> {
        self.designs.iter().find(|d| d.id == id)
    }

    pub fn new_design_id(&self, name: &str) -> String {
        unique_id(name, "design", |id| self.design(id).is_some())
    }

    /// Range des issues dans un jalon (et les retire de tout autre jalon), en retire d'autres.
    pub fn assign(&mut self, id: &str, add: &[u32], remove: &[u32]) -> Result<()> {
        if self.jalon(id).is_none() {
            bail!("Jalon « {id} » introuvable.");
        }
        for j in &mut self.jalons {
            if j.id == id {
                j.issues.retain(|n| !remove.contains(n));
                for n in add {
                    if !j.issues.contains(n) {
                        j.issues.push(*n);
                    }
                }
            } else {
                j.issues.retain(|n| !add.contains(n));
            }
        }
        Ok(())
    }
}

/// Identifiant tiré d'un nom, suffixé (`-2`, `-3`…) tant que `taken` le refuse.
fn unique_id(name: &str, fallback: &str, taken: impl Fn(&str) -> bool) -> String {
    let base = slug(name);
    let base = if base.is_empty() {
        fallback.to_string()
    } else {
        base
    };
    let mut id = base.clone();
    let mut n = 2;
    while taken(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

/// `MVP privé : l'essentiel` → `mvp-prive-l-essentiel`.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        let c = match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').chars().take(40).collect()
}

pub fn capacity_for(points_per_day: f32, days: u32) -> u32 {
    (points_per_day * days as f32).round().max(0.0) as u32
}

pub fn release_branch(version: &str) -> String {
    format!("release/{version}")
}

pub fn check_duration(days: u32) -> Result<u32> {
    if !(MIN_DAYS..=MAX_DAYS).contains(&days) {
        bail!("Durée de sprint invalide : {days} jours (de {MIN_DAYS} à {MAX_DAYS}).");
    }
    Ok(days)
}

/// Échéance d'un sprint : début + durée + pauses, jamais avant `today`.
pub fn due_for(start_on: &str, duration_days: u32, paused_days: u32, today: &str) -> String {
    let due = add_days(start_on, i64::from(duration_days + paused_days)).unwrap_or_else(|| today.into());
    if due.as_str() < today {
        today.to_string()
    } else {
        due
    }
}

/* ---------- Issue d'état ---------- */

/// Corps de l'issue d'état : explication lisible, résumé, puis l'état en JSON.
pub fn render_body(state: &ProjectState) -> String {
    let status = match (&state.status, &state.paused_since) {
        (RunStatus::Paused, Some(since)) => format!("en pause depuis le {since}"),
        (RunStatus::Paused, None) => "en pause".into(),
        (RunStatus::Running, _) => "en cours".into(),
        (RunStatus::Idle, _) => "pas encore démarrés".into(),
    };
    let jalons = if state.jalons.is_empty() {
        "aucun".to_string()
    } else {
        state
            .jalons
            .iter()
            .map(|j| format!("{} ({} issues)", j.name, j.issues.len()))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let current = state
        .current()
        .map(|s| {
            format!(
                "{} (du {} au {}, branche `{}`)",
                s.version,
                s.start_on,
                s.due_on,
                s.branch()
            )
        })
        .unwrap_or_else(|| "aucun".into());
    let json = serde_json::to_string_pretty(state).unwrap_or_else(|_| "{}".into());
    format!(
        "{MARKER}\n\
         Cette issue est gérée par le plugin **Gestion de projet** de Cadence : elle garde, pour toute \
         l'équipe, l'état des sprints automatiques de ce dépôt. Elle est masquée dans l'écran Issues. \
         Ne la fermez pas et ne modifiez pas le bloc JSON à la main : utilisez l'écran « Sprint en \
         cours » de Cadence (démarrer, mettre en pause, changer la durée) et l'écran « Roadmap » \
         (jalons).\n\n\
         - Sprints : {status}\n\
         - Durée d'un sprint : {} jours\n\
         - Sprint en cours : {current}\n\
         - Jalons : {jalons}\n\
         - Designs : {}\n\n\
         ```json\n{json}\n```\n",
        state.duration_days,
        state.designs.len()
    )
}

/// État lu dans le corps de l'issue (le bloc ```json``` après le marqueur).
pub fn parse_body(body: &str) -> Result<ProjectState> {
    let start = body
        .find("```json")
        .context("bloc JSON des sprints absent de l'issue d'état")?;
    let rest = &body[start + "```json".len()..];
    let end = rest.find("```").context("bloc JSON des sprints non terminé")?;
    serde_json::from_str(rest[..end].trim()).context("état des sprints illisible dans l'issue d'état")
}

/* ---------- Planification ---------- */

/// Issues dont celle-ci dépend : les `#n` des lignes qui mentionnent une dépendance, ou de la
/// section « Dépendances ».
pub fn dependencies(body: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let mut in_section = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("##") {
            in_section = title
                .trim_start_matches('#')
                .trim()
                .to_lowercase()
                .starts_with("dépendance");
            continue;
        }
        let lower = trimmed.to_lowercase();
        if in_section || lower.contains("dépend de") || lower.contains("depends on") {
            for n in issue_refs(trimmed) {
                if !out.contains(&n) {
                    out.push(n);
                }
            }
        }
    }
    out
}

/// `#12` d'une ligne de texte (pas les ancres `owner/repo#12` d'autres dépôts).
fn issue_refs(line: &str) -> Vec<u32> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'/')) {
            let digits: String = line[i + 1..].chars().take_while(char::is_ascii_digit).collect();
            if let Ok(n) = digits.parse::<u32>() {
                out.push(n);
            }
            i += 1 + digits.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Poids d'une issue dans la capacité.
pub fn weight(issue: &Issue) -> u32 {
    issue.points.unwrap_or(DEFAULT_POINTS)
}

/// Rang de priorité : 0 (socle) d'abord, sans priorité en dernier.
fn rank(issue: &Issue) -> (u8, u32) {
    (
        issue.priority.unwrap_or(crate::model::LOWEST_PRIORITY + 1),
        issue.number,
    )
}

/// Issues à ajouter au sprint, dans l'ordre : par priorité puis numéro, tant qu'elles tiennent
/// dans `budget` story points. Une issue dont une dépendance est ouverte hors du sprint attend.
/// `at_least_one` : une issue plus grosse que le budget est prise si rien d'autre n'entre.
///
/// - `backlog` : candidates (issues ouvertes sans version, avec leur description) ;
/// - `open` : numéros de toutes les issues ouvertes du dépôt ;
/// - `in_sprint` : numéros des issues déjà dans le sprint.
pub fn select(
    backlog: &[Issue],
    budget: u32,
    open: &HashSet<u32>,
    in_sprint: &HashSet<u32>,
    at_least_one: bool,
) -> Vec<u32> {
    let mut ordered: Vec<&Issue> = backlog.iter().collect();
    ordered.sort_by_key(|i| rank(i));
    let mut chosen: Vec<u32> = Vec::new();
    let mut used = 0u32;
    // Plusieurs passes : une issue débloquée par une dépendance choisie plus loin entre ensuite.
    for _ in 0..3 {
        let before = chosen.len();
        for issue in &ordered {
            if chosen.contains(&issue.number) {
                continue;
            }
            let deps = dependencies(issue.body.as_deref().unwrap_or(""));
            let blocked = deps.iter().any(|d| {
                *d != issue.number && open.contains(d) && !in_sprint.contains(d) && !chosen.contains(d)
            });
            if blocked {
                continue;
            }
            let w = weight(issue);
            if used + w <= budget || (at_least_one && chosen.is_empty() && used == 0) {
                used += w;
                chosen.push(issue.number);
            }
        }
        if chosen.len() == before {
            break;
        }
    }
    chosen
}

/// Issues à retirer d'un sprint trop chargé (durée réduite) : celles « à faire », non reportées,
/// de la moins prioritaire à la plus prioritaire, jusqu'à revenir sous `target`.
pub fn trim(sprint: &[Issue], carried: &[u32], target: u32) -> Vec<u32> {
    let mut load: u32 = sprint.iter().map(weight).sum();
    let mut removable: Vec<&Issue> = sprint
        .iter()
        .filter(|i| i.state == "open" && i.status == "todo" && i.assignees.is_empty())
        .filter(|i| !carried.contains(&i.number))
        .collect();
    removable.sort_by_key(|i| std::cmp::Reverse(rank(i)));
    let mut out = Vec::new();
    for issue in removable {
        if load <= target {
            break;
        }
        load -= weight(issue);
        out.push(issue.number);
    }
    out
}

/* ---------- Prévision ---------- */

/// Sprint de la prévision : le sprint en cours (ses issues ouvertes finissent à son échéance)
/// puis les sprints simulés.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlannedSprint {
    pub version: String,
    pub start_on: String,
    pub due_on: String,
    pub issues: Vec<u32>,
    pub points: u32,
}

/// Sprints à venir au rythme `rate` (SP par jour) : après le sprint `current` (issues ouvertes
/// `current_open`), des sprints de `duration` jours prennent `backlog` par priorité, comme le
/// moteur. Une issue dont une dépendance n'est planifiée nulle part reste hors prévision.
#[allow(clippy::too_many_arguments)]
pub fn forecast(
    current: &SprintRecord,
    current_open: &[Issue],
    backlog: &[Issue],
    open: &HashSet<u32>,
    rate: f32,
    duration: u32,
    taken: &[String],
    prefix: &str,
    max_sprints: usize,
) -> Vec<PlannedSprint> {
    let mut out = vec![PlannedSprint {
        version: current.version.clone(),
        start_on: current.start_on.clone(),
        due_on: current.due_on.clone(),
        issues: current_open.iter().map(|i| i.number).collect(),
        points: current_open.iter().map(weight).sum(),
    }];
    let mut scheduled: HashSet<u32> = current_open.iter().map(|i| i.number).collect();
    let mut remaining: Vec<Issue> = backlog
        .iter()
        .filter(|i| !scheduled.contains(&i.number))
        .cloned()
        .collect();
    let capacity = capacity_for(rate, duration);
    while !remaining.is_empty() && out.len() < max_sprints {
        let last = out.last().cloned().unwrap_or_else(|| out[0].clone());
        // Les issues planifiées plus tôt sont faites quand ce sprint commence.
        let open_now: HashSet<u32> = open.difference(&scheduled).copied().collect();
        let picks = select(&remaining, capacity, &open_now, &HashSet::new(), true);
        if picks.is_empty() {
            break;
        }
        let points = remaining
            .iter()
            .filter(|i| picks.contains(&i.number))
            .map(weight)
            .sum();
        scheduled.extend(picks.iter().copied());
        remaining.retain(|i| !picks.contains(&i.number));
        let start_on = last.due_on.clone();
        out.push(PlannedSprint {
            version: version_after(&last.version, taken, prefix),
            due_on: add_days(&start_on, i64::from(duration)).unwrap_or_else(|| start_on.clone()),
            start_on,
            issues: picks,
            points,
        });
    }
    out
}

/// Échéance du sprint qui prend chaque issue, dans une prévision.
pub fn due_by_issue(plan: &[PlannedSprint]) -> std::collections::HashMap<u32, (String, String)> {
    plan.iter()
        .flat_map(|s| {
            s.issues
                .iter()
                .map(move |n| (*n, (s.version.clone(), s.due_on.clone())))
        })
        .collect()
}

/* ---------- Versions ---------- */

fn semver(title: &str, prefix: &str) -> Option<(u64, u64, u64)> {
    let t = title.trim();
    let t = if prefix.is_empty() {
        t
    } else {
        t.strip_prefix(prefix).unwrap_or(t)
    };
    let t = t.strip_prefix('v').unwrap_or(t);
    let mut parts = t.split('.');
    let v = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(v)
}

pub fn is_semver(title: &str) -> bool {
    semver(title, "").is_some()
}

/// Version suivante : mineure +1 de la plus haute version connue, `0.1.0` sans historique.
/// `taken` : titres de milestones et tags existants (jamais réutilisés).
pub fn next_version(taken: &[String], prefix: &str) -> String {
    let max = taken.iter().filter_map(|t| semver(t, prefix)).max();
    let (major, minor) = match max {
        Some((ma, mi, _)) => (ma, mi + 1),
        None => (0, 1),
    };
    format!("{major}.{minor}.0")
}

/// Version qui suit `current` (mineure +1), en sautant celles déjà prises.
pub fn version_after(current: &str, taken: &[String], prefix: &str) -> String {
    let mut all: Vec<String> = taken.to_vec();
    all.push(current.to_string());
    next_version(&all, prefix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::issue_from;
    use serde_json::json;

    fn issue(number: u32, priority: Option<u8>, points: Option<u32>, body: &str) -> Issue {
        let mut labels = vec![];
        if let Some(p) = priority {
            labels.push(json!({ "name": format!("priority/{p}") }));
        }
        if let Some(sp) = points {
            labels.push(json!({ "name": format!("sp/{sp}") }));
        }
        issue_from(
            &json!({ "number": number, "state": "open", "labels": labels, "body": body }),
            true,
        )
    }

    fn state() -> ProjectState {
        ProjectState {
            status: RunStatus::Running,
            duration_days: 14,
            initial_points_per_day: 1.5,
            paused_since: None,
            sprints: vec![SprintRecord {
                version: "0.1.0".into(),
                start_on: "2026-10-19".into(),
                due_on: "2026-11-02".into(),
                paused_days: 0,
                capacity: 21,
                filled: true,
                carried: vec![],
                done_points: None,
                ended_on: None,
                release: None,
            }],
            jalons: vec![],
            designs: vec![],
        }
    }

    #[test]
    fn round_trips_the_state_issue() {
        let s = state();
        let body = render_body(&s);
        assert!(body.starts_with(MARKER));
        assert!(
            body.contains("Sprint en cours : 0.1.0 (du 2026-10-19 au 2026-11-02, branche `release/0.1.0`)")
        );
        assert_eq!(parse_body(&body).unwrap(), s);
        assert!(parse_body("pas d'état").is_err());
        assert!(parse_body("```json\n{ cassé\n```").is_err());
    }

    #[test]
    fn reads_dependencies() {
        let body = "## Contexte\nVoir #3.\n\n## Dépendances\nDépend de #1, #2\n\n## Autre\n#9";
        assert_eq!(dependencies(body), [1, 2]);
        assert_eq!(dependencies("Dépend de #4 et de me/lib#7"), [4]);
        assert_eq!(dependencies("## Dépendances\nAucune"), Vec::<u32>::new());
    }

    #[test]
    fn fills_by_priority_within_capacity() {
        let backlog = vec![
            issue(1, Some(0), Some(5), ""),
            issue(2, Some(0), Some(8), "## Dépendances\nDépend de #1"),
            issue(3, Some(1), Some(8), "## Dépendances\nDépend de #1, #2"),
            issue(4, Some(1), Some(5), "## Dépendances\nDépend de #2, #3"),
            issue(5, None, None, ""),
            issue(6, Some(5), Some(2), ""),
        ];
        let open: HashSet<u32> = (1..=6).collect();
        let none = HashSet::new();
        // 21 SP : #1 (5) + #2 (8) + #3 (8) ; #4 attend #3, déjà pris : 21 + 5 > 21.
        assert_eq!(select(&backlog, 21, &open, &none, true), [1, 2, 3]);
        // 15 SP : #3 ne tient pas, #4 dépend de #3 : place pour #6 (2) puis rien (#5 = 3 SP par défaut → 15+3).
        assert_eq!(select(&backlog, 15, &open, &none, true), [1, 2, 6]);
        // Dépendance hors du sprint et ouverte : l'issue attend.
        let only_3 = vec![backlog[2].clone()];
        assert!(select(&only_3, 50, &open, &none, true).is_empty());
        // Dépendances déjà dans le sprint : elle entre.
        let in_sprint: HashSet<u32> = [1, 2].into();
        assert_eq!(select(&only_3, 50, &open, &in_sprint, true), [3]);
        // Budget trop petit : au moins une issue si demandé.
        assert_eq!(select(&backlog, 1, &open, &none, true), [1]);
        assert!(select(&backlog, 1, &open, &none, false).is_empty());
    }

    #[test]
    fn trims_the_least_urgent_todo_issues() {
        let mut sprint = vec![
            issue(1, Some(0), Some(5), ""),
            issue(2, Some(1), Some(8), ""),
            issue(3, Some(3), Some(3), ""),
            issue(4, Some(2), Some(5), ""),
        ];
        sprint[0].status = "doing";
        assert_eq!(trim(&sprint, &[], 21), Vec::<u32>::new());
        assert_eq!(trim(&sprint, &[], 15), [3, 4]);
        // Reportée : jamais retirée.
        assert_eq!(trim(&sprint, &[3], 15), [4, 2]);
    }

    #[test]
    fn measures_the_pace_and_capacity() {
        let mut s = state();
        assert_eq!((s.points_per_day(), s.next_capacity()), (1.5, 21));
        s.sprints[0].done_points = Some(14);
        s.sprints[0].ended_on = Some("2026-11-02".into());
        s.sprints[0].paused_days = 4;
        // 14 SP en 10 jours effectifs.
        assert_eq!(s.points_per_day(), 1.4);
        assert_eq!(s.next_capacity(), 20);
        s.duration_days = 21;
        assert_eq!(s.next_capacity(), 29);
    }

    #[test]
    fn manages_jalons() {
        let mut s = state();
        assert_eq!(slug("MVP privé : l'essentiel"), "mvp-prive-l-essentiel");
        assert_eq!(s.new_jalon_id("MVP"), "mvp");
        s.jalons.push(Jalon {
            id: "mvp".into(),
            name: "MVP".into(),
            description: String::new(),
            issues: vec![1, 2],
        });
        s.jalons.push(Jalon {
            id: "beta".into(),
            name: "Bêta".into(),
            description: String::new(),
            issues: vec![3],
        });
        assert_eq!(s.new_jalon_id("MVP"), "mvp-2");
        // Une issue n'appartient qu'à un jalon.
        s.assign("beta", &[2, 4], &[3]).unwrap();
        assert_eq!(
            (s.jalons[0].issues.clone(), s.jalons[1].issues.clone()),
            (vec![1], vec![2, 4])
        );
        assert!(s.assign("inconnu", &[1], &[]).is_err());
        // Anciens états sans jalons : lus quand même.
        let old = r#"{"status":"running","duration_days":14,"initial_points_per_day":1.5,"sprints":[]}"#;
        let parsed: ProjectState = serde_json::from_str(old).unwrap();
        assert!(parsed.jalons.is_empty());
        assert!(render_body(&s).contains("- Jalons : MVP (1 issues), Bêta (2 issues)"));
    }

    #[test]
    fn widens_then_narrows_the_rate_range() {
        let mut s = state();
        assert_eq!(s.rate_range(), (1.5 * 0.6, 1.5, 1.5 * 1.4));
        s.sprints[0].done_points = Some(14);
        s.sprints[0].ended_on = Some("2026-11-02".into());
        let (low, avg, high) = s.rate_range();
        assert_eq!((low, avg, high), (0.75, 1.0, 1.25));
        let mut next = s.sprints[0].clone();
        next.version = "0.2.0".into();
        next.done_points = Some(28);
        s.sprints.push(next);
        // 1 SP/j puis 2 SP/j : fourchette = les deux sprints.
        assert_eq!(s.rate_range(), (1.0, 1.5, 2.0));
    }

    #[test]
    fn forecasts_the_next_sprints() {
        let current = state().sprints[0].clone();
        let in_sprint = vec![issue(1, Some(0), Some(5), "")];
        let backlog = vec![
            issue(2, Some(1), Some(8), "## Dépendances\nDépend de #1"),
            issue(3, Some(1), Some(8), ""),
            issue(4, Some(2), Some(5), "## Dépendances\nDépend de #2"),
            issue(5, Some(3), Some(3), "## Dépendances\nDépend de #99"),
        ];
        let open: HashSet<u32> = [1, 2, 3, 4, 5, 99].into();
        // 1 SP/j × 14 j = 14 SP par sprint.
        let plan = forecast(&current, &in_sprint, &backlog, &open, 1.0, 14, &[], "v", 20);
        let sprints: Vec<(&str, &str, Vec<u32>)> = plan
            .iter()
            .map(|s| (s.version.as_str(), s.due_on.as_str(), s.issues.clone()))
            .collect();
        assert_eq!(
            sprints,
            [
                ("0.1.0", "2026-11-02", vec![1]),
                ("0.2.0", "2026-11-16", vec![2, 4]),
                ("0.3.0", "2026-11-30", vec![3]),
            ]
        );
        // #5 attend #99, planifiée nulle part : hors prévision.
        assert!(!due_by_issue(&plan).contains_key(&5));
        assert_eq!(
            due_by_issue(&plan)[&4],
            ("0.2.0".to_string(), "2026-11-16".to_string())
        );
    }

    #[test]
    fn computes_due_dates_and_versions() {
        assert_eq!(due_for("2026-10-19", 14, 0, "2026-10-20"), "2026-11-02");
        assert_eq!(due_for("2026-10-19", 14, 3, "2026-10-20"), "2026-11-05");
        // Durée raccourcie sous la date du jour : fin aujourd'hui.
        assert_eq!(due_for("2026-10-01", 7, 0, "2026-10-20"), "2026-10-20");
        assert!(check_duration(0).is_err() && check_duration(91).is_err());
        assert_eq!(next_version(&[], "v"), "0.1.0");
        let taken = vec!["0.2.0".to_string(), "v0.3.1".into(), "Cockpit".into()];
        assert_eq!(next_version(&taken, "v"), "0.4.0");
        assert_eq!(version_after("0.1.0", &["0.2.0".into()], "v"), "0.3.0");
        assert!(is_semver("1.2.3") && !is_semver("1.2"));
    }
}
