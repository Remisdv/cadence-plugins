//! Planning (Gantt) : tâches libres, pas seulement du développement (étude, recette, salon…),
//! avec phases, personnes, dépendances, avancement et jalons-dates.
//!
//! Partagé par l'équipe dans une issue GitHub du dépôt, label `cadence/planning`, masquée des
//! listes d'issues (texte lisible + bloc ```json```), à côté de l'issue d'état des sprints.
//! `revision` augmente à chaque enregistrement : une écriture fondée sur une révision dépassée est
//! refusée (quelqu'un d'autre a modifié le planning entre-temps).

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result, bail};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::sprint::{days_between, is_date};

pub const PLANNING_LABEL: &str = "cadence/planning";
pub const PLANNING_TITLE: &str = "Planning (Cadence)";
const MARKER: &str = "<!-- cadence:planning -->";
const MAX_TASKS: usize = 500;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Planning {
    /// Révision, augmentée à chaque enregistrement (ne pas la modifier).
    #[serde(default)]
    pub revision: u32,
    /// Personnes affectables aux tâches.
    #[serde(default)]
    pub people: Vec<Person>,
    /// Ordre d'affichage des phases (« Étude », « Développement », « Recette »…).
    #[serde(default)]
    pub phases: Vec<String>,
    #[serde(default)]
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Person {
    /// Identifiant court et stable (`remi`, `marc`).
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Task {
    /// Identifiant court et stable (`etude-marche`, `t12`).
    pub id: String,
    pub name: String,
    /// Phase (groupe d'affichage) ; vide : « Sans phase ».
    #[serde(default)]
    pub phase: String,
    /// Premier jour, AAAA-MM-JJ.
    pub start: String,
    /// Dernier jour (inclus), AAAA-MM-JJ ; égal à `start` pour un jalon-date.
    pub end: String,
    /// Personnes affectées (identifiants de `people`).
    #[serde(default)]
    pub people: Vec<String>,
    /// Tâches à finir avant celle-ci (identifiants).
    #[serde(default)]
    pub depends: Vec<String>,
    /// Avancement 0 à 100.
    #[serde(default)]
    pub progress: u8,
    /// Jalon-date (losange) plutôt que barre.
    #[serde(default)]
    pub milestone: bool,
    /// Issue GitHub liée, s'il y en a une.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<u32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
}

fn check_id(kind: &str, id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 60
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        bail!("Identifiant de {kind} invalide : « {id} » (lettres, chiffres, - ou _, 60 au plus).");
    }
    Ok(())
}

/// Vérifie un planning avant de l'enregistrer ; messages en français, précis sur la tâche fautive.
pub fn validate(p: &Planning) -> Result<()> {
    if p.tasks.len() > MAX_TASKS {
        bail!(
            "Planning trop grand : {} tâches (au plus {MAX_TASKS}).",
            p.tasks.len()
        );
    }
    let mut people = HashSet::new();
    for person in &p.people {
        check_id("personne", &person.id)?;
        if person.name.trim().is_empty() {
            bail!("La personne « {} » n'a pas de nom.", person.id);
        }
        if !people.insert(person.id.as_str()) {
            bail!("Personne en double : « {} ».", person.id);
        }
    }
    let mut ids = HashSet::new();
    for t in &p.tasks {
        check_id("tâche", &t.id)?;
        if !ids.insert(t.id.as_str()) {
            bail!("Tâche en double : « {} ».", t.id);
        }
    }
    for t in &p.tasks {
        if t.name.trim().is_empty() {
            bail!("La tâche « {} » n'a pas de nom.", t.id);
        }
        if !is_date(&t.start) || !is_date(&t.end) || t.start.len() != 10 || t.end.len() != 10 {
            bail!("Dates invalides pour « {} » : attendu AAAA-MM-JJ.", t.name);
        }
        if days_between(&t.start, &t.end).unwrap_or(-1) < 0 {
            bail!(
                "« {} » finit ({}) avant de commencer ({}).",
                t.name,
                t.end,
                t.start
            );
        }
        if t.progress > 100 {
            bail!("Avancement de « {} » : {} % (de 0 à 100).", t.name, t.progress);
        }
        if let Some(who) = t.people.iter().find(|w| !people.contains(w.as_str())) {
            bail!(
                "« {} » est affectée à « {who} », qui n'est pas dans les personnes du planning.",
                t.name
            );
        }
        if let Some(d) = t
            .depends
            .iter()
            .find(|d| !ids.contains(d.as_str()) || *d == &t.id)
        {
            bail!(
                "« {} » dépend de « {d} », qui n'existe pas (ou est elle-même).",
                t.name
            );
        }
    }
    if let Some(cycle) = find_cycle(&p.tasks) {
        bail!("Dépendances en boucle : {}.", cycle.join(" → "));
    }
    Ok(())
}

/// Un cycle de dépendances, s'il y en a un (noms des tâches).
fn find_cycle(tasks: &[Task]) -> Option<Vec<String>> {
    let by_id: HashMap<&str, &Task> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    // 0 = pas vue, 1 = en cours, 2 = finie.
    let mut state: HashMap<&str, u8> = HashMap::new();
    fn visit<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a Task>,
        state: &mut HashMap<&'a str, u8>,
        path: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        match state.get(id) {
            Some(2) => return None,
            Some(1) => {
                let from = path.iter().position(|p| *p == id).unwrap_or(0);
                let mut cycle: Vec<String> = path[from..].iter().map(|i| by_id[i].name.clone()).collect();
                cycle.push(by_id[id].name.clone());
                return Some(cycle);
            }
            _ => {}
        }
        state.insert(id, 1);
        path.push(id);
        for d in &by_id[id].depends {
            if by_id.contains_key(d.as_str())
                && let Some(c) = visit(d.as_str(), by_id, state, path)
            {
                return Some(c);
            }
        }
        path.pop();
        state.insert(id, 2);
        None
    }
    for t in tasks {
        if let Some(c) = visit(t.id.as_str(), &by_id, &mut state, &mut Vec::new()) {
            return Some(c);
        }
    }
    None
}

