/**
 * Versions (maquette Version-Detail.dc.html de Cadence 1) : liste des versions (milestones) des
 * dépôts choisis, puis détail d'une version — KPI, portée (issues), progression par état, burndown
 * d'un sprint, notes de version, pull requests et release, conditions de clôture.
 *
 * Paramètres de route `repo` et `version` (Roadmap, Sprint en cours) : ouvrent le détail.
 * Outils : `list_milestones`, `sprint_summary` (avec `version`), `list_pull_requests`,
 * `list_releases`, `update_milestone` (clôture). Actions : « Préparer la release ».
 */
import { useEffect, useState, type ReactNode } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Icon,
  ProgressBar,
  SectionLabel,
  StatusDot,
  cn,
} from "@cadence/ui";
import {
  issueStatuses,
  issueTypeTone,
  type Issue,
  type PullRequestList,
  type ReleaseList,
  type SprintSummary,
  type Version,
  type VersionList,
} from "../domain";
import {
  Burndown,
  EmptyCard,
  Loading,
  MeterList,
  NoRepos,
  PageHeader,
  PrStateIcon,
  RepoHeading,
  SegmentedTabs,
  SelectionLabel,
  StatStrip,
  ToolError,
  VersionBadge,
  type StatStripItem,
} from "../components";
import {
  closeChecks,
  currentVersion,
  delayLabel,
  formatAgo,
  formatDay,
  formatDecimal,
  formatPercent,
  formatRange,
  isOpenPr,
  plural,
  prStateMeta,
  releaseNotes,
  requiredPace,
  sortVersions,
  statusMeters,
  versionProgress,
  versionStage,
  versionStageMeta,
} from "../planning";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

interface Selected {
  repo: string;
  version: string;
}

export function VersionsView({ params }: { params: Record<string, string> }) {
  const [selected, setSelected] = useState<Selected | null>(
    params.repo && params.version ? { repo: params.repo, version: params.version } : null,
  );
  useEffect(() => {
    if (params.repo && params.version) setSelected({ repo: params.repo, version: params.version });
  }, [params.repo, params.version]);

  return selected ? (
    <VersionDetail {...selected} onBack={() => setSelected(null)} />
  ) : (
    <VersionsList onOpen={setSelected} />
  );
}

/* ---------- Liste ---------- */

