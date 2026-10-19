/**
 * Pull requests (maquette Pull-Requests.dc.html de Cadence 1) : PR du dépôt choisi ou de tous les
 * dépôts suivis, avec l'état des checks et des revues. Une ligne ouvre le détail (description,
 * checks, revues, fichiers) où une PR en brouillon passe « prête pour la revue ».
 * Outils : `list_pull_requests`, `get_pull_request`, `mark_pull_request_ready`.
 */
import { useState } from "react";
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
  SectionLabel,
  StatusDot,
  cn,
} from "@cadence/ui";
import {
  repoShortName,
  type PullRequest,
  type PullRequestDetail,
  type PullRequestList,
} from "../domain";
import {
  CiStatus,
  Diffstat,
  EmptyCard,
  Loading,
  NoRepos,
  PageHeader,
  PrStateIcon,
  RepoErrors,
  SegmentedTabs,
  SelectionLabel,
  ToolError,
  VersionBadge,
} from "../components";
import { formatAgo, isOpenPr, plural, prStateMeta, reviewSummary } from "../planning";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

type StateFilter = "open" | "closed" | "all";

const filters: { id: StateFilter; label: string }[] = [
  { id: "open", label: "Ouvertes" },
  { id: "closed", label: "Fermées" },
  { id: "all", label: "Toutes" },
];

const reviewTones = {
  tx2: "text-tx2",
  amber: "text-amber",
  red: "text-red",
  green: "text-green",
} as const;

export function PullRequestsView() {
  const { repos, repo, shown, ready, error: reposError } = useSelection();
  const [state, setState] = useState<StateFilter>("open");
  const [opened, setOpened] = useState<PullRequest | null>(null);
  const { data, error, loading, reload } = useTool<PullRequestList>(
    "list_pull_requests",
    repo ? { repo, state } : { state },
    "",
    ready,
  );
  const current = data && (repo ? data.repo === repo : data.repo === null) ? data : null;
  const pulls = current?.pull_requests ?? [];
  const openCount = pulls.filter(isOpenPr).length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="pullRequest"
        title="Pull requests"
        subtitle={
          repos && (
            <>
              <SelectionLabel repo={repo} count={shown.length} />
              {current && state !== "closed" && ` · ${plural(openCount, "ouverte")}`}
            </>
          )
        }
      >
        <SegmentedTabs items={filters} value={state} onChange={setState} label="État" />
        <Button
          size="sm"
          icon="review"
          disabled={!repo}
          title={
            repo
              ? "L'IA relit les PR du sprint : critères, diff, architecture, tests, puis publie ses revues"
              : "Choisissez un dépôt"
          }
          onClick={() =>
            void cadence
              .runAction("relire-pr", { repo })
              .catch((e: unknown) =>
                cadence.notify(isCadenceError(e) ? e.message : String(e), "error"),
              )
          }
        >
          Relire les PR
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={reload}
          disabled={!ready}
        />
      </PageHeader>

      <main className="min-h-0 grow overflow-y-auto p-5">
        {reposError && <ToolError message={reposError.message} />}
        {repos && repos.length === 0 && <NoRepos />}
        {ready && loading && !current && <Loading label="Lecture des pull requests sur GitHub…" />}
        {ready && error && <ToolError message={error.message} />}
        <RepoErrors errors={current?.errors} />
        {current && pulls.length === 0 && !error && (
          <EmptyCard icon="pullRequest" title="Aucune pull request dans ce filtre">
            Les PR ouvertes et les 30 dernières fusionnées ou fermées de chaque dépôt apparaissent
            ici.
          </EmptyCard>
        )}
        {pulls.length > 0 && (
          <Card className="overflow-hidden">
            <div
              role="row"
              className="flex h-[34px] items-center gap-[13px] border-b border-line px-4 text-tiny font-semibold tracking-[0.06em] text-tx3 uppercase"
            >
              <span className="w-4" />
              <span className="grow">Pull request</span>
              <span className="w-[78px]">CI</span>
              <span className="w-28">Revues</span>
              <span className="w-14 text-right">Version</span>
              <span className="w-[90px] text-right">Auteur</span>
            </div>
            <div role="table" aria-label="Pull requests">
              {pulls.map((pr) => (
                <PrLine
                  key={`${pr.repo}#${pr.number}`}
                  pr={pr}
                  showRepo={!repo}
                  onOpen={() => setOpened(pr)}
                />
              ))}
            </div>
          </Card>
        )}
      </main>

      {opened && <PrDialog pr={opened} onClose={() => setOpened(null)} onChanged={reload} />}
    </div>
  );
}

