/**
 * « Relire les PR » : on coche d'abord les PR ouvertes à relire (aucune par défaut), puis l'action
 * `relire-pr` part avec la sélection (`{ type: "pulls", repo, pulls: [numéros] }`). Rien n'est
 * lancé sans PR cochée : un clic ne déclenche plus une revue de toutes les PR du dépôt.
 */
import { useId, useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Select,
  Spinner,
} from "@cadence/ui";
import { pullsContext, type PullRequestList } from "../domain";
import { CiStatus, PrStateIcon } from "../components";
import { prIssueLinks } from "../issues";
import { isOpenPr, plural } from "../planning";
import { useTool } from "../useTool";

export function ReviewPullsDialog({
  repos,
  initialRepo,
  onClose,
}: {
  /** Dépôts suivis ; un sélecteur s'affiche s'il y en a plusieurs et qu'aucun n'est choisi. */
  repos: string[];
  initialRepo: string | null;
  onClose: () => void;
}) {
  const repoId = useId();
  const [repo, setRepo] = useState(initialRepo ?? (repos.length === 1 ? repos[0]! : ""));
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useTool<PullRequestList>("list_pull_requests", { repo, state: "open" }, "", !!repo);
  const pulls = (list.data?.repo === repo ? list.data.pull_requests : []).filter(isOpenPr);
  const loading = !!repo && list.loading && list.data?.repo !== repo;
  const allPicked = pulls.length > 0 && pulls.every((p) => picked.includes(p.number));

  const toggle = (n: number) =>
    setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  const launch = async () => {
    if (!repo || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await cadence.runAction("relire-pr", pullsContext(repo, picked));
      onClose();
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={640}>
      <DialogHeader title="Relire les PR" icon="review" meta={repo || undefined} />
      <DialogBody className="flex max-h-[calc(100vh-220px)] flex-col gap-3 overflow-y-auto">
        <p className="text-body-sm leading-[1.6] text-tx2">
          Cochez les PR à relire : l'IA vérifie les critères de l'issue, le diff, l'architecture et
          les tests, puis publie une revue sur chacune. Elle ne fusionne rien sans votre demande.
        </p>
        {!initialRepo && repos.length > 1 && (
          <Field label="Dépôt" htmlFor={repoId} required>
            <Select
              id={repoId}
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                setPicked([]);
              }}
            >
              <option value="">Choisir un dépôt…</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {loading && (
          <div className="flex items-center gap-2 text-body-sm text-tx3">
            <Spinner /> Lecture des PR ouvertes…
          </div>
        )}
        {list.error && repo && <Callout tone="danger">{list.error.message}</Callout>}
        {repo && !loading && !list.error && pulls.length === 0 && (
          <p className="text-body-sm text-tx3">Aucune PR ouverte sur ce dépôt.</p>
        )}
        {pulls.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 px-2 text-caption text-tx3">
              <span>{plural(pulls.length, "PR ouverte", "PR ouvertes")}</span>
              <div className="grow" />
              <button
                type="button"
                className="text-clay hover:text-clay-hover"
                onClick={() => setPicked(allPicked ? [] : pulls.map((p) => p.number))}
              >
                {allPicked ? "Tout décocher" : "Tout cocher"}
              </button>
            </div>
            {pulls.map((pr) => {
              const links = prIssueLinks(pr);
              const issues = [...links.closes, ...links.branch];
              return (
                <label
                  key={pr.number}
                  className="flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 hover:bg-p2"
                >
                  <input
                    type="checkbox"
                    checked={picked.includes(pr.number)}
                    onChange={() => toggle(pr.number)}
                    aria-label={`PR #${pr.number}`}
                  />
                  <PrStateIcon state={pr.state} size={14} />
                  <span className="mono w-[38px] shrink-0 text-tiny text-tx3">#{pr.number}</span>
                  <span className="flex min-w-0 grow flex-col">
                    <span className="truncate text-body-sm text-tx">{pr.title}</span>
                    <span className="flex min-w-0 items-center gap-1 text-tiny text-tx3">
                      <Icon name="branch" size={11} />
                      <span className="mono truncate">
                        {pr.head} → {pr.base}
                      </span>
                      {issues.length > 0 && (
                        <span className="shrink-0">· {issues.map((n) => `#${n}`).join(", ")}</span>
                      )}
                    </span>
                  </span>
                  {pr.state === "draft" && <Badge tone="muted">brouillon</Badge>}
                  <span className="shrink-0">
                    <CiStatus ci={pr.ci} />
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        <span className="text-caption text-tx3">Aucune PR n'est cochée d'office.</span>
        <div className="grow" />
        <Button type="button" variant="ghost" onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="primary"
          icon={busy ? undefined : "sparkle"}
          disabled={busy || !repo || picked.length === 0}
          onClick={() => void launch()}
        >
          {busy && <Spinner />}
          {picked.length > 0 ? `Relire la sélection (${picked.length})` : "Relire la sélection"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
