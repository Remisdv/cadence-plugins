//! Moteur des sprints automatiques, côté GitHub : issue d'état, milestones, branches `release/x`,
//! remplissage, clôture à l'échéance, fusion dans la branche par défaut et tag.
//!
//! Chaque Cadence ouvert fait avancer le projet (`reconcile`, à l'ouverture de l'écran Sprint et
//! toutes les dix minutes en fond). Toutes les étapes sont idempotentes : plusieurs membres de
//! l'équipe peuvent passer en même temps, une étape déjà faite est reconnue et sautée.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};

use crate::{
    model::{self, Issue},
    planning::{self, PLANNING_LABEL, PLANNING_TITLE, Planning},
    projet::{
        self, Jalon, ProjectState, ReleaseRecord, ReleaseStatus, RunStatus, STATE_LABEL, STATE_TITLE,
        SprintRecord,
    },
    server::GestionProjet,
    sprint,
};

/// Un passage de fond par dépôt suivi, à cet intervalle.
pub const TICK: Duration = Duration::from_secs(600);
/// L'écran Sprint relance une passe au plus une fois par minute et par dépôt.
const THROTTLE: Duration = Duration::from_secs(60);
/// Délai laissé à la CI pour s'annoncer sur une PR de release toute neuve.
const CI_GRACE_SECS: i64 = 300;

/// Issue d'état lue sur GitHub.
#[derive(Debug, Clone)]
pub struct Project {
    pub issue: u32,
    pub url: String,
    pub state: ProjectState,
}

impl GestionProjet {
    /* ---------- Issue d'état ---------- */

