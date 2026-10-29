/**
 * « Nouvelle issue » (maquette Cadence 1 « Issue-Create ») : titre, description, type, story
 * points, priorité, version (milestone ouvert) et jalon de la roadmap. Création par l'outil
 * `create_issue`, puis rangement dans le jalon par `jalon_issues`. La catégorie (domaine ›
 * catégorie) vient de la taxonomie du dépôt ; « + » dans un groupe de la vue Issues la préremplit.
 */
import { useId, useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import {
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
} from "@cadence/ui";
import { pickable, type DomainView } from "../categories";
import type { Issue, IssueType, RoadmapPlan, VersionList } from "../domain";
import { createIssueArgs, issueTypes, storyPoints, type IssueForm } from "../issues";
import { compareVersions } from "../planning";
import { useTool } from "../useTool";

const priorities = [
  { value: 0, label: "P0 · socle" },
  { value: 1, label: "P1 · la plus urgente" },
  { value: 2, label: "P2" },
  { value: 3, label: "P3" },
  { value: 4, label: "P4" },
  { value: 5, label: "P5 · la moins urgente" },
];

export function IssueCreateDialog({
  repos,
  initialRepo,
  domains,
  initialCategory,
  onClose,
  onCreated,
}: {
  /** Dépôts suivis ; un sélecteur s'affiche s'il y en a plusieurs et qu'aucun n'est choisi. */
  repos: string[];
  initialRepo: string | null;
  /** Taxonomie des catégories ; `null` tant qu'elle n'est pas lue. */
  domains: DomainView[] | null;
  initialCategory?: string | null;
  onClose: () => void;
  onCreated: (issue: Issue) => void;
}) {
  const ids = {
    repo: useId(),
    title: useId(),
    body: useId(),
    type: useId(),
    points: useId(),
    priority: useId(),
    version: useId(),
    jalon: useId(),
    category: useId(),
  };
  const [form, setForm] = useState<IssueForm>({
    repo: initialRepo ?? (repos.length === 1 ? repos[0]! : ""),
    title: "",
    body: "",
    type: "feat",
    points: null,
    priority: null,
    milestone: "",
    category: initialCategory ?? "",
  });
  const [jalon, setJalon] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<IssueForm>) => setForm((f) => ({ ...f, ...patch }));

  const versions = useTool<VersionList>("list_milestones", { repo: form.repo }, "", !!form.repo);
  const plan = useTool<RoadmapPlan>("roadmap", { repo: form.repo }, "", !!form.repo);
  const openVersions = (versions.data?.repo === form.repo ? versions.data.versions : [])
    .filter((v) => v.state === "open")
    .sort((a, b) => compareVersions(a.title, b.title));
  const jalons = plan.data?.repo === form.repo ? plan.data.jalons : [];

  const submit = async () => {
    const checked = createIssueArgs(form);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const issue = await cadence.call<Issue>("create_issue", checked.args);
      if (jalon) {
        try {
          await cadence.call("jalon_issues", { repo: form.repo, id: jalon, add: [issue.number] });
        } catch (e) {
          await cadence.notify(
            `#${issue.number} créée, mais pas rangée dans le jalon : ${isCadenceError(e) ? e.message : String(e)}`,
            "warning",
          );
        }
      }
      // La confirmation (avec le lien vers le détail) est affichée par la vue qui ouvre la boîte.
      onCreated(issue);
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={600}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogHeader title="Nouvelle issue" icon="issue" meta={form.repo || undefined} />
        <DialogBody className="flex max-h-[calc(100vh-200px)] flex-col gap-4 overflow-y-auto">
          {!initialRepo && repos.length > 1 && (
            <Field label="Dépôt" htmlFor={ids.repo} required>
              <Select
                id={ids.repo}
                value={form.repo}
                onChange={(e) => {
                  set({ repo: e.target.value, milestone: "" });
                  setJalon("");
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
          <Field label="Titre" htmlFor={ids.title} required>
            <Input
              id={ids.title}
              size="md"
              autoFocus
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Afficher un message clair quand le quota de l'API est épuisé"
            />
          </Field>
          <Field
            label="Description"
            htmlFor={ids.body}
            aside="markdown, facultative — « Compléter » la rédige avec l'IA"
          >
            <Textarea
              id={ids.body}
              rows={5}
              value={form.body}
              onChange={(e) => set({ body: e.target.value })}
              placeholder={"Contexte, besoin, critères d'acceptation :\n- [ ] …"}
            />
          </Field>
          <Field
            label="Catégorie"
            htmlFor={ids.category}
            hint="domaine › catégorie ; « Gérer les catégories » (vue Issues) pour en ajouter"
          >
            <Select
              id={ids.category}
              value={form.category ?? ""}
              disabled={!domains}
              onChange={(e) => set({ category: e.target.value })}
            >
              <option value="">{domains ? "sans catégorie" : "Lecture des catégories…"}</option>
              {pickable(domains ?? [], form.category).map((d) => (
                <optgroup key={d.id} label={d.label}>
                  {d.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-3">
            <Field label="Type" htmlFor={ids.type} className="min-w-[120px] flex-1">
              <Select
                id={ids.type}
                value={form.type}
                onChange={(e) => set({ type: e.target.value as IssueType | "" })}
              >
                {issueTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
                <option value="">sans type</option>
              </Select>
            </Field>
            <Field label="Estimation" htmlFor={ids.points} className="min-w-[120px] flex-1">
              <Select
                id={ids.points}
                value={form.points ?? ""}
                onChange={(e) => set({ points: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">non estimée</option>
                {storyPoints.map((p) => (
                  <option key={p} value={p}>
                    {p} SP
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priorité" htmlFor={ids.priority} className="min-w-[150px] flex-1">
              <Select
                id={ids.priority}
                value={form.priority ?? ""}
                onChange={(e) => set({ priority: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">sans priorité</option>
                {priorities.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <Field
              label="Version"
              htmlFor={ids.version}
              className="min-w-[180px] flex-1"
              hint="sans version : le remplissage automatique des sprints la prendra par priorité"
            >
              <Select
                id={ids.version}
                value={form.milestone}
                disabled={!form.repo}
                onChange={(e) => set({ milestone: e.target.value })}
              >
                <option value="">
                  {form.repo && versions.loading && !versions.data
                    ? "Lecture des versions…"
                    : "sans version"}
                </option>
                {openVersions.map((v) => (
                  <option key={v.number} value={v.title}>
                    {v.title} — {v.kind === "sprint" ? "sprint" : "palier"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Jalon" htmlFor={ids.jalon} className="min-w-[180px] flex-1">
              <Select
                id={ids.jalon}
                value={jalon}
                disabled={!form.repo || jalons.length === 0}
                onChange={(e) => setJalon(e.target.value)}
              >
                <option value="">
                  {form.repo && plan.loading && !plan.data
                    ? "Lecture de la roadmap…"
                    : jalons.length === 0
                      ? "aucun jalon"
                      : "sans jalon"}
                </option>
                {jalons.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {error && <Callout tone="danger">{error}</Callout>}
        </DialogBody>
        <DialogFooter>
          <span className="text-caption text-tx3">
            Créée sur GitHub avec les labels type, cat, sp et priority.
          </span>
          <div className="grow" />
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={busy ? undefined : "plus"}
            disabled={busy || !form.title.trim() || !form.repo}
          >
            {busy && <Spinner />}
            Créer l'issue
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
