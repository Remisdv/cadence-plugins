/**
 * Vue « Catégories » : la taxonomie des issues d'un dépôt (domaine › catégorie) et sa
 * personnalisation, partagée avec l'équipe (état du projet sur GitHub, `save_categories`).
 *
 * Les éléments livrés avec le plugin se masquent (ils ne sont plus proposés, les issues qui les
 * portent restent lisibles) ; on ajoute des catégories à n'importe quel domaine, et des domaines
 * entiers, avec une couleur et, au besoin, un pipeline d'étapes (comme « Échanges client »). Les
 * éléments ajoutés se suppriment. En mode « Tous les dépôts », un dépôt est choisi dans la page.
 */
import { useEffect, useId, useState } from "react";
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
  Field,
  Icon,
  Input,
  Select,
  Spinner,
  Switch,
  cn,
} from "@cadence/ui";
import {
  addCategory,
  addDomain,
  domainColors,
  removeCustom,
  toggleHidden,
  type CategoryConfig,
  type CategoryList,
  type DomainView,
} from "../categories";
import { NoRepos, PageHeader, ToolError } from "../components";
import { useLiveRefresh } from "../useLiveRefresh";
import { useRepos } from "../useRepos";
import { useTool } from "../useTool";

export function CategoriesView({ params }: { params: Record<string, string> }) {
  const { repos, selection, error: reposError } = useRepos();
  const followed = (repos ?? []).map((r) => r.fullName);
  const selected = selection?.kind === "one" ? selection.repo : null;
  const [picked, setPicked] = useState<string | null>(null);
  const repo = selected ?? picked ?? followed[0] ?? null;
  const { data, error, loading, reload } = useTool<CategoryList>(
    "list_categories",
    { repo },
    "",
    !!repo,
  );
  useLiveRefresh(repo ? [repo] : [], reload);
  const current = data && data.repo === repo ? data : null;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<CategoryList | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "category"; domain: string } | { kind: "domain" } | null
  >(null);
  useEffect(() => setSaved(null), [current]);
  const list = saved && saved.repo === repo ? saved : current;

  const save = async (config: CategoryConfig) => {
    if (!repo) return;
    setSaving(true);
    setSaveError(null);
    try {
      setSaved(await cadence.call<CategoryList>("save_categories", { repo, config }));
    } catch (e) {
      setSaveError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const back = params.from === "issues";

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="layers"
        title="Catégories"
        subtitle={repo && <span className="mono">{repo}</span>}
      >
        {!selected && followed.length > 1 && (
          <Select
            size="sm"
            aria-label="Dépôt"
            value={repo ?? ""}
            onChange={(e) => setPicked(e.target.value)}
            className="w-auto"
          >
            {followed.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        )}
        {saving && <Spinner />}
        {back && (
          <Button size="sm" variant="ghost" onClick={() => void cadence.navigate("issues")}>
            Retour aux issues
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          disabled={!list || saving}
          onClick={() => setDialog({ kind: "domain" })}
        >
          Nouveau domaine
        </Button>
      </PageHeader>

      <main className="min-h-0 grow overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[980px] flex-col gap-4">
          {reposError && <Callout tone="danger">{reposError.message}</Callout>}
          {repos && repos.length === 0 && <NoRepos />}
          {repo && loading && !list && (
            <div className="flex items-center gap-2 text-body-sm text-tx3">
              <Spinner /> Lecture des catégories…
            </div>
          )}
          {error && <ToolError message={error.message} />}
          {saveError && <Callout tone="danger">{saveError}</Callout>}
          {list && (
            <p className="text-body-sm text-tx2">
              Une issue porte une catégorie (label <span className="mono">cat/…</span>) ; son
              domaine s'en déduit. Les domaines à pipeline suivent des étapes (label{" "}
              <span className="mono">etape/…</span>), et chaque passage d'étape est tracé en
              commentaire de l'issue. Ces réglages sont enregistrés dans le dépôt : toute l'équipe
              voit les mêmes catégories.
            </p>
          )}
          {list?.domains.map((d) => (
            <DomainCard
              key={d.id}
              domain={d}
              busy={saving}
              onAdd={() => setDialog({ kind: "category", domain: d.id })}
              onHide={(id, hidden) => void save(toggleHidden(list.config, id, hidden))}
              onRemove={(id) => void save(removeCustom(list.config, id))}
            />
          ))}
        </div>
      </main>

      {list && dialog?.kind === "category" && (
        <AddCategoryDialog
          domain={list.domains.find((d) => d.id === dialog.domain)!}
          onClose={() => setDialog(null)}
          onAdd={async (label, description) => {
            await save(addCategory(list.config, list.domains, dialog.domain, label, description));
            setDialog(null);
          }}
        />
      )}
      {list && dialog?.kind === "domain" && (
        <AddDomainDialog
          used={list.domains.map((d) => d.color)}
          onClose={() => setDialog(null)}
          onAdd={async (label, color, pipeline) => {
            await save(addDomain(list.config, list.domains, label, color, pipeline));
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function DomainCard({
  domain,
  busy,
  onAdd,
  onHide,
  onRemove,
}: {
  domain: DomainView;
  busy: boolean;
  onAdd: () => void;
  onHide: (id: string, hidden: boolean) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <Card className={cn("overflow-hidden", domain.hidden && "opacity-60")}>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3"
        style={{ boxShadow: `inset 4px 0 0 ${domain.color}` }}
      >
        <span className="size-2.5 rounded-full" style={{ background: domain.color }} />
        <h2 className="font-display text-title-sm font-semibold" style={{ color: domain.color }}>
          {domain.label}
        </h2>
        {domain.custom && <Badge tone="clay">ajouté</Badge>}
        <span className="text-caption text-tx3">{domain.categories.length} catégories</span>
        <div className="grow" />
        {domain.custom ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => onRemove(domain.id)}>
            Supprimer le domaine
          </Button>
        ) : (
          <label className="flex items-center gap-2 text-caption text-tx2">
            Proposé
            <Switch
              checked={!domain.hidden}
              disabled={busy}
              onCheckedChange={(on) => onHide(domain.id, !on)}
              aria-label={`Proposer le domaine ${domain.label}`}
            />
          </label>
        )}
        <Button size="xs" variant="secondary" icon="plus" disabled={busy} onClick={onAdd}>
          Catégorie
        </Button>
      </div>
      {(domain.description || domain.pipeline) && (
        <div className="flex flex-col gap-2 border-b border-line px-4 py-2.5">
          {domain.description && <p className="text-caption text-tx3">{domain.description}</p>}
          {domain.pipeline && (
            <div className="flex flex-wrap items-center gap-1.5 text-caption text-tx2">
              <span className="text-tx3">Pipeline :</span>
              {domain.pipeline.map((s, i) => (
                <span key={s.id} className="flex items-center gap-1.5">
                  {i > 0 && (
                    <span className="flex text-tx3">
                      <Icon name="arrowRight" size={11} />
                    </span>
                  )}
                  <Badge tone="neutral">{s.label}</Badge>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <ul className="grid grid-cols-1 md:grid-cols-2">
        {domain.categories.map((c) => (
          <li
            key={c.id}
            className={cn(
              "flex min-h-[44px] items-center gap-3 border-b border-line px-4 py-2 md:odd:border-r",
              c.hidden && "opacity-50",
            )}
          >
            <div className="min-w-0 grow">
              <div className="flex items-center gap-2">
                <span className="truncate text-body-sm text-tx">{c.label}</span>
                <span className="mono text-tiny text-tx3">cat/{c.id}</span>
              </div>
              {c.description && (
                <p className="truncate text-caption text-tx3" title={c.description}>
                  {c.description}
                </p>
              )}
            </div>
            {c.custom ? (
              <Button
                size="xs"
                variant="quiet"
                icon="close"
                iconOnly
                aria-label={`Supprimer ${c.label}`}
                title="Supprimer (les issues gardent leur label)"
                disabled={busy}
                onClick={() => onRemove(c.id)}
              />
            ) : (
              <Switch
                checked={!c.hidden}
                disabled={busy || domain.hidden}
                onCheckedChange={(on) => onHide(c.id, !on)}
                aria-label={`Proposer ${c.label}`}
              />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AddCategoryDialog({
  domain,
  onClose,
  onAdd,
}: {
  domain: DomainView;
  onClose: () => void;
  onAdd: (label: string, description: string) => Promise<void>;
}) {
  const ids = { label: useId(), description: useId() };
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!label.trim()) return;
          setBusy(true);
          void onAdd(label, description).finally(() => setBusy(false));
        }}
      >
        <DialogHeader title="Nouvelle catégorie" icon="layers" meta={domain.label} />
        <DialogBody className="flex flex-col gap-4">
          <Field label="Nom" htmlFor={ids.label} required>
            <Input
              id={ids.label}
              size="md"
              autoFocus
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Scraping, Comité d'architecture, Note de synthèse…"
            />
          </Field>
          <Field label="Description" htmlFor={ids.description} aside="facultative">
            <Input
              id={ids.description}
              size="md"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="À quoi elle sert, en une phrase"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <div className="grow" />
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !label.trim()}
            icon={busy ? undefined : "plus"}
          >
            {busy && <Spinner />}
            Ajouter
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function AddDomainDialog({
  used,
  onClose,
  onAdd,
}: {
  used: string[];
  onClose: () => void;
  onAdd: (label: string, color: string, pipeline: string[]) => Promise<void>;
}) {
  const ids = { label: useId(), pipeline: useId() };
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(
    domainColors.find((c) => !used.includes(c)) ?? domainColors[0]!,
  );
  const [withPipeline, setWithPipeline] = useState(false);
  const [pipeline, setPipeline] = useState("À faire, En cours, En attente, Terminé");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!label.trim()) return;
          setBusy(true);
          void onAdd(label, color, withPipeline ? pipeline.split(",") : []).finally(() =>
            setBusy(false),
          );
        }}
      >
        <DialogHeader title="Nouveau domaine" icon="layers" />
        <DialogBody className="flex flex-col gap-4">
          <Field label="Nom" htmlFor={ids.label} required>
            <Input
              id={ids.label}
              size="md"
              autoFocus
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Marketing, Juridique, Achats…"
            />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-small font-medium text-tx2">Couleur</span>
            <div className="flex flex-wrap gap-2">
              {domainColors.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Couleur ${c}`}
                  aria-pressed={c === color}
                  onClick={() => setColor(c)}
                  className={cn(
                    "size-7 rounded-full border-2",
                    c === color ? "border-tx" : "border-transparent",
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 text-body-sm text-tx2">
            Pipeline d'étapes (suivi historisé, comme les échanges client)
            <Switch
              checked={withPipeline}
              onCheckedChange={setWithPipeline}
              aria-label="Pipeline d'étapes"
            />
          </label>
          {withPipeline && (
            <Field
              label="Étapes"
              htmlFor={ids.pipeline}
              hint="dans l'ordre, séparées par des virgules"
            >
              <Input
                id={ids.pipeline}
                size="md"
                value={pipeline}
                onChange={(e) => setPipeline(e.target.value)}
              />
            </Field>
          )}
          <p className="text-caption text-tx3">
            Ajoutez ensuite ses catégories avec « + Catégorie ».
          </p>
        </DialogBody>
        <DialogFooter>
          <div className="grow" />
          <Button type="button" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !label.trim()}
            icon={busy ? undefined : "plus"}
          >
            {busy && <Spinner />}
            Créer le domaine
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
