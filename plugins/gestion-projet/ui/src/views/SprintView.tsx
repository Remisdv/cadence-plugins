/**
 * Sprint en cours (maquette Main.dc.html de Cadence 1) : KPI du sprint, kanban des issues par
 * état, burndown et retard sur la droite idéale. Tout vient de l'outil `sprint_summary` (milestone
 * daté ouvert le plus proche). En mode « Tous les dépôts », un sprint par dépôt suivi.
 */
import { useState } from "react";
import { cadence } from "@cadence/plugin-sdk";
import { Badge, Button, Card, CardHeader, cn } from "@cadence/ui";
import type { SprintSummary } from "../domain";
import {
  Burndown,
  EmptyCard,
  KanbanColumn,
  Loading,
  MeterList,
  NoRepos,
  PageHeader,
  RepoHeading,
  SelectionLabel,
  StatCard,
  TextLink,
  ToolError,
} from "../components";
import {
  daysLeftLabel,
  delayLabel,
  formatDecimal,
  formatPercent,
  formatRange,
  gainedToday,
  plural,
  requiredPace,
  sprintBoard,
  statusMeters,
} from "../planning";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

export function SprintView() {
  const { repos, repo, shown, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="sprint"
        title="Sprint en cours"
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
        <div className="flex flex-col gap-8">
          {shown.map((r) => (
            <SprintPanel key={r} repo={r} heading={!repo} refreshKey={String(tick)} />
          ))}
        </div>
      </main>
    </div>
  );
}

function SprintPanel({
  repo,
  heading,
  refreshKey,
}: {
  repo: string;
  heading: boolean;
  refreshKey: string;
}) {
  const { data, error, loading } = useTool<SprintSummary>("sprint_summary", { repo }, refreshKey);
  const current = data?.repo === repo ? data : null;

  let body;
  if (error) body = <ToolError message={error.message} className="mb-0" />;
  else if (!current) body = loading ? <Loading label="Lecture du sprint…" /> : null;
  else if (!current.sprint || !current.pace) {
    body = (
      <EmptyCard icon="sprint" title="Aucun sprint en cours">
        {current.message ??
          "Un sprint est un milestone ouvert avec une échéance. Datez une version pour suivre son avancement ici."}
      </EmptyCard>
    );
  } else body = <Sprint summary={current} />;

  return (
    <section>
      {heading && <RepoHeading repo={repo} />}
      {body}
    </section>
  );
}

function Sprint({ summary }: { summary: SprintSummary }) {
  const v = summary.sprint!;
  const pace = summary.pace!;
  const issues = summary.issues ?? [];
  const remaining = pace.total - pace.closed;
  const required = requiredPace(remaining, pace.days_left);
  const delay = delayLabel(pace.delay_days);
  const gain = gainedToday(pace.burndown, pace.total);
  const openVersion = () =>
    void cadence.navigate("versions", { repo: summary.repo, version: v.title });

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="font-display text-title-sm font-semibold">
          Sprint {v.title}
          {v.name ? ` — ${v.name}` : ""}
        </h2>
        <span className="text-caption text-tx3">
          {[
            formatRange(pace.start_on, pace.due_on),
            daysLeftLabel(pace.days_left),
            `milestone #${v.number}`,
          ].join(" · ")}
        </span>
        <div className="grow" />
        <Button size="sm" variant="ghost" icon="tag" onClick={openVersion}>
          Détail de la version
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <StatCard
          label="Portée"
          value={pace.total}
          hint={`issues · ${plural(pace.closed, "fermée")}`}
        />
        <StatCard
          label="Avancement"
          value={formatPercent(pace.progress)}
          hint={pace.burndown.length > 1 ? `+${gain} aujourd'hui` : undefined}
          tone="clay"
        />
        <StatCard
          label="Restantes"
          value={remaining}
          hint={
            required !== null
              ? `${formatDecimal(required)} / jour requis`
              : daysLeftLabel(pace.days_left)
          }
          tone="amber"
        />
        <StatCard
          label="Rythme"
          value={formatDecimal(pace.velocity)}
          hint="issues fermées / jour"
          tone="blue"
        />
        <StatCard
          label="Retard"
          value={pace.burndown.length > 0 ? formatDecimal(Math.abs(pace.delay_days)) : "—"}
          hint={pace.burndown.length > 0 ? delay.text : "pas encore commencé"}
          tone={delay.tone === "amber" ? "amber" : delay.tone === "green" ? "green" : "tx"}
        />
      </div>

      <div className="flex flex-wrap gap-3.5">
        <Card className="flex min-h-[320px] min-w-[420px] flex-[1_1_560px] flex-col px-[15px] py-[13px]">
          <CardHeader
            title="Tableau du sprint"
            actions={
              <>
                <Badge tone="neutral">Groupé par état</Badge>
                <TextLink onClick={() => void cadence.navigate("issues")}>
                  Voir toutes les issues
                </TextLink>
              </>
            }
          />
          {issues.length === 0 ? (
            <p className="mt-4 text-body-sm leading-[1.6] text-tx3">
              Aucune issue dans ce sprint. Les issues rattachées au milestone {v.title} apparaissent
              ici, rangées par état (labels status/*).
            </p>
          ) : (
            <div className="mt-[13px] flex min-h-0 grow items-start gap-[11px] overflow-x-auto">
              {sprintBoard(issues).map((col) => (
                <KanbanColumn key={col.status} column={col} />
              ))}
            </div>
          )}
        </Card>

        <div className="flex w-[330px] shrink-0 grow-0 flex-col gap-3 max-[900px]:w-full">
          <Card className="px-[15px] py-3.5">
            <div className="flex items-center gap-2">
              <h3 className="text-body">Burndown</h3>
              <div className="grow" />
              {pace.burndown.length > 0 && (
                <span
                  className={cn(
                    "text-tiny",
                    delay.tone === "amber"
                      ? "text-amber"
                      : delay.tone === "green"
                        ? "text-green"
                        : "text-tx3",
                  )}
                >
                  {delay.text}
                </span>
              )}
            </div>
            <div className="mt-3">
              {pace.start_on && pace.due_on && pace.burndown.length > 0 ? (
                <Burndown
                  points={pace.burndown}
                  scope={pace.total}
                  start={pace.start_on}
                  end={pace.due_on}
                  days={(pace.length_days ?? summary.sprint_length_days) + 1}
                  label={`Burndown du sprint ${v.title}`}
                />
              ) : (
                <p className="text-caption leading-[1.6] text-tx3">
                  Le burndown commence au premier jour du sprint
                  {pace.start_on ? ` (${formatRange(pace.start_on, null)})` : ""}.
                </p>
              )}
            </div>
            <p className="mt-2.5 text-tiny leading-[1.6] text-tx3">
              Sprint de {plural(summary.sprint_length_days, "jour")} (réglages du plugin) se
              terminant à l'échéance du milestone.
            </p>
          </Card>
          <Card className="px-[15px] py-3.5">
            <h3 className="text-body">Progression</h3>
            <MeterList className="mt-[13px]" items={statusMeters(pace.counts)} />
          </Card>
        </div>
      </div>
    </div>
  );
}