function VersionsList({ onOpen }: { onOpen: (s: Selected) => void }) {
  const { repos, repo, shown, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="tag"
        title="Versions"
        subtitle={repos && <SelectionLabel repo={repo} count={shown.length} />}
      >
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={() => setTick((t) => t + 1)}
          disabled={!ready}
        />
      </PageHeader>
      <main className="min-h-0 grow overflow-y-auto p-5">
        {error && <ToolError message={error.message} />}
        {repos && repos.length === 0 && <NoRepos />}
        <div className="flex flex-col gap-7">
          {shown.map((r) => (
            <RepoVersions
              key={r}
              repo={r}
              heading={!repo}
              refreshKey={String(tick)}
              onOpen={onOpen}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function RepoVersions({
  repo,
  heading,
  refreshKey,
  onOpen,
}: {
  repo: string;
  heading: boolean;
  refreshKey: string;
  onOpen: (s: Selected) => void;
}) {
  const { data, error, loading } = useTool<VersionList>(
    "list_milestones",
    { repo, state: "all" },
    refreshKey,
  );
  const versions = data?.repo === repo ? data.versions : null;
  const current = versions ? currentVersion(versions) : null;
  const sorted = versions ? sortVersions(versions, current) : [];
  const open = sorted.filter((v) => v.state === "open");
  const closed = sorted.filter((v) => v.state === "closed");

  let body: ReactNode;
  if (error) body = <ToolError message={error.message} className="mb-0" />;
  else if (!versions) body = loading ? <Loading label="Lecture des versions…" /> : null;
  else if (versions.length === 0) {
    body = (
      <EmptyCard icon="tag" title="Aucune version dans ce dépôt">
        Une version est un milestone GitHub au titre semver : daté pour un sprint, sans date pour un
        palier. Demandez à l'IA de la créer (outil create_milestone) ou créez-la sur GitHub.
      </EmptyCard>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {[
          { title: "Ouvertes", items: open },
          { title: "Livrées", items: closed },
        ]
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <section key={g.title} className="flex flex-col gap-2">
              <SectionLabel>
                {g.title} · {g.items.length}
              </SectionLabel>
              <Card className="divide-y divide-line">
                {g.items.map((v) => (
                  <VersionRow
                    key={v.title}
                    version={v}
                    current={current}
                    onOpen={() => onOpen({ repo, version: v.title })}
                  />
                ))}
              </Card>
            </section>
          ))}
      </div>
    );
  }
  return (
    <section>
      {heading && <RepoHeading repo={repo} />}
      {body}
    </section>
  );
}

function VersionRow({
  version,
  current,
  onOpen,
}: {
  version: Version;
  current: string | null;
  onOpen: () => void;
}) {
  const stage = versionStage(version, current);
  const meta = versionStageMeta[stage];
  const total = version.open_issues + version.closed_issues;
  const progress = versionProgress(version);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-p2"
    >
      <span className="w-[64px] shrink-0">
        <VersionBadge version={version.title} stage={stage} />
      </span>
      <div className="min-w-0 grow">
        <div className="truncate text-body text-tx">
          {version.name ?? `Version ${version.title}`}
        </div>
        <div className="mt-0.5 text-caption text-tx3">
          {version.kind === "sprint"
            ? version.state === "closed" && version.closed_at
              ? `livrée le ${formatDay(version.closed_at)}`
              : `sprint · échéance ${formatDay(version.due_on!)}`
            : `palier · sans date${version.themes.length ? ` · ${plural(version.themes.length, "thème")}` : ""}`}
        </div>
      </div>
      <span className={cn("w-[70px] shrink-0 text-tiny", meta.text)}>{meta.label}</span>
      <div className="w-[160px] shrink-0">
        <ProgressBar
          value={progress}
          tone={meta.progress}
          height={4}
          label={`Avancement ${version.title}`}
        />
        <div className="mt-1 flex justify-between text-micro text-tx3">
          <span>{formatPercent(progress)}</span>
          <span>
            {version.closed_issues}/{total} issue{total > 1 ? "s" : ""}
          </span>
        </div>
      </div>
      <Icon name="arrowRight" size={14} className="shrink-0 text-tx3" />
    </button>
  );
}

/* ---------- Détail ---------- */

type Tab = "scope" | "notes" | "pulls";

const tabs: { id: Tab; label: string }[] = [
  { id: "scope", label: "Portée" },
  { id: "notes", label: "Notes de version" },
  { id: "pulls", label: "Pull requests" },
];

function VersionDetail({ repo, version, onBack }: Selected & { onBack: () => void }) {
  const [tick, setTick] = useState(0);
  const key = String(tick);
  const summary = useTool<SprintSummary>("sprint_summary", { repo, version }, key);
  const pulls = useTool<PullRequestList>("list_pull_requests", { repo, state: "all" }, key);
  const releases = useTool<ReleaseList>("list_releases", { repo }, key);
  const [tab, setTab] = useState<Tab>("scope");
  const [closing, setClosing] = useState(false);

  const s = summary.data?.repo === repo && summary.data.sprint ? summary.data : null;
  const v = s?.sprint ?? null;
  const pace = s?.pace;
  const issues = s?.issues ?? [];
  const versionPulls = (pulls.data?.pull_requests ?? []).filter(
    (p) =>
      p.milestone === v?.title ||
      (p.closes.length > 0 && p.closes.some((n) => issues.some((i) => i.number === n))),
  );
  const release = releases.data?.releases.find((r) => v && r.version === v.title) ?? null;

  const prepareRelease = () =>
    cadence
      .runAction("preparer-release", { repo, version })
      .catch((e: unknown) => cadence.notify(isCadenceError(e) ? e.message : String(e), "error"));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="tag"
        title={v ? `Version ${v.title}${v.name ? ` — ${v.name}` : ""}` : `Version ${version}`}
        subtitle={
          v && pace ? (
            <>
              <span className="mono">{repo}</span>
              {` · milestone #${v.number} · ${
                v.kind === "sprint" ? formatRange(pace.start_on, pace.due_on) : "palier · sans date"
              } · ${plural(pace.total, "issue")}`}
            </>
          ) : (
            <span className="mono">{repo}</span>
          )
        }
      >
        <Button
          size="sm"
          variant="quiet"
          icon="arrowRight"
          className="[&>svg]:rotate-180"
          onClick={onBack}
        >
          Toutes les versions
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={() => setTick((t) => t + 1)}
        />
        {v && (
          <Button size="sm" icon="rocket" onClick={() => void prepareRelease()}>
            Préparer la release
          </Button>
        )}
        {v?.state === "open" && (
          <Button size="sm" variant="primary" icon="tag" onClick={() => setClosing(true)}>
            Clôturer la version
          </Button>
        )}
      </PageHeader>

      <main className="min-h-0 grow overflow-y-auto p-5">
        {summary.error && <ToolError message={summary.error.message} />}
        {!s && !summary.error && summary.loading && <Loading label="Lecture de la version…" />}
        {s && v && pace && (
          <div className="flex flex-col gap-[13px]">
            <StatStrip
              items={stats(
                v,
                pace,
                versionPulls.filter((p) => p.state === "merged").length,
                versionPulls.filter(isOpenPr).length,
              )}
            />
            <div className="flex flex-wrap gap-[13px]">
              <div className="flex min-w-[420px] flex-[1_1_560px] flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <SegmentedTabs
                    items={tabs}
                    value={tab}
                    onChange={setTab}
                    label="Sections de la version"
                  />
                  <div className="grow" />
                  <Badge tone="green">{plural(pace.total - pace.closed, "ouverte")}</Badge>
                  <Badge tone="purple">{plural(pace.closed, "fermée")}</Badge>
                </div>
                {tab === "scope" && <Scope issues={issues} version={v} />}
                {tab === "notes" && (
                  <Card className="px-4 py-3.5">
                    <ReleaseNotesPreview issues={issues} />
                    <p className="mt-3.5 text-tiny leading-[1.6] text-tx3">
                      Aperçu tiré des issues fermées, groupées par type. « Préparer la release »
                      rédige les notes définitives et crée la release en brouillon, jamais publiée
                      automatiquement.
                    </p>
                  </Card>
                )}
                {tab === "pulls" && (
                  <Card className="divide-y divide-line">
                    {pulls.error && (
                      <div className="p-3.5">
                        <ToolError message={pulls.error.message} className="mb-0" />
                      </div>
                    )}
                    {pulls.loading && !pulls.data && (
                      <div className="p-3.5">
                        <Loading label="Lecture des pull requests…" />
                      </div>
                    )}
                    {pulls.data && versionPulls.length === 0 && (
                      <p className="p-4 text-body-sm text-tx3">
                        Aucune pull request rattachée au milestone ou fermant une issue de la
                        version (PR ouvertes et 30 dernières fusionnées ou fermées).
                      </p>
                    )}
                    {versionPulls.map((pr) => (
                      <button
                        key={pr.number}
                        type="button"
                        onClick={() => void cadence.openExternal(pr.url)}
                        className="flex h-10 w-full items-center gap-[11px] px-3.5 text-left hover:bg-p2"
                      >
                        <PrStateIcon state={pr.state} size={14} />
                        <span className="mono w-9 shrink-0 text-tiny text-tx3">{pr.number}</span>
                        <span className="min-w-0 grow truncate text-body-sm">{pr.title}</span>
                        <Badge tone={prStateMeta[pr.state].tone}>
                          {prStateMeta[pr.state].label}
                        </Badge>
                        <span className="w-[72px] shrink-0 text-right text-tiny text-tx3">
                          {formatAgo(pr.updated_at)}
                        </span>
                      </button>
                    ))}
                  </Card>
                )}
              </div>

              <div className="flex w-[340px] shrink-0 flex-col gap-[13px] max-[900px]:w-full">
                <Card className="px-[15px] py-3.5">
                  <h3 className="text-body">Progression</h3>
                  <MeterList className="mt-[13px]" items={statusMeters(pace.counts)} />
                </Card>
                {v.kind === "sprint" &&
                  pace.start_on &&
                  pace.due_on &&
                  pace.burndown.length > 0 && (
                    <Card className="px-[15px] py-3.5">
                      <div className="flex items-center gap-2">
                        <h3 className="text-body">Burndown</h3>
                        <div className="grow" />
                        {v.state === "open" && <DelayText delay={pace.delay_days} />}
                      </div>
                      <div className="mt-3">
                        <Burndown
                          points={pace.burndown}
                          scope={Math.max(1, pace.total)}
                          start={pace.start_on}
                          end={pace.due_on}
                          days={(pace.length_days ?? s.sprint_length_days) + 1}
                          label={`Burndown de la version ${v.title}`}
                        />
                      </div>
                    </Card>
                  )}
                <ReleaseCard
                  release={release}
                  loading={releases.loading && !releases.data}
                  error={releases.error?.message}
                />
                <CloseCard version={v} issues={issues} pulls={versionPulls} />
              </div>
            </div>
          </div>
        )}
      </main>

      {v && (
        <CloseDialog
          open={closing}
          onOpenChange={setClosing}
          repo={repo}
          version={v}
          issues={issues}
          pulls={versionPulls}
          onClosed={() => setTick((t) => t + 1)}
        />
      )}
    </div>
  );
}

function stats(
  v: Version,
  pace: NonNullable<SprintSummary["pace"]>,
  merged: number,
  openPrs: number,
): StatStripItem[] {
  const shipped = v.state === "closed";
  const remaining = pace.total - pace.closed;
  const required = requiredPace(remaining, pace.days_left);
  return [
    {
      label: "Issues fermées",
      value: `${pace.closed} / ${pace.total}`,
      suffix: formatPercent(pace.progress),
      tone: "clay",
    },
    {
      label: "PR fusionnées",
      value: merged,
      suffix: openPrs > 0 ? `${openPrs} encore ouverte${openPrs > 1 ? "s" : ""}` : "aucune ouverte",
      tone: "green",
    },
    shipped || pace.days_left === null
      ? {
          label: "Échéance",
          value: v.due_on ? formatDay(v.due_on) : "—",
          suffix: shipped ? "livrée" : "palier sans date",
        }
      : {
          label: "Jours restants",
          value: Math.max(0, pace.days_left),
          suffix: pace.length_days !== null ? `sur ${pace.length_days}` : undefined,
        },
    shipped || required === null
      ? {
          label: "Rythme",
          value: v.kind === "sprint" ? formatDecimal(pace.velocity) : "—",
          suffix: v.kind === "sprint" ? "issues / jour" : "palier sans sprint",
          tone: "blue",
        }
      : {
          label: "Rythme requis",
          value: formatDecimal(required),
          suffix: "issue / jour",
          tone: "amber",
        },
  ];
}

function Scope({ issues, version }: { issues: Issue[]; version: Version }) {
  if (issues.length === 0) {
    return (
      <Card className="px-3.5 py-3">
        {version.themes.length > 0 ? (
          <>
            <div className="text-tiny text-tx3">Thèmes du palier — pas encore d'issues</div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {version.themes.map((t) => (
                <li key={t} className="flex items-start gap-2 text-body-sm text-tx2">
                  <span className="mt-px flex text-tx3">
                    <Icon name="sprint" size={12} />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-body-sm text-tx3">
            Aucune issue dans cette version. Les issues rattachées à ce milestone apparaissent ici.
          </p>
        )}
      </Card>
    );
  }
  const ordered = [...issues].sort(
    (a, b) => Number(a.status === "done") - Number(b.status === "done") || a.number - b.number,
  );
  return (
    <Card className="divide-y divide-line">
      {ordered.map((issue) => (
        <button
          key={issue.number}
          type="button"
          onClick={() => void cadence.openExternal(issue.url)}
          title="Ouvrir sur GitHub"
          className="flex min-h-10 w-full items-center gap-[11px] px-3.5 py-2 text-left hover:bg-p2"
        >
          <StatusDot tone={issueStatuses[issue.status].dot} size={6} />
          <span className="mono w-10 shrink-0 text-tiny text-tx3">#{issue.number}</span>
          <span
            className={cn(
              "min-w-0 grow truncate text-body-sm",
              issue.status === "done" ? "text-tx3" : "text-tx",
            )}
          >
            {issue.title}
          </span>
          {issue.type && <Badge tone={issueTypeTone[issue.type]}>{issue.type}</Badge>}
          {issue.estimate && <Badge mono>{issue.estimate}</Badge>}
          <span className="w-[62px] shrink-0 text-right text-tiny text-tx3">
            {issueStatuses[issue.status].label}
          </span>
        </button>
      ))}
    </Card>
  );
}

function ReleaseNotesPreview({ issues, limit }: { issues: Issue[]; limit?: number }) {
  const sections = releaseNotes(issues);
  if (sections.length === 0) {
    return <p className="text-small text-tx3">Aucune issue fermée pour l'instant.</p>;
  }
  return (
    <div className="text-small leading-[1.7] text-tx2">
      {sections.map((s, i) => (
        <div key={s.title} className={cn(i > 0 && "mt-2")}>
          <div className="font-semibold text-tx">{s.title}</div>
          {(limit ? s.items.slice(0, limit) : s.items).map((item) => (
            <div key={item}>· {item}</div>
          ))}
          {limit && s.items.length > limit && (
            <div className="text-tx3">· et {s.items.length - limit} autre(s)</div>
          )}
        </div>
      ))}
    </div>
  );
}

function ReleaseCard({
  release,
  loading,
  error,
}: {
  release: ReleaseList["releases"][number] | null;
  loading: boolean;
  error?: string;
}) {
  return (
    <Card className="px-[15px] py-3.5">
      <div className="flex items-center gap-2">
        <span className="flex text-tx3">
          <Icon name="rocket" size={15} />
        </span>
        <h3 className="text-body">Release</h3>
        <div className="grow" />
        {release && (
          <Badge tone={release.draft ? "amber" : "green"}>
            {release.draft ? "brouillon" : "publiée"}
          </Badge>
        )}
      </div>
      <div className="mt-2.5 text-small leading-[1.6] text-tx2">
        {error ? (
          <span className="text-red">{error}</span>
        ) : loading ? (
          "Lecture des releases…"
        ) : release ? (
          <div className="flex items-center gap-2">
            <VersionBadge version={release.tag} tone={release.draft ? "amber" : "green"} />
            <span className="grow text-tx3">
              {release.published_at
                ? `publiée le ${formatDay(release.published_at)}`
                : "pas encore publiée"}
            </span>
            <Button
              size="xs"
              variant="ghost"
              icon="link"
              onClick={() => void cadence.openExternal(release.url)}
            >
              GitHub
            </Button>
          </div>
        ) : (
          "Pas encore de release : « Préparer la release » rédige les notes et la crée en brouillon."
        )}
      </div>
    </Card>
  );
}

function CloseCard({
  version,
  issues,
  pulls,
}: {
  version: Version;
  issues: Issue[];
  pulls: PullRequestList["pull_requests"];
}) {
  if (version.state === "closed") {
    return (
      <Card className="px-[15px] py-3.5">
        <div className="flex items-center gap-2">
          <span className="flex text-green">
            <Icon name="check" size={15} />
          </span>
          <span className="text-body-sm font-medium">Version livrée</span>
        </div>
        <p className="mt-2.5 text-small leading-[1.6] text-tx2">
          Milestone fermé{version.closed_at ? ` le ${formatDay(version.closed_at)}` : ""}.
        </p>
      </Card>
    );
  }
  const checks = closeChecks(issues, pulls);
  const blocked = checks.some((c) => !c.ok);
  return (
    <Card className="px-[15px] py-3.5">
      <div className="flex items-center gap-2">
        <span className={cn("flex", blocked ? "text-amber" : "text-green")}>
          <Icon name={blocked ? "warning" : "check"} size={15} />
        </span>
        <span className="text-body-sm font-medium">
          {blocked ? "Clôture bloquée" : "Prête à clôturer"}
        </span>
      </div>
      <Checks checks={checks} />
    </Card>
  );
}

function Checks({ checks }: { checks: { ok: boolean; text: string }[] }) {
  return (
    <div className="mt-2.5 flex flex-col gap-[7px] text-small text-tx2">
      {checks.map((c) => (
        <div key={c.text} className="flex gap-2">
          <span className={cn("flex", c.ok ? "text-green" : "text-red")}>
            <Icon name={c.ok ? "check" : "close"} size={13} />
          </span>
          {c.text}
        </div>
      ))}
    </div>
  );
}

function CloseDialog({
  open,
  onOpenChange,
  repo,
  version,
  issues,
  pulls,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: string;
  version: Version;
  issues: Issue[];
  pulls: PullRequestList["pull_requests"];
  onClosed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checks = closeChecks(issues, pulls);
  const blocked = checks.some((c) => !c.ok);

  const close = async () => {
    setBusy(true);
    try {
      await cadence.call("update_milestone", { repo, title: version.title, state: "closed" });
      setError(null);
      onOpenChange(false);
      onClosed();
      await cadence.notify(`Version ${version.title} clôturée.`, "success");
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={520}>
      <DialogHeader title={`Clôturer la version ${version.title}`} icon="tag" meta={repo} />
      <DialogBody>
        <Checks checks={checks} />
        <p className="text-small leading-[1.6] text-tx2">
          Le milestone est fermé sur GitHub.{" "}
          {blocked &&
            "Les issues encore ouvertes y restent rattachées : déplacez-les vers la version suivante si besoin. "}
          Le tag et la release se font ensuite avec « Préparer la release ».
        </p>
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        <div className="grow" />
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Annuler
        </Button>
        <Button variant="primary" icon="tag" onClick={() => void close()} disabled={busy}>
          {blocked ? "Clôturer malgré tout" : "Clôturer"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function DelayText({ delay }: { delay: number }) {
  const d = delayLabel(delay);
  return (
    <span
      className={cn(
        "text-tiny",
        d.tone === "amber" ? "text-amber" : d.tone === "green" ? "text-green" : "text-tx3",
      )}
    >
      {d.text}
    </span>
  );
}
