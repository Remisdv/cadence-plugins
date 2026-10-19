//! Sprint en cours : choix du milestone, burndown jour par jour, rythme et retard.
//!
//! Fonctions pures sur des jours civils `AAAA-MM-JJ` (les instants ISO sont tronqués au jour),
//! reprises de Cadence 1 (`domain/burndown.rs`). La portée est celle d'aujourd'hui : une issue
//! ajoutée en cours de sprint compte dès le premier jour (GitHub ne date pas l'entrée d'une issue
//! dans un milestone). Le début d'un sprint est son échéance moins la durée de sprint réglée.

use serde::Serialize;
use serde_json::Value;

use crate::model::Issue;

/// Garde-fou : un sprint de plus d'un an est une donnée aberrante, pas un burndown.
const MAX_POINTS: i64 = 366;

fn day(iso: &str) -> &str {
    iso.get(..10).unwrap_or(iso)
}

/// Jours depuis le 1970-01-01 (algorithme de H. Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Jour civil lu dans `AAAA-MM-JJ…`, en jours depuis 1970 ; `None` si la date est illisible.
fn day_number(date: &str) -> Option<i64> {
    let date = day(date.trim());
    let mut parts = date.split('-');
    let (y, m, d) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return None;
    }
    let (y, m, d) = (
        y.parse::<i64>().ok()?,
        m.parse::<i64>().ok()?,
        d.parse::<i64>().ok()?,
    );
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Vrai pour une date `AAAA-MM-JJ` lisible (éventuellement suivie d'une heure ISO).
pub fn is_date(date: &str) -> bool {
    day_number(date).is_some()
}

/// `2026-09-23` + 14 → `2026-10-07`. `None` si la date est illisible.
pub fn add_days(date: &str, days: i64) -> Option<String> {
    let (y, m, d) = civil_from_days(day_number(date)? + days);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// Jours civils de `from` à `to` (négatif si `to` est avant). `None` si une date est illisible.
pub fn days_between(from: &str, to: &str) -> Option<i64> {
    Some(day_number(to)? - day_number(from)?)
}

/// Date du jour (UTC), `AAAA-MM-JJ`.
pub fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Secondes écoulées depuis un instant ISO `AAAA-MM-JJTHH:MM:SSZ` (UTC) ; `None` s'il est illisible.
pub fn seconds_since(iso: &str) -> Option<i64> {
    let days = day_number(iso)?;
    let time = iso.get(11..19)?;
    let mut hms = time.split(':').map(|p| p.parse::<i64>().ok());
    let (h, m, s) = (hms.next()??, hms.next()??, hms.next()??);
    let then = days * 86_400 + h * 3_600 + m * 60 + s;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Some(now - then)
}

/// Sprint à résumer : parmi les milestones ouverts et datés, celui dont l'échéance à venir est
/// la plus proche ; à défaut (toutes dépassées), celui dont l'échéance est la plus récente.
pub fn current_sprint<'a>(milestones: &'a [Value], today: &str) -> Option<&'a Value> {
    let dated = || {
        milestones.iter().filter_map(|m| {
            let open = m["state"].as_str().is_none_or(|s| s == "open");
            let due = m["due_on"].as_str().filter(|d| is_date(d))?;
            open.then_some((days_between(today, due)?, m))
        })
    };
    dated()
        .filter(|(left, _)| *left >= 0)
        .min_by_key(|(left, _)| *left)
        .or_else(|| dated().max_by_key(|(left, _)| *left))
        .map(|(_, m)| m)
}

