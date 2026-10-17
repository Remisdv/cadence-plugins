/**
 * Roadmap (maquette Roadmap.dc.html de Cadence 1) : une carte par version (milestone), livrées
 * et en cours en haut, sprints planifiés et paliers en bas. Le nom d'une version est le premier
 * titre de la description de son milestone, les thèmes d'un palier en sont les éléments de liste.
 * Données : `list_milestones` (state all). Une carte ouvre le détail dans la vue Versions.
 */
import { useState, type ReactNode } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Badge, Button, Icon, ProgressBar, cn } from "@cadence/ui";
import type { Version, VersionList } from "../domain";
import {
  EmptyCard,
  Loading,
  NoRepos,
  PageHeader,
  RepoHeading,
  SelectionLabel,
  ToolError,
  VersionBadge,
} from "../components";
import {
  buildRoadmap,
  currentVersion,
  daysLeftLabel,
  formatDay,
  formatPercent,
  plural,
  versionProgress,
  versionStage,
  versionStageMeta,
} from "../planning";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

export function RoadmapView() {
  const { repos, repo, shown, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="roadmap"
        title="Roadmap"
        subtitle={repos && <SelectionLabel repo={repo} count={shown.length} />}
      >
        <Badge tone="neutral">Une version = un milestone</Badge>
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
        <div className="flex flex-col gap-8">
          {shown.map((r) => (
            <RepoRoadmap key={r} repo={r} heading={!repo} refreshKey={String(tick)} />
          ))}
        </div>
      </main>
    </div>
  );
}