    /// Issue cachée (état des sprints, planning) d'un dépôt : celle déjà connue de ce processus,
    /// sinon la plus ancienne issue ouverte du label (deux créations simultanées : elle fait foi).
    pub(crate) async fn hidden_issue(&self, repo: &str, label: &str) -> Result<Option<Value>> {
        let key = format!("{repo}#{label}");
        let known = self
            .hidden_issues
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .copied();
        if let Some(n) = known
            && let Some(raw) = self.gh.get_opt(&format!("/repos/{repo}/issues/{n}"), &[]).await?
            && raw["state"].as_str() == Some("open")
        {
            return Ok(Some(raw));
        }
        let raw = self
            .gh
            .get(
                &format!("/repos/{repo}/issues"),
                &[
                    ("labels", label.into()),
                    ("state", "open".into()),
                    ("per_page", "10".into()),
                ],
            )
            .await?;
        let found = raw
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| !model::is_pull_request(i))
            .min_by_key(|i| i["number"].as_u64().unwrap_or(u64::MAX))
            .cloned();
        if let Some(n) = found.as_ref().and_then(|i| i["number"].as_u64()) {
            self.remember_hidden(repo, label, n as u32);
        }
        Ok(found)
    }

    pub(crate) fn remember_hidden(&self, repo: &str, label: &str, number: u32) {
        self.hidden_issues
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(format!("{repo}#{label}"), number);
    }

    /// Crée une issue cachée et la retient (la recherche par label peut tarder à la voir).
    async fn create_hidden(
        &self,
        repo: &str,
        label: &str,
        title: &str,
        body: String,
    ) -> Result<(u32, String)> {
        let raw = self
            .gh
            .post(
                &format!("/repos/{repo}/issues"),
                &json!({ "title": title, "body": body, "labels": [label] }),
            )
            .await?;
        let number = raw["number"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .context("numéro de l'issue créée illisible")?;
        self.remember_hidden(repo, label, number);
        Ok((number, raw["html_url"].as_str().unwrap_or("").to_string()))
    }

    pub(crate) async fn load_project(&self, repo: &str) -> Result<Option<Project>> {
        let Some(issue) = self.hidden_issue(repo, STATE_LABEL).await? else {
            return Ok(None);
        };
        let number = issue["number"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0);
        let state = projet::parse_body(issue["body"].as_str().unwrap_or(""))
            .with_context(|| format!("issue d'état #{number} de {repo}"))?;
        Ok(Some(Project {
            issue: number,
            url: issue["html_url"].as_str().unwrap_or("").to_string(),
            state,
        }))
    }

    async fn save_project(&self, repo: &str, project: &Project) -> Result<()> {
        self.gh
            .patch(
                &format!("/repos/{repo}/issues/{}", project.issue),
                &json!({ "body": projet::render_body(&project.state) }),
            )
            .await?;
        Ok(())
    }

    /* ---------- Briques GitHub ---------- */

    pub(crate) async fn default_branch(&self, repo: &str) -> Result<String> {
        let info = self.gh.get(&format!("/repos/{repo}"), &[]).await?;
        Ok(info["default_branch"].as_str().unwrap_or("main").to_string())
    }

    pub(crate) async fn branch_sha(&self, repo: &str, branch: &str) -> Result<Option<String>> {
        Ok(self
            .gh
            .get_opt(&format!("/repos/{repo}/git/ref/heads/{branch}"), &[])
            .await?
            .and_then(|r| r["object"]["sha"].as_str().map(str::to_string)))
    }

    /// Crée `branch` depuis `from` si elle n'existe pas.
    pub(crate) async fn ensure_branch(&self, repo: &str, branch: &str, from: &str) -> Result<()> {
        if self.branch_sha(repo, branch).await?.is_some() {
            return Ok(());
        }
        let sha = self.branch_sha(repo, from).await?.ok_or_else(|| {
            anyhow!("Branche « {from} » introuvable dans {repo} : impossible de créer « {branch} ».")
        })?;
        match self
            .gh
            .post(
                &format!("/repos/{repo}/git/refs"),
                &json!({ "ref": format!("refs/heads/{branch}"), "sha": sha }),
            )
            .await
        {
            Ok(_) => Ok(()),
            // Créée entre-temps par un autre Cadence.
            Err(e) if e.to_string().contains("already exists") => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Milestone du sprint : créé s'il manque, rouvert et redaté s'il le faut. Rend son numéro.
    async fn ensure_milestone(
        &self,
        repo: &str,
        record: &SprintRecord,
        index: usize,
        state_issue: u32,
    ) -> Result<u32> {
        let all = self.milestones(repo, "all").await?;
        let due = model::due_on_param(&record.due_on)?;
        if let Some(m) = model::find_milestone(&all, &record.version, &self.settings().tag_prefix) {
            let number = m["number"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .context("numéro de milestone illisible")?;
            let same_day = m["due_on"].as_str().and_then(|d| d.get(..10))
                == Some(&record.due_on[..10.min(record.due_on.len())]);
            let open = m["state"].as_str() == Some("open");
            if !same_day || !open {
                self.gh
                    .patch(
                        &format!("/repos/{repo}/milestones/{number}"),
                        &json!({ "due_on": due, "state": "open" }),
                    )
                    .await?;
            }
            return Ok(number);
        }
        let raw = self
            .gh
            .post(
                &format!("/repos/{repo}/milestones"),
                &json!({
                    "title": record.version,
                    "due_on": due,
                    "description": format!(
                        "# Sprint {}\n\nSprint automatique géré par Cadence (issue d'état #{state_issue}), branche `{}`.",
                        index + 1,
                        record.branch()
                    ),
                }),
            )
            .await?;
        raw["number"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .context("numéro de milestone illisible")
    }

    async fn set_milestone(&self, repo: &str, issue: u32, milestone: Option<u32>) -> Result<()> {
        let raw = self
            .gh
            .patch(
                &format!("/repos/{repo}/issues/{issue}"),
                &json!({ "milestone": milestone }),
            )
            .await?;
        self.remember_issue(repo, &raw);
        Ok(())
    }

    /// Issues ouvertes du dépôt (descriptions comprises), sans l'issue d'état.
    async fn open_issues(&self, repo: &str) -> Result<Vec<Issue>> {
        let mut raws: Vec<Value> = Vec::new();
        for page in 1..=10u32 {
            let p = self
                .gh
                .get_page(
                    &format!("/repos/{repo}/issues"),
                    &[
                        ("state", "open".into()),
                        ("per_page", "100".into()),
                        ("page", page.to_string()),
                    ],
                )
                .await?;
            raws.extend(p.body.as_array().cloned().unwrap_or_default());
            if !p.has_next {
                break;
            }
        }
        // Issue tout juste déplacée (ajoutée au sprint, rendue au carnet) ou fermée : la réponse de
        // l'écriture fait foi tant que la liste de GitHub ne la reflète pas (N08).
        let raws = self.patch_listing(repo, raws, |raw| raw["state"].as_str() == Some("open"));
        Ok(raws
            .iter()
            .filter(|raw| !model::is_pull_request(raw) && !model::is_state_issue(raw))
            .map(|raw| model::issue_in(repo, raw, true))
            .collect())
    }

    /// Ajoute au sprint (milestone `number`) les issues du backlog qui tiennent dans `budget`.
    async fn pull_into_sprint(
        &self,
        repo: &str,
        number: u32,
        sprint_issues: &[Issue],
        budget: u32,
        at_least_one: bool,
        order: &HashMap<u32, usize>,
    ) -> Result<Vec<u32>> {
        let open = self.open_issues(repo).await?;
        let open_set: HashSet<u32> = open.iter().map(|i| i.number).collect();
        let in_sprint: HashSet<u32> = sprint_issues.iter().map(|i| i.number).collect();
        let backlog: Vec<Issue> = open.into_iter().filter(|i| i.milestone.is_none()).collect();
        let picks = projet::select(&backlog, budget, &open_set, &in_sprint, at_least_one, order);
        for n in &picks {
            self.set_milestone(repo, *n, Some(number)).await?;
        }
        Ok(picks)
    }

    /* ---------- Passe du moteur ---------- */

    /// Passe complète si la dernière date de plus d'une minute ; sinon simple lecture.
    pub(crate) async fn reconcile_throttled(&self, repo: &str) -> Result<Option<Project>> {
        let due = {
            let mut last = self.last_pass.lock().unwrap_or_else(|e| e.into_inner());
            let due = last.get(repo).is_none_or(|t| t.elapsed() >= THROTTLE);
            if due {
                last.insert(repo.to_string(), Instant::now());
            }
            due
        };
        if due {
            self.reconcile(repo).await
        } else {
            self.load_project(repo).await
        }
    }

    /// Fait avancer les sprints automatiques d'un dépôt ; `None` s'ils ne sont pas démarrés.
    pub(crate) async fn reconcile(&self, repo: &str) -> Result<Option<Project>> {
        let _guard = self.engine_lock.lock().await;
        match self.load_project(repo).await? {
            Some(project) => Ok(Some(self.advance(repo, project).await?)),
            None => Ok(None),
        }
    }

    /// Passe du moteur sur un état déjà lu (ou tout juste écrit : la recherche par label de
    /// GitHub peut ne pas le voir encore). L'appelant tient `engine_lock`.
    async fn advance(&self, repo: &str, mut project: Project) -> Result<Project> {
        let before = project.state.clone();
        let today = sprint::today();

        // 1. Échéance passée : clôture et sprint suivant (bornée si Cadence est resté fermé longtemps).
        if project.state.status == RunStatus::Running
            && project.state.current().is_some_and(|c| today > c.due_on)
        {
            self.roll_over(repo, &mut project, &today, &[]).await?;
        }

        // 2. Sprint en cours : milestone, branche de release, remplissage initial.
        if let Some(number) = self.ensure_current(repo, &mut project).await? {
            // 3. Fini en avance : les issues suivantes entrent dans le sprint.
            let cur = project.state.current().cloned();
            if let Some(cur) = cur.filter(|c| c.filled && today <= c.due_on)
                && project.state.status == RunStatus::Running
            {
                let issues = self.milestone_issues(repo, number).await?;
                if !issues.is_empty() && issues.iter().all(|i| i.state == "closed") {
                    let days_left = sprint::days_between(&today, &cur.due_on).unwrap_or(0) + 1;
                    let budget =
                        projet::capacity_for(project.state.points_per_day(), days_left.max(1) as u32);
                    let order = project.state.jalon_order();
                    let added = self
                        .pull_into_sprint(repo, number, &issues, budget, true, &order)
                        .await?;
                    if !added.is_empty() {
                        tracing::info!(
                            repo,
                            sprint = cur.version,
                            ?added,
                            "sprint fini en avance : issues suivantes ajoutées"
                        );
                    }
                }
            }
        }

        // 4. Sprints terminés : fusion de release/x dans la branche par défaut, puis tag.
        let last = project.state.sprints.len().saturating_sub(1);
        for i in 0..last {
            let pending = project.state.sprints[i]
                .release
                .as_ref()
                .is_some_and(|r| matches!(r.status, ReleaseStatus::Pending | ReleaseStatus::Blocked));
            if pending {
                let record = project.state.sprints[i].clone();
                let next = self.ship(repo, &record, false).await;
                project.state.sprints[i].release = Some(next);
            }
        }

        if project.state != before {
            self.save_project(repo, &project).await?;
        }
        Ok(project)
    }

    /// Prépare le sprint en cours ; rend le numéro de son milestone.
    async fn ensure_current(&self, repo: &str, project: &mut Project) -> Result<Option<u32>> {
        let index = project.state.sprints.len().checked_sub(1);
        let Some(index) = index else { return Ok(None) };
        let record = project.state.sprints[index].clone();
        let number = self.ensure_milestone(repo, &record, index, project.issue).await?;

        // La branche part de la release précédente si elle n'est pas encore fusionnée.
        let previous = index
            .checked_sub(1)
            .map(|i| &project.state.sprints[i])
            .filter(|p| {
                !p.release
                    .as_ref()
                    .is_some_and(|r| matches!(r.status, ReleaseStatus::Merged | ReleaseStatus::Empty))
            });
        let from = match previous {
            Some(p) if self.branch_sha(repo, &p.branch()).await?.is_some() => p.branch(),
            _ => self.default_branch(repo).await?,
        };
        self.ensure_branch(repo, &record.branch(), &from).await?;

        if !record.filled {
            let mut issues = self.milestone_issues(repo, number).await?;
            // Les issues reportées comptent même si la liste du milestone ne les montre pas encore
            // (GitHub met quelques secondes à refléter un changement de milestone).
            if record
                .carried
                .iter()
                .any(|n| !issues.iter().any(|i| i.number == *n))
            {
                let missing: Vec<Issue> = self
                    .open_issues(repo)
                    .await?
                    .into_iter()
                    .filter(|i| record.carried.contains(&i.number))
                    .filter(|i| !issues.iter().any(|x| x.number == i.number))
                    .collect();
                issues.extend(missing);
            }
            let load: u32 = issues.iter().map(projet::weight).sum();
            let budget = record.capacity.saturating_sub(load);
            let order = project.state.jalon_order();
            let added = self
                .pull_into_sprint(repo, number, &issues, budget, issues.is_empty(), &order)
                .await?;
            tracing::info!(repo, sprint = record.version, ?added, budget, "sprint rempli");
            if let Some(cur) = project.state.current_mut() {
                cur.filled = true;
            }
        }
        Ok(Some(number))
    }

    /// Clôt le sprint échu : relevé des points, report des issues ouvertes et des PR, sprint suivant.
    /// `to_backlog` : issues ouvertes que l'utilisateur rend au carnet au lieu de les reporter
    /// (excédent sur la capacité du sprint suivant, N13).
    async fn roll_over(
        &self,
        repo: &str,
        project: &mut Project,
        today: &str,
        to_backlog: &[u32],
    ) -> Result<()> {
        let prefix = self.settings().tag_prefix;
        let index = project.state.sprints.len() - 1;
        let cur = project.state.sprints[index].clone();
        let number = self.ensure_milestone(repo, &cur, index, project.issue).await?;
        let issues = self.milestone_issues(repo, number).await?;
        let done: u32 = issues
            .iter()
            .filter(|i| i.state == "closed")
            .map(projet::weight)
            .sum();
        let scope: u32 = issues.iter().map(projet::weight).sum();
        let (released, carried): (Vec<u32>, Vec<u32>) = issues
            .iter()
            .filter(|i| i.state == "open")
            .map(|i| i.number)
            .partition(|n| to_backlog.contains(n));

        // Versions déjà livrées ou closes : jamais réutilisées (un milestone ouvert du même nom
        // est celui d'une passe interrompue, il est repris).
        let mut taken: Vec<String> = self
            .milestones(repo, "closed")
            .await?
            .iter()
            .filter_map(|m| m["title"].as_str().map(str::to_string))
            .collect();
        taken.extend(
            self.releases(repo)
                .await?
                .iter()
                .filter_map(|r| r["tag_name"].as_str().map(str::to_string)),
        );
        taken.retain(|t| t != &cur.version);
        let version = projet::version_after(&cur.version, &taken, &prefix);

        {
            let c = &mut project.state.sprints[index];
            c.done_points = Some(done);
            c.scope_points = Some(scope);
            c.ended_on = Some(today.to_string());
            c.release = Some(ReleaseRecord::pending());
        }
        let duration = project.state.duration_days;
        let next = SprintRecord {
            version: version.clone(),
            start_on: today.to_string(),
            due_on: projet::due_for(today, duration, 0, today),
            paused_days: 0,
            capacity: project.state.next_capacity(),
            filled: false,
            carried: carried.clone(),
            done_points: None,
            scope_points: None,
            ended_on: None,
            release: None,
        };
        project.state.sprints.push(next.clone());

        let new_number = self
            .ensure_milestone(repo, &next, index + 1, project.issue)
            .await?;
        let from = if self.branch_sha(repo, &cur.branch()).await?.is_some() {
            cur.branch()
        } else {
            self.default_branch(repo).await?
        };
        self.ensure_branch(repo, &next.branch(), &from).await?;
        for n in &carried {
            self.set_milestone(repo, *n, Some(new_number)).await?;
        }
        for n in &released {
            self.set_milestone(repo, *n, None).await?;
        }
        // PR encore ouvertes vers l'ancienne branche : elles visent la nouvelle.
        let open_prs = self
            .gh
            .get(
                &format!("/repos/{repo}/pulls"),
                &[
                    ("state", "open".into()),
                    ("base", cur.branch()),
                    ("per_page", "100".into()),
                ],
            )
            .await?;
        for pr in open_prs.as_array().into_iter().flatten() {
            if let Some(n) = pr["number"].as_u64() {
                self.gh
                    .patch(
                        &format!("/repos/{repo}/pulls/{n}"),
                        &json!({ "base": next.branch() }),
                    )
                    .await?;
            }
        }
        self.gh
            .patch(
                &format!("/repos/{repo}/milestones/{number}"),
                &json!({ "state": "closed" }),
            )
            .await?;
        tracing::info!(
            repo,
            from = cur.version,
            to = version,
            done,
            ?carried,
            ?released,
            "sprint clos, sprint suivant ouvert"
        );
        Ok(())
    }

    /// Livraison d'un sprint terminé : PR `release/x` → branche par défaut, fusion quand la CI
    /// est verte, puis release taguée. Une erreur bloque la livraison sans arrêter le moteur.
    /// `now` : l'utilisateur demande la fusion sans attendre qu'une CI s'annonce.
    async fn ship(&self, repo: &str, record: &SprintRecord, now: bool) -> ReleaseRecord {
        let previous = record.release.clone().unwrap_or_else(ReleaseRecord::pending);
        match self.try_ship(repo, record, &previous, now).await {
            Ok(next) => next,
            Err(err) => ReleaseRecord {
                status: ReleaseStatus::Blocked,
                message: Some(format!("{err:#}")),
                no_ci: false,
                ..previous
            },
        }
    }

    async fn try_ship(
        &self,
        repo: &str,
        record: &SprintRecord,
        previous: &ReleaseRecord,
        now: bool,
    ) -> Result<ReleaseRecord> {
        let prefix = self.settings().tag_prefix;
        let tag = model::tag_name(&prefix, &record.version)?;
        let branch = record.branch();
        let base = self.default_branch(repo).await?;
        let status = |status, pull_request, message: Option<String>| ReleaseRecord {
            status,
            pull_request,
            tag: None,
            message,
            no_ci: false,
        };

        let owner = repo.split_once('/').map(|(o, _)| o).unwrap_or(repo);
        let prs = self
            .gh
            .get(
                &format!("/repos/{repo}/pulls"),
                &[
                    ("state", "all".into()),
                    ("head", format!("{owner}:{branch}")),
                    ("base", base.clone()),
                    ("per_page", "20".into()),
                ],
            )
            .await?;
        let prs: Vec<&Value> = prs.as_array().into_iter().flatten().collect();
        if let Some(merged) = prs.iter().find(|p| !p["merged_at"].is_null()) {
            let sha = merged["merge_commit_sha"].as_str().unwrap_or("").to_string();
            let n = merged["number"].as_u64().map(|n| n as u32);
            return self.tag_release(repo, record, &tag, &sha, n).await;
        }

        if self.branch_sha(repo, &branch).await?.is_none() {
            return Ok(status(
                ReleaseStatus::Empty,
                None,
                Some(format!("Branche {branch} absente : rien à livrer.")),
            ));
        }
        let compare = self
            .gh
            .get_opt(&format!("/repos/{repo}/compare/{base}...{branch}"), &[])
            .await?
            .unwrap_or(Value::Null);
        if compare["ahead_by"].as_u64().unwrap_or(0) == 0 {
            return Ok(status(
                ReleaseStatus::Empty,
                None,
                Some(format!("Aucun commit sur {branch} : rien à livrer.")),
            ));
        }

        let still_open = self
            .gh
            .get(
                &format!("/repos/{repo}/pulls"),
                &[("state", "open".into()), ("base", branch.clone())],
            )
            .await?;
        let still_open: Vec<String> = still_open
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p["number"].as_u64().map(|n| format!("#{n}")))
            .collect();
        if !still_open.is_empty() {
            return Ok(status(
                ReleaseStatus::Blocked,
                previous.pull_request,
                Some(format!(
                    "Pull requests encore ouvertes vers {branch} : {}.",
                    still_open.join(", ")
                )),
            ));
        }

        let pr = match prs.iter().find(|p| p["state"].as_str() == Some("open")) {
            Some(p) => (*p).clone(),
            None => {
                self.gh
                    .post(
                        &format!("/repos/{repo}/pulls"),
                        &json!({
                            "title": format!("Release {}", record.version),
                            "head": branch,
                            "base": base,
                            "draft": false,
                            "body": format!(
                                "Fin du sprint {} (du {} au {}) : fusion de `{branch}` dans `{base}`.\n\n\
                                 _PR ouverte par Cadence (sprints automatiques) : fusionnée dès que la CI est verte, puis la version est taguée `{tag}`._",
                                record.version,
                                record.start_on,
                                record.ended_on.as_deref().unwrap_or(&record.due_on),
                            ),
                        }),
                    )
                    .await?
            }
        };
        let number = pr["number"]
            .as_u64()
            .map(|n| n as u32)
            .context("numéro de PR illisible")?;
        // Détail : `mergeable` n'est calculé que sur une PR lue seule.
        let detail = self.gh.get(&format!("/repos/{repo}/pulls/{number}"), &[]).await?;
        let sha = detail["head"]["sha"].as_str().unwrap_or("").to_string();
        let age = detail["created_at"]
            .as_str()
            .and_then(sprint::seconds_since)
            .unwrap_or(i64::MAX);

        match self.ci_state(repo, &sha).await? {
            Ci::Failure => {
                return Ok(status(
                    ReleaseStatus::Blocked,
                    Some(number),
                    Some(format!("CI en échec sur la PR #{number}.")),
                ));
            }
            Ci::Pending => {
                return Ok(status(
                    ReleaseStatus::Pending,
                    Some(number),
                    Some(format!("CI en cours sur la PR #{number}.")),
                ));
            }
            // Aucune vérification : on n'attend une CI que si le dépôt a des workflows (N14).
            Ci::None if !now && age < CI_GRACE_SECS && self.has_workflows(repo).await => {
                return Ok(ReleaseRecord {
                    no_ci: true,
                    ..status(
                        ReleaseStatus::Pending,
                        Some(number),
                        Some(format!(
                            "PR #{number} ouverte : aucune vérification encore, en attente de la CI."
                        )),
                    )
                });
            }
            Ci::None | Ci::Success => {}
        }
        match detail["mergeable"].as_bool() {
            None => {
                return Ok(status(
                    ReleaseStatus::Pending,
                    Some(number),
                    Some(format!("GitHub vérifie que la PR #{number} peut être fusionnée.")),
                ));
            }
            Some(false) => {
                return Ok(status(
                    ReleaseStatus::Blocked,
                    Some(number),
                    Some(format!(
                        "Conflit entre {branch} et {base} (PR #{number}) : à résoudre à la main."
                    )),
                ));
            }
            Some(true) => {}
        }
        let merged = self
            .gh
            .put(
                &format!("/repos/{repo}/pulls/{number}/merge"),
                &json!({ "merge_method": "merge", "commit_title": format!("Release {} (#{number})", record.version), "sha": sha }),
            )
            .await?;
        let merge_sha = merged["sha"].as_str().unwrap_or("").to_string();
        tracing::info!(repo, version = record.version, pr = number, "release fusionnée");
        self.tag_release(repo, record, &tag, &merge_sha, Some(number))
            .await
    }

    async fn tag_release(
        &self,
        repo: &str,
        record: &SprintRecord,
        tag: &str,
        sha: &str,
        pr: Option<u32>,
    ) -> Result<ReleaseRecord> {
        let exists = self
            .releases(repo)
            .await?
            .iter()
            .any(|r| r["tag_name"].as_str() == Some(tag));
        if !exists {
            let mut body = json!({
                "tag_name": tag,
                "name": tag,
                "draft": false,
                "generate_release_notes": true,
            });
            if !sha.is_empty() {
                body["target_commitish"] = json!(sha);
            }
            self.gh.post(&format!("/repos/{repo}/releases"), &body).await?;
            tracing::info!(repo, version = record.version, tag, "release publiée");
        }
        Ok(ReleaseRecord {
            status: ReleaseStatus::Merged,
            pull_request: pr,
            tag: Some(tag.to_string()),
            message: None,
            no_ci: false,
        })
    }

    /// Le dépôt a-t-il des workflows GitHub Actions ? Dans le doute (droits, Actions désactivées
    /// renvoyant une erreur), oui : on laisse à la CI le temps de s'annoncer.
    async fn has_workflows(&self, repo: &str) -> bool {
        match self
            .gh
            .get_opt(
                &format!("/repos/{repo}/actions/workflows"),
                &[("per_page", "1".into())],
            )
            .await
        {
            Ok(Some(v)) => v["total_count"].as_u64().unwrap_or(1) > 0,
            Ok(None) => false,
            Err(_) => true,
        }
    }

    /// Fusion immédiate de la release d'un sprint terminé (« Fusionner maintenant » de l'écran,
    /// quand aucune CI ne s'annonce) : mêmes contrôles qu'à l'ordinaire (CI en échec ou en cours,
    /// conflit), sans le délai d'attente de la CI.
    pub(crate) async fn ship_release_now(&self, repo: &str, version: &str) -> Result<Project> {
        let _guard = self.engine_lock.lock().await;
        let mut project = self.require_started(repo).await?;
        let last = project.state.sprints.len().saturating_sub(1);
        let index = project.state.sprints[..last]
            .iter()
            .position(|s| s.version == version)
            .ok_or_else(|| anyhow!("Aucun sprint terminé {version} dans {repo}."))?;
        let record = project.state.sprints[index].clone();
        if record
            .release
            .as_ref()
            .is_some_and(|r| matches!(r.status, ReleaseStatus::Merged | ReleaseStatus::Empty))
        {
            bail!("La release {version} est déjà livrée.");
        }
        let next = self.ship(repo, &record, true).await;
        project.state.sprints[index].release = Some(next);
        self.save_project(repo, &project).await?;
        Ok(project)
    }

    /// État de la CI d'un commit : checks (Actions…) et statuts (services externes).
    async fn ci_state(&self, repo: &str, sha: &str) -> Result<Ci> {
        if sha.is_empty() {
            return Ok(Ci::Pending);
        }
        let runs = self
            .gh
            .get(
                &format!("/repos/{repo}/commits/{sha}/check-runs"),
                &[("per_page", "100".into())],
            )
            .await?;
        let statuses = self
            .gh
            .get(&format!("/repos/{repo}/commits/{sha}/status"), &[])
            .await?;
        let mut states: Vec<Ci> = runs["check_runs"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| match (r["status"].as_str(), r["conclusion"].as_str()) {
                (Some("completed"), Some("success" | "neutral" | "skipped")) => Ci::Success,
                (Some("completed"), _) => Ci::Failure,
                _ => Ci::Pending,
            })
            .collect();
        if statuses["total_count"].as_u64().unwrap_or(0) > 0 {
            states.push(match statuses["state"].as_str() {
                Some("success") => Ci::Success,
                Some("pending") => Ci::Pending,
                _ => Ci::Failure,
            });
        }
        Ok(if states.is_empty() {
            Ci::None
        } else if states.contains(&Ci::Failure) {
            Ci::Failure
        } else if states.contains(&Ci::Pending) {
            Ci::Pending
        } else {
            Ci::Success
        })
    }

    /* ---------- Commandes de l'écran Sprint ---------- */

    pub(crate) async fn start_project(
        &self,
        repo: &str,
        duration_days: u32,
        capacity: u32,
        first_version: Option<String>,
    ) -> Result<Project> {
        let duration_days = projet::check_duration(duration_days)?;
        if !(1..=500).contains(&capacity) {
            bail!("Capacité invalide : {capacity} story points (de 1 à 500).");
        }
        let _guard = self.engine_lock.lock().await;
        let existing = self.load_project(repo).await?;
        if let Some(p) = existing.as_ref().filter(|p| !p.state.sprints.is_empty()) {
            bail!(
                "Les sprints de {repo} sont déjà démarrés (issue d'état #{}).",
                p.issue
            );
        }
        let prefix = self.settings().tag_prefix;
        let milestones = self.milestones(repo, "all").await?;
        let version = match first_version.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            Some(v) => {
                let v = v
                    .strip_prefix(prefix.as_str())
                    .filter(|_| !prefix.is_empty())
                    .unwrap_or(v);
                if !projet::is_semver(v) {
                    bail!("Version invalide : « {v} » (attendu : majeur.mineur.correctif, ex. 0.1.0).");
                }
                if let Some(m) = model::find_milestone(&milestones, v, &prefix)
                    && m["state"].as_str() == Some("closed")
                {
                    bail!("La version {v} existe déjà et est close : choisissez-en une autre.");
                }
                v.to_string()
            }
            None => {
                let titles: Vec<String> = milestones
                    .iter()
                    .filter_map(|m| m["title"].as_str().map(str::to_string))
                    .collect();
                projet::next_version(&titles, &prefix)
            }
        };
        let today = sprint::today();
        let state = ProjectState {
            status: RunStatus::Running,
            duration_days,
            initial_points_per_day: capacity as f32 / duration_days as f32,
            paused_since: None,
            sprints: vec![SprintRecord {
                version,
                start_on: today.clone(),
                due_on: projet::due_for(&today, duration_days, 0, &today),
                paused_days: 0,
                capacity,
                filled: false,
                carried: vec![],
                done_points: None,
                scope_points: None,
                ended_on: None,
                release: None,
            }],
            jalons: existing
                .as_ref()
                .map(|p| p.state.jalons.clone())
                .unwrap_or_default(),
            designs: existing
                .as_ref()
                .map(|p| p.state.designs.clone())
                .unwrap_or_default(),
        };
        let project = match existing {
            Some(p) => {
                let project = Project { state, ..p };
                self.save_project(repo, &project).await?;
                project
            }
            None => self.create_state_issue(repo, state).await?,
        };
        self.advance(repo, project).await
    }

    pub(crate) async fn pause_project(&self, repo: &str, pause: bool) -> Result<Project> {
        let _guard = self.engine_lock.lock().await;
        let mut project = self.require_started(repo).await?;
        let today = sprint::today();
        match (pause, project.state.status) {
            (true, RunStatus::Running) => {
                project.state.status = RunStatus::Paused;
                project.state.paused_since = Some(today);
            }
            (false, RunStatus::Paused) => {
                let since = project.state.paused_since.take().unwrap_or_else(|| today.clone());
                let days = sprint::days_between(&since, &today).unwrap_or(0).max(0) as u32;
                project.state.status = RunStatus::Running;
                if let Some(cur) = project.state.current_mut() {
                    cur.paused_days += days;
                    cur.due_on = sprint::add_days(&cur.due_on, i64::from(days)).unwrap_or(cur.due_on.clone());
                }
            }
            _ => return Ok(project),
        }
        self.save_project(repo, &project).await?;
        self.advance(repo, project).await
    }

    /// Change la durée des sprints. `current` : elle s'applique aussi au sprint en cours
    /// (échéance du milestone recalculée, portée ajustée à la nouvelle capacité) ; sinon seulement
    /// à partir du sprint suivant : le sprint en cours garde son échéance et sa portée.
    pub(crate) async fn set_duration(
        &self,
        repo: &str,
        duration_days: u32,
        current: bool,
    ) -> Result<Project> {
        let duration_days = projet::check_duration(duration_days)?;
        let _guard = self.engine_lock.lock().await;
        let mut project = self.require_project(repo).await?;
        let today = sprint::today();
        project.state.duration_days = duration_days;
        if project.state.sprints.is_empty() || !current {
            self.save_project(repo, &project).await?;
            return Ok(project);
        }
        let target = project.state.next_capacity();
        let index = project
            .state
            .sprints
            .len()
            .checked_sub(1)
            .context("aucun sprint")?;
        {
            let cur = &mut project.state.sprints[index];
            cur.due_on = projet::due_for(&cur.start_on, duration_days, cur.paused_days, &today);
            cur.capacity = target;
        }
        let cur = project.state.sprints[index].clone();
        let number = self.ensure_milestone(repo, &cur, index, project.issue).await?;
        if cur.filled {
            let issues = self.milestone_issues(repo, number).await?;
            let load: u32 = issues.iter().map(projet::weight).sum();
            let order = project.state.jalon_order();
            if load < target {
                self.pull_into_sprint(repo, number, &issues, target - load, issues.is_empty(), &order)
                    .await?;
            } else {
                for n in projet::trim(&issues, &cur.carried, target, &order) {
                    self.set_milestone(repo, n, None).await?;
                }
            }
        }
        self.save_project(repo, &project).await?;
        self.advance(repo, project).await
    }

    /// Clôt le sprint en cours avant son échéance (à la demande de l'utilisateur) : comme à
    /// l'échéance, issues ouvertes et PR reportées au sprint suivant, qui commence aujourd'hui,
    /// milestone fermé, puis livraison de la branche de release. `version` : le sprint que
    /// l'utilisateur a vu (refus s'il a changé entre-temps).
    pub(crate) async fn close_sprint_now(
        &self,
        repo: &str,
        version: Option<&str>,
        to_backlog: &[u32],
    ) -> Result<Project> {
        let _guard = self.engine_lock.lock().await;
        let mut project = self.require_started(repo).await?;
        if project.state.status != RunStatus::Running {
            bail!("Sprints en pause : reprenez-les avant de clore le sprint en cours.");
        }
        let cur = project.state.current().cloned().context("aucun sprint")?;
        if let Some(v) = version.map(str::trim).filter(|v| !v.is_empty())
            && v != cur.version
        {
            bail!(
                "Le sprint en cours est {} (et non {v}) : rafraîchissez l'écran avant de le clore.",
                cur.version
            );
        }
        let today = sprint::today();
        self.roll_over(repo, &mut project, &today, to_backlog).await?;
        self.save_project(repo, &project).await?;
        self.advance(repo, project).await
    }

    /// Ajoute des issues au sprint en cours (son milestone) ou les en retire (sans version). Les
    /// issues fermées, inconnues ou déjà à leur place sont signalées sans bloquer les autres.
    pub(crate) async fn move_sprint_issues(&self, repo: &str, add: &[u32], remove: &[u32]) -> Result<Value> {
        let _guard = self.engine_lock.lock().await;
        let project = self.require_started(repo).await?;
        let cur = project.state.current().cloned().context("aucun sprint")?;
        let index = project.state.sprints.len() - 1;
        let number = self.ensure_milestone(repo, &cur, index, project.issue).await?;
        let mut added = Vec::new();
        let mut removed = Vec::new();
        let mut skipped: Vec<Value> = Vec::new();
        let wanted = add
            .iter()
            .map(|n| (*n, true))
            .chain(remove.iter().map(|n| (*n, false)));
        for (n, into) in wanted {
            let raw = match self.gh.get_opt(&format!("/repos/{repo}/issues/{n}"), &[]).await? {
                Some(raw) if !model::is_pull_request(&raw) && !model::is_state_issue(&raw) => raw,
                _ => {
                    skipped.push(json!({ "issue": n, "reason": "issue introuvable" }));
                    continue;
                }
            };
            let in_sprint = raw["milestone"]["number"].as_u64() == Some(u64::from(number));
            if into && raw["state"].as_str() != Some("open") {
                skipped.push(json!({ "issue": n, "reason": "issue fermée" }));
            } else if into == in_sprint {
                let reason = if into {
                    "déjà dans le sprint"
                } else {
                    "pas dans le sprint"
                };
                skipped.push(json!({ "issue": n, "reason": reason }));
            } else {
                self.set_milestone(repo, n, into.then_some(number)).await?;
                if into {
                    added.push(n);
                } else {
                    removed.push(n);
                }
            }
        }
        Ok(json!({
            "repo": repo, "version": cur.version, "milestone": number,
            "added": added, "removed": removed, "skipped": skipped,
        }))
    }

    /// Issues sans version, dans l'ordre où le remplissage les prendrait : ordre des jalons de la
    /// roadmap, puis priorité et numéro ; chacune avec son jalon et son poids en SP.
    pub(crate) async fn read_backlog(&self, repo: &str) -> Result<Value> {
        let project = self.load_project(repo).await?;
        let state = project.as_ref().map(|p| &p.state);
        let order = state.map(ProjectState::jalon_order).unwrap_or_default();
        let mut backlog: Vec<Issue> = self
            .open_issues(repo)
            .await?
            .into_iter()
            .filter(|i| i.milestone.is_none())
            .collect();
        backlog.sort_by_key(|i| projet::rank(i, &order));
        let issues: Vec<Value> = backlog
            .iter()
            .map(|i| {
                let jalon = order
                    .get(&i.number)
                    .and_then(|k| state.and_then(|s| s.jalons.get(*k)))
                    .map(|j| json!({ "id": j.id, "name": j.name }));
                let mut v = serde_json::to_value(i).unwrap_or(Value::Null);
                if let Some(o) = v.as_object_mut() {
                    o.remove("body");
                    o.insert("jalon".into(), jalon.unwrap_or(Value::Null));
                    o.insert("weight".into(), json!(projet::weight(i)));
                }
                v
            })
            .collect();
        Ok(json!({ "repo": repo, "issues": issues }))
    }

    async fn require_started(&self, repo: &str) -> Result<Project> {
        let project = self.require_project(repo).await?;
        if project.state.sprints.is_empty() {
            bail!("Les sprints de {repo} ne sont pas démarrés : utilisez « Démarrer le projet ».");
        }
        Ok(project)
    }

    async fn create_state_issue(&self, repo: &str, state: ProjectState) -> Result<Project> {
        let (issue, url) = self
            .create_hidden(repo, STATE_LABEL, STATE_TITLE, projet::render_body(&state))
            .await?;
        Ok(Project { issue, url, state })
    }

    /* ---------- Planning (Gantt) ---------- */

    /// Planning du dépôt (vide s'il n'a jamais été enregistré) et le lien de son issue.
    pub(crate) async fn load_planning(&self, repo: &str) -> Result<(Planning, Option<String>)> {
        match self.hidden_issue(repo, PLANNING_LABEL).await? {
            Some(raw) => Ok((
                planning::parse_body(raw["body"].as_str().unwrap_or(""))?,
                raw["html_url"].as_str().map(str::to_string),
            )),
            None => Ok((Planning::default(), None)),
        }
    }

    /// Enregistre un planning fondé sur la révision `base_revision` ; refuse si quelqu'un l'a
    /// modifié entre-temps.
    pub(crate) async fn save_planning(
        &self,
        repo: &str,
        mut next: Planning,
        base_revision: u32,
    ) -> Result<Planning> {
        planning::validate(&next)?;
        let _guard = self.engine_lock.lock().await;
        let current = self.hidden_issue(repo, PLANNING_LABEL).await?;
        let revision = match &current {
            Some(raw) => planning::parse_body(raw["body"].as_str().unwrap_or(""))?.revision,
            None => 0,
        };
        if revision != base_revision {
            bail!(
                "Le planning a été modifié par quelqu'un d'autre (révision {revision}, vous partiez de la {base_revision}) : rechargez-le puis refaites la modification."
            );
        }
        next.revision = revision + 1;
        let body = planning::render_body(&next);
        match current.and_then(|raw| raw["number"].as_u64()) {
            Some(n) => {
                self.gh
                    .patch(&format!("/repos/{repo}/issues/{n}"), &json!({ "body": body }))
                    .await?;
            }
            None => {
                self.create_hidden(repo, PLANNING_LABEL, PLANNING_TITLE, body)
                    .await?;
            }
        }
        Ok(next)
    }

    /* ---------- Designs ---------- */

    /// Fichiers d'un dossier du dépôt sur une branche (sous-dossiers compris, 100 au plus),
    /// chemins relatifs au dossier ; `None` si le dossier n'existe pas sur cette branche.
    async fn folder_files(
        &self,
        repo: &str,
        folder: &str,
        branch: &str,
    ) -> Result<Option<Vec<(String, u64)>>> {
        let mut out = Vec::new();
        let mut queue = vec![folder.to_string()];
        let mut first = true;
        while let Some(dir) = queue.pop() {
            let listing = self
                .gh
                .get_opt(
                    &format!("/repos/{repo}/contents/{dir}"),
                    &[("ref", branch.to_string())],
                )
                .await?;
            let Some(listing) = listing.filter(|l| l.is_array()) else {
                if first {
                    return Ok(None);
                }
                continue;
            };
            first = false;
            for entry in listing.as_array().into_iter().flatten() {
                let path = entry["path"].as_str().unwrap_or("");
                match entry["type"].as_str() {
                    Some("dir") if queue.len() < 20 => queue.push(path.to_string()),
                    Some("file") if out.len() < 100 => {
                        let rel = path.strip_prefix(folder).unwrap_or(path).trim_start_matches('/');
                        out.push((rel.to_string(), entry["size"].as_u64().unwrap_or(0)));
                    }
                    _ => {}
                }
            }
        }
        out.sort();
        Ok(Some(out))
    }

    /// Contenu d'un fichier du dépôt (1 Mo au plus).
    pub(crate) async fn file_bytes(&self, repo: &str, path: &str, branch: &str) -> Result<Vec<u8>> {
        use base64::Engine as _;
        let raw = self
            .gh
            .get(
                &format!("/repos/{repo}/contents/{path}"),
                &[("ref", branch.to_string())],
            )
            .await?;
        let encoded: String = raw["content"].as_str().unwrap_or("").split_whitespace().collect();
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .with_context(|| format!("contenu illisible : {path}"))
    }

    /// Design : ses fichiers (branche d'import, sinon release en cours, sinon branche par défaut)
    /// et le contenu d'un fichier. `inline` (écran Designs) : images, styles et scripts relatifs
    /// du HTML sont incorporés en `data:` pour s'afficher hors du dépôt.
    pub(crate) async fn read_design(
        &self,
        repo: &str,
        id: &str,
        file: Option<&str>,
        inline: bool,
    ) -> Result<Value> {
        let project = self
            .load_project(repo)
            .await?
            .ok_or_else(|| anyhow!("Aucun design dans {repo}."))?;
        let design = project
            .state
            .design(id)
            .cloned()
            .ok_or_else(|| anyhow!("Design « {id} » introuvable dans {repo}."))?;
        let folder = design
            .path
            .clone()
            .unwrap_or_else(|| format!("design/{}", design.id));
        let mut branches: Vec<String> = design.branch.iter().cloned().collect();
        branches.extend(project.state.current().map(|c| c.branch()));
        branches.push(self.default_branch(repo).await?);
        branches.dedup();
        let mut found = None;
        for b in &branches {
            if let Some(files) = self.folder_files(repo, &folder, b).await? {
                found = Some((b.clone(), files));
                break;
            }
        }
        let Some((branch, files)) = found else {
            return Ok(json!({
                "design": design, "files": [], "branch": Value::Null, "path": folder,
                "message": "Fichiers pas encore dans le dépôt : lancez « Importer » pour que l'IA les récupère.",
            }));
        };
        let names: Vec<&str> = files.iter().map(|(f, _)| f.as_str()).collect();
        let chosen = file
            .map(str::to_string)
            .or_else(|| design.entry.clone())
            .filter(|f| names.contains(&f.as_str()))
            .or_else(|| {
                names
                    .iter()
                    .find(|f| f.eq_ignore_ascii_case("index.html"))
                    .map(|f| f.to_string())
            })
            .or_else(|| {
                names
                    .iter()
                    .find(|f| f.ends_with(".html") || f.ends_with(".htm"))
                    .map(|f| f.to_string())
            })
            .or_else(|| names.first().map(|f| f.to_string()));
        let mut out = json!({
            "design": design,
            "branch": branch,
            "path": folder,
            "files": files.iter().map(|(f, size)| json!({ "path": f, "size": size })).collect::<Vec<_>>(),
            "file": chosen,
        });
        if let Some(chosen) = chosen {
            let bytes = self
                .file_bytes(repo, &format!("{folder}/{chosen}"), &branch)
                .await?;
            let mut text = String::from_utf8_lossy(&bytes).to_string();
            if inline && (chosen.ends_with(".html") || chosen.ends_with(".htm")) {
                let dir = chosen
                    .rsplit_once('/')
                    .map(|(d, _)| format!("{d}/"))
                    .unwrap_or_default();
                let mut budget: usize = 5 * 1024 * 1024;
                for (f, size) in &files {
                    let Some(rel) = f.strip_prefix(&dir) else { continue };
                    if rel == chosen.as_str() || f.ends_with(".html") || *size as usize > budget {
                        continue;
                    }
                    let quoted = [
                        format!("\"{rel}\""),
                        format!("'{rel}'"),
                        format!("\"./{rel}\""),
                        format!("'./{rel}'"),
                        format!("({rel})"),
                    ];
                    if !quoted.iter().any(|q| text.contains(q.as_str())) {
                        continue;
                    }
                    let data = self.file_bytes(repo, &format!("{folder}/{f}"), &branch).await?;
                    budget = budget.saturating_sub(data.len());
                    let uri = data_uri(f, &data);
                    for q in &quoted {
                        let wrapped = match q.chars().next() {
                            Some('(') => format!("({uri})"),
                            Some(c) => format!("{c}{uri}{c}"),
                            None => continue,
                        };
                        text = text.replace(q.as_str(), &wrapped);
                    }
                }
            } else if !inline && text.len() > 60_000 {
                let cut = (0..=60_000)
                    .rev()
                    .find(|i| text.is_char_boundary(*i))
                    .unwrap_or(0);
                text.truncate(cut);
                text.push_str("\n… (tronqué : lire le fichier complet dans le worktree)");
            }
            out["content"] = json!(text);
        }
        Ok(out)
    }

    /* ---------- Jalons de la roadmap ---------- */

    /// Modifie l'état partagé (jalons, designs) ; crée l'issue d'état (sprints pas démarrés)
    /// s'il n'y en a pas encore.
    pub(crate) async fn edit_state(
        &self,
        repo: &str,
        edit: impl FnOnce(&mut ProjectState) -> Result<()>,
    ) -> Result<Project> {
        let _guard = self.engine_lock.lock().await;
        let mut project = match self.load_project(repo).await? {
            Some(p) => p,
            None => {
                let state = ProjectState {
                    status: RunStatus::Idle,
                    duration_days: self
                        .settings()
                        .sprint_length_days
                        .clamp(projet::MIN_DAYS, projet::MAX_DAYS),
                    initial_points_per_day: projet::START_POINTS_PER_DAY,
                    paused_since: None,
                    sprints: vec![],
                    jalons: vec![],
                    designs: vec![],
                };
                self.create_state_issue(repo, state).await?
            }
        };
        edit(&mut project.state)?;
        self.save_project(repo, &project).await?;
        Ok(project)
    }

    /// Toutes les issues du dépôt (ouvertes et fermées, descriptions comprises), sans l'issue d'état.
    async fn all_issues(&self, repo: &str) -> Result<Vec<Issue>> {
        let mut out = Vec::new();
        for page in 1..=10u32 {
            let p = self
                .gh
                .get_page(
                    &format!("/repos/{repo}/issues"),
                    &[
                        ("state", "all".into()),
                        ("per_page", "100".into()),
                        ("page", page.to_string()),
                    ],
                )
                .await?;
            out.extend(
                p.body
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|raw| !model::is_pull_request(raw) && !model::is_state_issue(raw))
                    .map(|raw| model::issue_in(repo, raw, true)),
            );
            if !p.has_next {
                break;
            }
        }
        Ok(out)
    }

    /// Roadmap : jalons, sprints passés, en cours et prévus, dates estimées avec fourchette.
    pub(crate) async fn build_roadmap(&self, repo: &str) -> Result<Value> {
        let today = sprint::today();
        let Some(project) = self.load_project(repo).await? else {
            return Ok(json!({
                "repo": repo, "today": today, "started": false, "jalons": [], "sprints": [],
                "unassigned": [], "end": Value::Null,
            }));
        };
        let state = &project.state;
        let prefix = self.settings().tag_prefix;
        let issues = self.all_issues(repo).await?;
        let by_number: HashMap<u32, &Issue> = issues.iter().map(|i| (i.number, i)).collect();
        let open_set: HashSet<u32> = issues
            .iter()
            .filter(|i| i.state == "open")
            .map(|i| i.number)
            .collect();

        // Prévisions au rythme moyen, haut (dates au plus tôt) et bas (au plus tard).
        let plans: Option<[Vec<projet::PlannedSprint>; 3]> = state.current().map(|cur| {
            let current_open: Vec<Issue> = issues
                .iter()
                .filter(|i| i.state == "open" && i.milestone.as_deref() == Some(cur.version.as_str()))
                .cloned()
                .collect();
            let backlog: Vec<Issue> = issues
                .iter()
                .filter(|i| i.state == "open" && i.milestone.is_none())
                .cloned()
                .collect();
            let taken: Vec<String> = state
                .sprints
                .iter()
                .map(|s| s.version.clone())
                .chain(issues.iter().filter_map(|i| i.milestone.clone()))
                .filter(|v| v != &cur.version)
                .collect();
            let (low, avg, high) = state.rate_range();
            // Environ un an de sprints, au moins 52 : des sprints d'un jour vont plus loin en nombre.
            let horizon = (365 / state.duration_days.max(1) as usize).clamp(52, 366);
            let order = state.jalon_order();
            [avg, high, low].map(|rate| {
                projet::forecast(
                    cur,
                    &current_open,
                    &backlog,
                    &open_set,
                    rate,
                    state.duration_days,
                    &taken,
                    &prefix,
                    horizon,
                    &order,
                )
            })
        });
        let maps = plans
            .as_ref()
            .map(|p| p.each_ref().map(|plan| projet::due_by_issue(plan)));

        // Colonnes : sprints terminés, puis en cours et prévus (rythme moyen).
        let mut sprints: Vec<Value> = state
            .sprints
            .iter()
            .filter(|s| s.ended_on.is_some())
            .map(|s| {
                json!({
                    "version": s.version, "start_on": s.start_on,
                    "due_on": s.ended_on.clone().unwrap_or_else(|| s.due_on.clone()),
                    "state": "done", "points": s.done_points.unwrap_or(0),
                })
            })
            .collect();
        if let Some(plans) = &plans {
            for (i, p) in plans[0].iter().enumerate() {
                sprints.push(json!({
                    "version": p.version, "start_on": p.start_on, "due_on": p.due_on,
                    "state": if i == 0 { "current" } else { "planned" }, "points": p.points,
                }));
            }
        }
        let start_of = |version: &str| {
            sprints
                .iter()
                .find(|s| s["version"].as_str() == Some(version))
                .and_then(|s| s["start_on"].as_str().map(str::to_string))
        };
        let sprint_index = |version: &str| {
            sprints
                .iter()
                .position(|s| s["version"].as_str() == Some(version))
        };

        let jalons: Vec<Value> = state
            .jalons
            .iter()
            .map(|j| {
                let current = state.current().map(|c| c.version.as_str());
                jalon_view(j, &by_number, maps.as_ref(), current, &sprint_index, &start_of)
            })
            .collect();

        let in_jalon: HashSet<u32> = state
            .jalons
            .iter()
            .flat_map(|j| j.issues.iter().copied())
            .collect();
        let unassigned: Vec<Value> = issues
            .iter()
            .filter(|i| i.state == "open" && !in_jalon.contains(&i.number))
            .map(|i| json!({ "number": i.number, "title": i.title, "points": i.points, "priority": i.priority, "milestone": i.milestone }))
            .collect();

        // Fin de tout ce qui est ouvert, avec la même fourchette.
        let end = plans.as_ref().map(|p| {
            let last = |plan: &Vec<projet::PlannedSprint>| plan.last().map(|s| s.due_on.clone());
            let planned: HashSet<u32> = p[0].iter().flat_map(|s| s.issues.iter().copied()).collect();
            json!({
                "on": last(&p[0]), "early": last(&p[1]), "late": last(&p[2]),
                "unplanned": open_set.difference(&planned).count(),
            })
        });
        let (low, avg, high) = state.rate_range();
        Ok(json!({
            "repo": repo,
            "today": today,
            "started": state.current().is_some(),
            "issue": project.issue,
            "url": project.url,
            "duration_days": state.duration_days,
            "rates": { "low": round1(low), "avg": round1(avg), "high": round1(high) },
            "sprints": sprints,
            "jalons": jalons,
            "unassigned": unassigned,
            "end": end,
        }))
    }

    async fn require_project(&self, repo: &str) -> Result<Project> {
        self.load_project(repo).await?.ok_or_else(|| {
            anyhow!("Les sprints de {repo} ne sont pas démarrés : utilisez « Démarrer le projet ».")
        })
    }

    /// Passe de fond sur tous les dépôts suivis, toutes les dix minutes.
    pub async fn run_engine(self) {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            for repo in self.followed() {
                if let Err(err) = self.reconcile(&repo).await {
                    tracing::warn!(repo, "sprints automatiques : {err:#}");
                }
            }
            tokio::time::sleep(TICK).await;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ci {
    None,
    Pending,
    Success,
    Failure,
}

/// Arrondi au dixième, en f64 pour que le JSON porte `0.4` et non `0.4000000059604645`.
pub(crate) fn round1(x: f32) -> f64 {
    (f64::from(x) * 10.0).round() / 10.0
}

/// Jalon tel que la roadmap l'affiche : avancement, sprints concernés, dates estimées.
fn jalon_view(
    jalon: &Jalon,
    by_number: &HashMap<u32, &Issue>,
    maps: Option<&[HashMap<u32, (String, String)>; 3]>,
    current: Option<&str>,
    sprint_index: &dyn Fn(&str) -> Option<usize>,
    start_of: &dyn Fn(&str) -> Option<String>,
) -> Value {
    let issues: Vec<&Issue> = jalon
        .issues
        .iter()
        .filter_map(|n| by_number.get(n).copied())
        .collect();
    let open: Vec<&Issue> = issues.iter().copied().filter(|i| i.state == "open").collect();
    let version_of = |i: &Issue| -> Option<String> {
        if i.state == "open"
            && let Some(m) = maps
        {
            return m[0].get(&i.number).map(|(v, _)| v.clone());
        }
        i.milestone.clone()
    };
    // Fin du jalon dans une prévision : échéance du sprint de sa dernière issue ouverte.
    let end_in = |k: usize| -> Option<String> {
        let map = &maps?[k];
        open.iter()
            .map(|i| map.get(&i.number).map(|(_, due)| due.clone()))
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .max()
    };
    let mut versions: Vec<String> = issues.iter().filter_map(|i| version_of(i)).collect();
    versions.sort_by_key(|v| sprint_index(v).unwrap_or(usize::MAX));
    versions.dedup();
    let done = !issues.is_empty() && open.is_empty();
    let unplanned = match maps {
        Some(m) => open.iter().filter(|i| !m[0].contains_key(&i.number)).count(),
        None => open.len(),
    };
    let status = if issues.is_empty() {
        "empty"
    } else if done {
        "done"
    } else if issues.iter().any(|i| {
        i.state == "closed"
            || i.status != "todo"
            || (current.is_some() && version_of(i).as_deref() == current)
    }) {
        "in_progress"
    } else {
        "planned"
    };
    json!({
        "id": jalon.id,
        "name": jalon.name,
        "description": jalon.description,
        "status": status,
        "issues": issues.iter().map(|i| json!({
            "number": i.number, "title": i.title, "state": i.state, "status": i.status,
            "points": i.points, "priority": i.priority, "sprint": version_of(i),
        })).collect::<Vec<_>>(),
        "total": issues.len(),
        "closed": issues.len() - open.len(),
        "points_total": issues.iter().map(|i| projet::weight(i)).sum::<u32>(),
        "points_done": issues.iter().filter(|i| i.state == "closed").map(|i| projet::weight(i)).sum::<u32>(),
        "unestimated": open.iter().filter(|i| i.points.is_none()).count(),
        "unplanned": unplanned,
        "sprints": versions,
        "start_on": versions.first().and_then(|v| start_of(v)),
        "end_on": if done { issues.iter().filter_map(|i| i.closed_at.as_deref().map(|d| d[..10.min(d.len())].to_string())).max() } else { end_in(0) },
        "end_early": if done { None } else { end_in(1) },
        "end_late": if done { None } else { end_in(2) },
    })
}

/// `data:` d'un fichier, type d'après l'extension.
fn data_uri(path: &str, bytes: &[u8]) -> String {
    use base64::Engine as _;
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