/// Bornes effectives d'un sprint : (début, échéance, dernier jour observé).
/// `None` si les dates sont illisibles, l'échéance avant le début, ou le sprint pas commencé.
fn window<'a>(start: &'a str, end: &'a str, today: &'a str) -> Option<(&'a str, &'a str, &'a str)> {
    let (start, end, today) = (day(start), day(end), day(today));
    if days_between(start, end)? < 0 || days_between(start, today)? < 0 {
        return None;
    }
    Some((start, end, if today < end { today } else { end }))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BurndownPoint {
    pub date: String,
    pub remaining: u32,
}

/// Issues encore ouvertes à la fin du jour `on`. `closed_on` : jour de fermeture de chaque
/// issue de la portée, `None` si elle est ouverte.
pub fn remaining_on(closed_on: &[Option<&str>], on: &str) -> u32 {
    let on = day(on);
    closed_on.iter().filter(|c| c.is_none_or(|c| day(c) > on)).count() as u32
}

/// Burndown du début du sprint jusqu'à aujourd'hui (ou l'échéance si elle est passée), un point
/// par jour. Vide si le sprint n'a pas commencé.
pub fn burndown(closed_on: &[Option<&str>], start: &str, end: &str, today: &str) -> Vec<BurndownPoint> {
    let Some((start, _, last)) = window(start, end, today) else {
        return vec![];
    };
    let days = days_between(start, last).unwrap_or(0).min(MAX_POINTS);
    (0..=days)
        .filter_map(|i| add_days(start, i))
        .map(|date| BurndownPoint {
            remaining: remaining_on(closed_on, &date),
            date,
        })
        .collect()
}

/// Issues fermées par jour écoulé depuis le début du sprint (le jour même compte pour un).
pub fn velocity(closed_on: &[Option<&str>], start: &str, end: &str, today: &str) -> f32 {
    let Some((start, _, last)) = window(start, end, today) else {
        return 0.0;
    };
    let closed = closed_on
        .iter()
        .flatten()
        .map(|c| day(c))
        .filter(|c| *c >= start && *c <= last)
        .count();
    let elapsed = days_between(start, last).unwrap_or(0).max(1);
    round1(closed as f32 / elapsed as f32)
}

/// Retard (positif) ou avance (négatif) en jours sur la droite idéale, qui va de `scope` issues
/// au début à zéro à l'échéance : écart entre aujourd'hui et le jour où la droite passe par le
/// reste actuel.
pub fn delay_days(scope: u32, remaining: u32, start: &str, end: &str, today: &str) -> f32 {
    let Some((start, end, last)) = window(start, end, today) else {
        return 0.0;
    };
    let length = days_between(start, end).unwrap_or(0);
    if scope == 0 || length == 0 {
        return 0.0;
    }
    let elapsed = days_between(start, last).unwrap_or(0) as f32;
    let on_track_at = length as f32 * (1.0 - remaining.min(scope) as f32 / scope as f32);
    round1(elapsed - on_track_at)
}

/// Avancement 0 → 100, arrondi.
pub fn progress(closed: u32, total: u32) -> u8 {
    if total == 0 {
        return 0;
    }
    ((closed.min(total) as f32 / total as f32) * 100.0).round() as u8
}

fn round1(x: f32) -> f32 {
    (x * 10.0).round() / 10.0
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StatusCounts {
    pub todo: u32,
    pub doing: u32,
    pub review: u32,
    pub done: u32,
}

impl StatusCounts {
    pub fn of(issues: &[Issue]) -> Self {
        let mut c = StatusCounts::default();
        for i in issues {
            match i.status {
                "doing" => c.doing += 1,
                "review" => c.review += 1,
                "done" => c.done += 1,
                _ => c.todo += 1,
            }
        }
        c
    }
}

/// Rythme d'un sprint, calculé sur ses issues.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pace {
    /// Début (`AAAA-MM-JJ`) : échéance moins la durée de sprint réglée.
    pub start_on: Option<String>,
    /// Échéance (`AAAA-MM-JJ`).
    pub due_on: Option<String>,
    /// Jours restants avant l'échéance (négatif si dépassée) ; `None` pour un palier.
    pub days_left: Option<i64>,
    /// Jours du sprint (début → échéance).
    pub length_days: Option<i64>,
    pub total: u32,
    pub closed: u32,
    pub progress: u8,
    pub counts: StatusCounts,
    /// Story points de toutes les issues estimées (`sp/<n>`).
    pub points_total: u32,
    /// Story points des issues fermées.
    pub points_done: u32,
    /// Issues sans estimation en story points.
    pub unestimated: u32,
    /// Issues fermées par jour écoulé.
    pub velocity: f32,
    /// Retard (positif) ou avance (négatif) sur la droite idéale, en jours.
    pub delay_days: f32,
    pub burndown: Vec<BurndownPoint>,
}

/// Rythme d'une version à partir de ses issues (toutes, ouvertes et fermées). Sans échéance
/// (palier), seuls l'avancement et les compteurs sont renseignés. Le début est `start_on` (sprint
/// automatique) ou, à défaut, l'échéance moins la durée de sprint réglée.
pub fn pace(
    issues: &[Issue],
    start_on: Option<&str>,
    due_on: Option<&str>,
    sprint_length_days: u32,
    today: &str,
) -> Pace {
    let closed_on: Vec<Option<&str>> = issues
        .iter()
        .map(|i| {
            (i.state == "closed").then(|| {
                i.closed_at
                    .as_deref()
                    .or(i.updated_at.as_deref())
                    .unwrap_or(today)
            })
        })
        .collect();
    let total = issues.len() as u32;
    let closed = closed_on.iter().filter(|c| c.is_some()).count() as u32;
    let mut out = Pace {
        start_on: None,
        due_on: None,
        days_left: None,
        length_days: None,
        total,
        closed,
        progress: progress(closed, total),
        counts: StatusCounts::of(issues),
        points_total: issues.iter().filter_map(|i| i.points).sum(),
        points_done: issues
            .iter()
            .filter(|i| i.state == "closed")
            .filter_map(|i| i.points)
            .sum(),
        unestimated: issues.iter().filter(|i| i.points.is_none()).count() as u32,
        velocity: 0.0,
        delay_days: 0.0,
        burndown: vec![],
    };
    let Some(due) = due_on.filter(|d| is_date(d)).map(|d| day(d).to_string()) else {
        return out;
    };
    let start = match start_on.filter(|d| is_date(d)) {
        Some(start) => day(start).to_string(),
        None => match add_days(&due, -i64::from(sprint_length_days.max(1))) {
            Some(start) => start,
            None => return out,
        },
    };
    let today = day(today);
    out.days_left = days_between(today, &due);
    out.length_days = days_between(&start, &due);
    out.burndown = burndown(&closed_on, &start, &due, today);
    out.velocity = velocity(&closed_on, &start, &due, today);
    let last = if today < due.as_str() { today } else { due.as_str() };
    out.delay_days = delay_days(total, remaining_on(&closed_on, last), &start, &due, today);
    out.start_on = Some(start);
    out.due_on = Some(due);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::issue_from;
    use serde_json::json;

    /// 6 issues : 2 fermées le 10, 1 le 12, 1 avant le sprint, 2 ouvertes.
    const SCOPE: [Option<&str>; 6] = [
        Some("2026-09-10T15:00:00Z"),
        Some("2026-09-10T09:00:00Z"),
        Some("2026-09-12T23:59:00Z"),
        Some("2026-09-01T10:00:00Z"),
        None,
        None,
    ];

    #[test]
    fn computes_civil_dates() {
        assert_eq!(
            add_days("2026-09-23T07:00:00Z", 14).as_deref(),
            Some("2026-10-07")
        );
        assert_eq!(add_days("2028-02-28", 1).as_deref(), Some("2028-02-29"));
        assert_eq!(days_between("2026-12-30", "2027-01-02"), Some(3));
        assert_eq!(days_between("2026-09-23", "2026-09-20"), Some(-3));
        assert!(is_date("2026-10-20") && is_date("2026-10-20T00:00:00Z"));
        assert!(!is_date("20-10-2026") && !is_date("2026-13-01") && !is_date("demain"));
        assert_eq!(today().len(), 10);
        assert!(seconds_since("2026-01-01T00:00:00Z").is_some_and(|s| s > 0));
        assert_eq!(seconds_since("2026-01-01"), None);
    }

    #[test]
    fn picks_the_nearest_open_dated_milestone() {
        let ms = vec![
            json!({"title": "0.1.1", "state": "closed", "due_on": "2026-10-18T07:00:00Z"}),
            json!({"title": "0.1.3", "state": "open", "due_on": "2026-11-03T07:00:00Z"}),
            json!({"title": "0.1.2", "state": "open", "due_on": "2026-10-20T07:00:00Z"}),
            json!({"title": "0.2.0", "state": "open", "due_on": null}),
        ];
        let title = |m: Option<&Value>| m.and_then(|m| m["title"].as_str()).map(str::to_string);
        assert_eq!(title(current_sprint(&ms, "2026-10-17")).as_deref(), Some("0.1.2"));
        // Échéance le jour même : encore le sprint en cours.
        assert_eq!(title(current_sprint(&ms, "2026-10-20")).as_deref(), Some("0.1.2"));
        assert_eq!(title(current_sprint(&ms, "2026-10-21")).as_deref(), Some("0.1.3"));
        // Toutes dépassées : la plus récente.
        assert_eq!(title(current_sprint(&ms, "2026-12-01")).as_deref(), Some("0.1.3"));
        assert_eq!(current_sprint(&ms[3..], "2026-10-17"), None);
    }

    #[test]
    fn burns_down_day_by_day_until_today() {
        let points = burndown(
            &SCOPE,
            "2026-09-09T07:00:00Z",
            "2026-09-23T07:00:00Z",
            "2026-09-13T10:00:00Z",
        );
        let remaining: Vec<(String, u32)> = points.into_iter().map(|p| (p.date, p.remaining)).collect();
        assert_eq!(
            remaining,
            [
                ("2026-09-09".to_string(), 5),
                ("2026-09-10".to_string(), 3),
                ("2026-09-11".to_string(), 3),
                ("2026-09-12".to_string(), 2),
                ("2026-09-13".to_string(), 2),
            ]
        );
        assert_eq!(
            burndown(&SCOPE, "2026-09-09", "2026-09-23", "2026-10-15").len(),
            15
        );
        assert!(burndown(&SCOPE, "2026-09-09", "2026-09-23", "2026-09-01").is_empty());
        assert!(burndown(&SCOPE, "2026-09-23", "2026-09-09", "2026-09-15").is_empty());
        assert!(burndown(&SCOPE, "nope", "2026-09-23", "2026-09-15").is_empty());
    }

    #[test]
    fn measures_velocity_and_delay() {
        assert_eq!(velocity(&SCOPE, "2026-09-09", "2026-09-23", "2026-09-13"), 0.8);
        assert_eq!(
            velocity(&[Some("2026-09-09")], "2026-09-09", "2026-09-23", "2026-09-09"),
            1.0
        );
        // 14 jours, 14 issues : la droite perd une issue par jour.
        assert_eq!(delay_days(14, 7, "2026-09-09", "2026-09-23", "2026-09-16"), 0.0);
        assert_eq!(delay_days(14, 9, "2026-09-09", "2026-09-23", "2026-09-16"), 2.0);
        assert_eq!(delay_days(14, 4, "2026-09-09", "2026-09-23", "2026-09-16"), -3.0);
        assert_eq!(delay_days(14, 2, "2026-09-09", "2026-09-23", "2026-10-15"), 2.0);
        assert_eq!(delay_days(0, 0, "2026-09-09", "2026-09-23", "2026-09-16"), 0.0);
        assert_eq!((progress(11, 18), progress(0, 0), progress(5, 3)), (61, 0, 100));
    }

    fn issue(state: &str, labels: &[&str], closed_at: Option<&str>) -> Issue {
        let labels: Vec<Value> = labels.iter().map(|l| json!({ "name": l })).collect();
        issue_from(
            &json!({ "number": 1, "state": state, "labels": labels, "closed_at": closed_at }),
            false,
        )
    }

    #[test]
    fn assembles_the_pace_of_a_sprint() {
        let issues = vec![
            issue("closed", &[], Some("2026-09-10T15:00:00Z")),
            issue("closed", &[], Some("2026-09-12T10:00:00Z")),
            issue("open", &["status/doing"], None),
            issue("open", &["status/review"], None),
            issue("open", &[], None),
            issue("open", &["status/todo"], None),
        ];
        let p = pace(&issues, None, Some("2026-09-23T07:00:00Z"), 14, "2026-09-13");
        assert_eq!(
            (p.start_on.as_deref(), p.due_on.as_deref()),
            (Some("2026-09-09"), Some("2026-09-23"))
        );
        assert_eq!((p.days_left, p.length_days), (Some(10), Some(14)));
        assert_eq!((p.total, p.closed, p.progress), (6, 2, 33));
        assert_eq!(
            p.counts,
            StatusCounts {
                todo: 2,
                doing: 1,
                review: 1,
                done: 2
            }
        );
        assert_eq!(p.burndown.len(), 5);
        assert_eq!(p.burndown.last().map(|b| b.remaining), Some(4));
        assert_eq!(p.velocity, 0.5);
        // 14 j, 6 issues, 4 restantes au jour 4 : la droite y passe au jour 4,7.
        assert_eq!(p.delay_days, -0.7);

        // Sprint de 7 jours réglé : début une semaine avant l'échéance.
        assert_eq!(
            pace(&issues, None, Some("2026-09-23"), 7, "2026-09-13")
                .start_on
                .as_deref(),
            Some("2026-09-16")
        );
        // Palier : avancement seulement.
        let palier = pace(&issues, None, None, 14, "2026-09-13");
        // Sprint automatique : début donné (une pause a repoussé l'échéance).
        let auto = pace(&issues, Some("2026-09-05"), Some("2026-09-23"), 14, "2026-09-13");
        assert_eq!(
            (auto.start_on.as_deref(), auto.length_days),
            (Some("2026-09-05"), Some(18))
        );
        assert_eq!(
            (palier.progress, palier.days_left, palier.burndown.len()),
            (33, None, 0)
        );
    }
}