/// Corps de l'issue du planning : explication, résumé, puis le planning en JSON.
pub fn render_body(p: &Planning) -> String {
    let span = p
        .tasks
        .iter()
        .map(|t| t.start.as_str())
        .min()
        .zip(p.tasks.iter().map(|t| t.end.as_str()).max())
        .map(|(a, b)| format!("du {a} au {b}"))
        .unwrap_or_else(|| "vide".into());
    let json = serde_json::to_string_pretty(p).unwrap_or_else(|_| "{}".into());
    format!(
        "{MARKER}\n\
         Cette issue est gérée par le plugin **Gestion de projet** de Cadence : elle garde, pour toute \
         l'équipe, le planning (Gantt) de ce dépôt. Elle est masquée dans l'écran Issues. Ne la \
         fermez pas et ne modifiez pas le bloc JSON à la main : utilisez l'écran « Planning » de \
         Cadence.\n\n\
         - Tâches : {} ({span})\n\
         - Personnes : {}\n\n\
         ```json\n{json}\n```\n",
        p.tasks.len(),
        if p.people.is_empty() {
            "aucune".to_string()
        } else {
            p.people
                .iter()
                .map(|x| x.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        }
    )
}

pub fn parse_body(body: &str) -> Result<Planning> {
    let start = body.find("```json").context("bloc JSON du planning absent")?;
    let rest = &body[start + "```json".len()..];
    let end = rest.find("```").context("bloc JSON du planning non terminé")?;
    serde_json::from_str(rest[..end].trim()).context("planning illisible dans son issue")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, start: &str, end: &str, depends: &[&str]) -> Task {
        Task {
            id: id.into(),
            name: format!("Tâche {id}"),
            phase: "Étude".into(),
            start: start.into(),
            end: end.into(),
            people: vec![],
            depends: depends.iter().map(|d| d.to_string()).collect(),
            progress: 0,
            milestone: false,
            issue: None,
            notes: String::new(),
        }
    }

    fn planning() -> Planning {
        Planning {
            revision: 3,
            people: vec![Person {
                id: "remi".into(),
                name: "Rémi".into(),
            }],
            phases: vec!["Étude".into()],
            tasks: vec![
                task("a", "2026-10-19", "2026-10-23", &[]),
                task("b", "2026-10-26", "2026-11-06", &["a"]),
            ],
        }
    }

    #[test]
    fn accepts_a_valid_planning_and_round_trips() {
        let p = planning();
        validate(&p).unwrap();
        let body = render_body(&p);
        assert!(body.contains("- Tâches : 2 (du 2026-10-19 au 2026-11-06)"));
        assert!(body.contains("- Personnes : Rémi"));
        assert_eq!(parse_body(&body).unwrap(), p);
    }

    #[test]
    fn explains_what_is_wrong() {
        let err = |p: &Planning| validate(p).unwrap_err().to_string();
        let mut p = planning();
        p.tasks[1].end = "2026-10-01".into();
        assert!(err(&p).contains("finit (2026-10-01) avant de commencer"));
        let mut p = planning();
        p.tasks[0].people = vec!["marc".into()];
        assert!(err(&p).contains("affectée à « marc »"));
        let mut p = planning();
        p.tasks[0].depends = vec!["b".into()];
        assert!(
            err(&p).contains("en boucle : Tâche a → Tâche b → Tâche a"),
            "{}",
            err(&p)
        );
        let mut p = planning();
        p.tasks[1].id = "a".into();
        assert!(err(&p).contains("Tâche en double"));
        let mut p = planning();
        p.tasks[0].start = "19/10/2026".into();
        assert!(err(&p).contains("AAAA-MM-JJ"));
        let mut p = planning();
        p.tasks[0].id = "a b".into();
        assert!(err(&p).contains("Identifiant de tâche invalide"));
    }
}