function RepoRoadmap({
  repo,
  heading,
  refreshKey,
}: {
  repo: string;
  heading: boolean;
  refreshKey: string;
}) {
  const { data, error, loading } = useTool<VersionList>(
    "list_milestones",
    { repo, state: "all" },
    refreshKey,
  );
  const versions = data?.repo === repo ? data.versions : null;
  const current = versions ? currentVersion(versions) : null;
  const roadmap = buildRoadmap(versions ?? [], current);
  const shippedCount = roadmap.shipped.length + roadmap.olderShipped;
  const today = new Date().toISOString().slice(0, 10);

  const summary = versions
    ? [
        plural(shippedCount, "version livrée", "versions livrées"),
        roadmap.current && "1 en cours",
        `${roadmap.planned.length} planifiée${roadmap.planned.length > 1 ? "s" : ""}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  const open = (title: string) => void cadence.navigate("versions", { repo, version: title });
  const propose = (title: string) =>
    cadence
      .runAction("proposer-issues", { repo, version: title })
      .catch((e: unknown) => cadence.notify(isCadenceError(e) ? e.message : String(e), "error"));

  let body: ReactNode;
  if (error) body = <ToolError message={error.message} className="mb-0" />;
  else if (!versions) body = loading ? <Loading label="Lecture des milestones…" /> : null;
  else if (versions.length === 0) {
    body = (
      <EmptyCard icon="roadmap" title="Aucune version dans ce dépôt">
        Une version est un milestone GitHub au titre semver (0.1.0) : daté pour un sprint, sans date
        pour un palier. Sa description donne le nom de la version (« # Cockpit Tauri ») et, pour un
        palier, ses thèmes en liste.
      </EmptyCard>
    );
  } else {
    body = (
      <div className="flex flex-col gap-5">
        <Lane
          title="Livré"
          count={shippedCount + (roadmap.current ? 1 : 0)}
          hint={
            roadmap.olderShipped > 0
              ? `milestones fermés et version en cours · ${roadmap.olderShipped} plus ancienne${roadmap.olderShipped > 1 ? "s" : ""} masquée${roadmap.olderShipped > 1 ? "s" : ""}`
              : "milestones fermés et version en cours"
          }
        >
          {roadmap.shipped.map((v) => (
            <VersionCard
              key={v.title}
              version={v}
              current={current}
              today={today}
              onOpen={() => open(v.title)}
            />
          ))}
          {roadmap.current && (
            <>
              {roadmap.shipped.length > 0 && <Arrow />}
              <VersionCard
                version={roadmap.current}
                current={current}
                today={today}
                onOpen={() => open(roadmap.current!.title)}
              />
            </>
          )}
          {roadmap.shipped.length === 0 && !roadmap.current && (
            <p className="text-caption text-tx3">Aucune version livrée pour l'instant.</p>
          )}
        </Lane>
        <Lane
          title="Planifié"
          count={roadmap.planned.length}
          hint="milestones ouverts, sans date pour un palier"
        >
          {roadmap.planned.length === 0 ? (
            <p className="text-caption text-tx3">Aucune version planifiée.</p>
          ) : (
            roadmap.planned.map((v, i) => {
              const prev = roadmap.planned[i - 1];
              const toPalier = prev?.kind === "sprint" && v.kind === "palier";
              return (
                <div key={v.title} className="flex shrink-0 gap-3">
                  {toPalier && <Arrow />}
                  <VersionCard
                    version={v}
                    current={current}
                    today={today}
                    onOpen={() => open(v.title)}
                    onPropose={v.kind === "palier" ? () => void propose(v.title) : undefined}
                  />
                </div>
              );
            })
          )}
        </Lane>
      </div>
    );
  }

  return (
    <section>
      {heading ? (
        <RepoHeading repo={repo}>
          {summary && <span className="text-caption text-tx3">{summary}</span>}
        </RepoHeading>
      ) : (
        summary && <div className="mb-3 text-caption text-tx3">{summary}</div>
      )}
      {body}
    </section>
  );
}

function Lane({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count: number;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-center gap-[9px]">
        <span className="text-small font-semibold">{title}</span>
        <span className="mono text-tiny text-tx3">{count}</span>
        <span className="text-tiny text-tx3">{hint}</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">{children}</div>
    </section>
  );
}

function Arrow() {
  return (
    <div className="flex shrink-0 items-center px-2 text-line2" aria-hidden>
      <Icon name="arrowRight" size={18} />
    </div>
  );
}

function VersionCard({
  version,
  current,
  today,
  onOpen,
  onPropose,
}: {
  version: Version;
  current: string | null;
  today: string;
  onOpen: () => void;
  onPropose?: () => void;
}) {
  const stage = versionStage(version, current);
  const meta = versionStageMeta[stage];
  const total = version.open_issues + version.closed_issues;
  const progress = versionProgress(version);
  const dated = version.kind === "sprint";
  const daysLeft =
    stage === "current" && version.due_on
      ? Math.round((Date.parse(version.due_on.slice(0, 10)) - Date.parse(today)) / 86_400_000)
      : null;
  const items = version.themes.slice(0, 3);

  return (
    <div
      className={cn(
        "flex w-[262px] shrink-0 flex-col gap-[11px] rounded-card border bg-panel p-[15px]",
        stage === "current" ? "border-clay-line" : "border-line",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-col gap-[11px] text-left hover:opacity-90"
      >
        <div className="flex w-full items-center gap-2">
          <VersionBadge version={version.title} stage={stage} />
          <span className={cn("text-tiny", meta.text)}>{meta.label}</span>
          <div className="grow" />
          <span className="flex text-tx3">
            <Icon name={meta.icon} size={14} />
          </span>
        </div>
        <div>
          <div className="text-body leading-[1.35] font-semibold">
            {version.name ?? `Version ${version.title}`}
          </div>
          <div className="mt-1 text-tiny text-tx3">
            {dated
              ? version.state === "closed" && version.closed_at
                ? `livrée le ${formatDay(version.closed_at)}`
                : `échéance ${formatDay(version.due_on!)}`
              : "palier · sans date"}
          </div>
        </div>
        {items.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {items.map((t) => (
              <li key={t} className="flex items-start gap-2 text-small leading-[1.45] text-tx2">
                <span className="mt-px flex shrink-0 text-tx3">
                  <Icon name="sprint" size={12} />
                </span>
                <span className="line-clamp-2">{t}</span>
              </li>
            ))}
            {version.themes.length > items.length && (
              <li className="text-tiny text-tx3">
                + {version.themes.length - items.length} thème(s)
              </li>
            )}
          </ul>
        )}
      </button>

      <div className="mt-auto w-full border-t border-line pt-2.5">
        {total > 0 ? (
          <>
            <ProgressBar
              value={progress}
              tone={meta.progress}
              height={4}
              label={`Avancement ${version.title}`}
            />
            <div className="mt-1.5 flex justify-between text-micro text-tx3">
              <span>{formatPercent(progress)}</span>
              <span>
                {plural(total, "issue")}
                {daysLeft !== null && ` · ${daysLeftLabel(daysLeft)}`}
              </span>
            </div>
          </>
        ) : (
          <div className="text-micro text-tx3">
            {version.themes.length > 0
              ? "Thèmes seulement — pas encore d'issues"
              : "Pas encore d'issues"}
          </div>
        )}
        {onPropose && (
          <Button size="xs" variant="ghost" icon="sparkle" className="mt-2.5" onClick={onPropose}>
            Proposer des issues
          </Button>
        )}
      </div>
    </div>
  );
}