function PrLine({
  pr,
  showRepo,
  onOpen,
}: {
  pr: PullRequest;
  showRepo: boolean;
  onOpen: () => void;
}) {
  const review = reviewSummary(pr);
  const closesVerb = pr.state === "merged" ? "a fermé" : "ferme";
  return (
    <div
      role="row"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className="flex cursor-pointer items-center gap-[13px] border-b border-line px-4 py-[13px] last:border-b-0 hover:bg-p2 focus-visible:bg-p2 focus-visible:outline-none"
    >
      <span className="mt-px">
        <PrStateIcon state={pr.state} />
      </span>
      <div className="min-w-0 grow">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium">{pr.title}</span>
          {pr.state !== "open" && (
            <Badge tone={prStateMeta[pr.state].tone}>{prStateMeta[pr.state].label}</Badge>
          )}
        </div>
        <div className="mt-[5px] flex min-w-0 items-center gap-[9px] text-caption text-tx3">
          <span className="mono">
            {showRepo ? `${repoShortName(pr.repo)}#${pr.number}` : `#${pr.number}`}
          </span>
          <span className="inline-flex min-w-0 items-center gap-1">
            <Icon name="branch" size={12} />
            <span className="mono truncate">{pr.head}</span>
          </span>
          <span className="text-line2">→</span>
          <span className="mono">{pr.base}</span>
          {pr.closes.length > 0 && (
            <span className="inline-flex items-center gap-1 text-tiny">
              <Icon name="link" size={12} />
              {closesVerb} {pr.closes.map((n) => `#${n}`).join(", ")}
            </span>
          )}
          {pr.state !== "draft" && (
            <Diffstat additions={pr.additions} deletions={pr.deletions} plain />
          )}
          <span className="text-tiny">{formatAgo(pr.updated_at)}</span>
        </div>
      </div>
      <span className="w-[78px] shrink-0">
        <CiStatus ci={pr.ci} />
      </span>
      <span className="w-28 shrink-0 text-caption">
        {review ? (
          <span className={reviewTones[review.tone]}>{review.text}</span>
        ) : (
          <span className="text-tx3">—</span>
        )}
      </span>
      <span className="flex w-14 shrink-0 justify-end">
        {pr.milestone ? (
          <VersionBadge version={pr.milestone} />
        ) : (
          <span className="text-caption text-tx3">—</span>
        )}
      </span>
      <span className="w-[90px] shrink-0 truncate text-right text-caption text-tx2">
        {pr.author ?? "—"}
      </span>
    </div>
  );
}

const checkTones = {
  success: { icon: "check", cls: "text-green" },
  failure: { icon: "close", cls: "text-red" },
  pending: { icon: "clock", cls: "text-amber" },
  skipped: { icon: "check", cls: "text-tx3" },
} as const;

const reviewLabels: Record<string, { label: string; dot: "green" | "amber" | "neutral" | "red" }> =
  {
    approved: { label: "a approuvé", dot: "green" },
    changes_requested: { label: "demande des changements", dot: "amber" },
    commented: { label: "a commenté", dot: "neutral" },
    dismissed: { label: "revue écartée", dot: "neutral" },
  };

function PrDialog({
  pr,
  onClose,
  onChanged,
}: {
  pr: PullRequest;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tick, setTick] = useState(0);
  const { data, error, loading } = useTool<PullRequestDetail>(
    "get_pull_request",
    { repo: pr.repo, number: pr.number },
    String(tick),
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const d = data && data.number === pr.number && data.repo === pr.repo ? data : null;
  const state = d?.state ?? pr.state;

  const markReady = async () => {
    setBusy(true);
    try {
      await cadence.call("mark_pull_request_ready", { repo: pr.repo, number: pr.number });
      setActionError(null);
      setTick((t) => t + 1);
      onChanged();
      await cadence.notify(`PR #${pr.number} prête pour la revue.`, "success");
    } catch (e) {
      setActionError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={720}>
      <DialogHeader title={pr.title} icon="pullRequest" meta={`${pr.repo}#${pr.number}`} />
      <DialogBody className="max-h-[calc(100vh-200px)] overflow-y-auto">
        <div className="flex flex-wrap items-center gap-2 text-caption text-tx3">
          <Badge tone={prStateMeta[state].tone}>{prStateMeta[state].label}</Badge>
          <span className="inline-flex items-center gap-1">
            <Icon name="branch" size={12} />
            <span className="mono">{pr.head}</span>
            <span className="text-line2">→</span>
            <span className="mono">{pr.base}</span>
          </span>
          {pr.author && <span>par {pr.author}</span>}
          <Diffstat additions={pr.additions} deletions={pr.deletions} />
          <span>{plural(pr.changed_files, "fichier")}</span>
          {d?.mergeable === "conflicting" && <Badge tone="red">conflits</Badge>}
          {pr.milestone && <VersionBadge version={pr.milestone} />}
        </div>

        {error && <ToolError message={error.message} className="mb-0" />}
        {actionError && <Callout tone="danger">{actionError}</Callout>}
        {!d && loading && <Loading label="Lecture de la pull request…" />}

        {d && (
          <>
            <section className="flex flex-col gap-2">
              <SectionLabel>Description</SectionLabel>
              {d.body.trim() ? (
                <div className="max-h-[220px] overflow-y-auto rounded-field border border-line bg-p2 px-3.5 py-3 text-body-sm leading-[1.6] whitespace-pre-wrap text-tx2">
                  {d.body}
                </div>
              ) : (
                <p className="text-body-sm text-tx3">Pas de description.</p>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <SectionLabel className="flex items-center gap-2">
                Checks{" "}
                <span className="tracking-normal normal-case">
                  <CiStatus ci={d.ci} />
                </span>
              </SectionLabel>
              {d.checks.length === 0 ? (
                <p className="text-body-sm text-tx3">Aucun check sur le dernier commit.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {d.checks.map((c, i) => {
                    const t = checkTones[c.state];
                    return (
                      <div key={`${c.name}-${i}`} className="flex items-center gap-2 text-body-sm">
                        <span className={cn("flex", t.cls)}>
                          <Icon name={t.icon} size={13} />
                        </span>
                        <span className="grow truncate text-tx2">{c.name}</span>
                        {c.url && (
                          <button
                            type="button"
                            className="text-caption text-clay hover:text-clay-hover"
                            onClick={() => void cadence.openExternal(c.url!)}
                          >
                            Détails
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <SectionLabel>Revues</SectionLabel>
              {d.reviewers.length > 0 && (
                <p className="text-body-sm text-tx2">En attente de : {d.reviewers.join(", ")}</p>
              )}
              {d.reviews.length === 0 ? (
                <p className="text-body-sm text-tx3">Aucune revue soumise.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {d.reviews.map((r, i) => {
                    const meta = reviewLabels[r.state] ?? {
                      label: r.state,
                      dot: "neutral" as const,
                    };
                    return (
                      <div key={i} className="text-body-sm">
                        <div className="flex items-center gap-2 text-tx2">
                          <StatusDot tone={meta.dot} />
                          <span className="text-tx">{r.author ?? "?"}</span> {meta.label}
                          <span className="text-tiny text-tx3">{formatAgo(r.submitted_at)}</span>
                        </div>
                        {r.body?.trim() && (
                          <p className="mt-1 ml-3.5 text-caption leading-[1.6] whitespace-pre-wrap text-tx3">
                            {r.body}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <SectionLabel>Fichiers · {d.files.length}</SectionLabel>
              <div className="divide-y divide-line rounded-field border border-line">
                {d.files.map((f) => (
                  <div key={f.path} className="flex items-center gap-2.5 px-3 py-1.5 text-caption">
                    <span className="mono min-w-0 grow truncate text-tx2" title={f.path}>
                      {f.path}
                    </span>
                    <span className="text-tx3">{f.status}</span>
                    <Diffstat additions={f.additions} deletions={f.deletions} />
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" icon="github" onClick={() => void cadence.openExternal(pr.url)}>
          Ouvrir sur GitHub
        </Button>
        <div className="grow" />
        <Button
          variant="secondary"
          icon="sparkle"
          onClick={() =>
            void cadence
              .runAction("relire-pr", { repo: pr.repo, number: pr.number })
              .catch((e: unknown) =>
                cadence.notify(isCadenceError(e) ? e.message : String(e), "error"),
              )
          }
        >
          Relire avec l'IA
        </Button>
        {state === "draft" && (
          <Button variant="primary" icon="review" onClick={() => void markReady()} disabled={busy}>
            Prête pour la revue
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
