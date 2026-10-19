/**
 * Designs (Claude Design) : galerie des designs du projet et visionneuse. On colle le lien
 * claude.ai d'un design (`design_add`) ; le skill « Importer un design » en récupère les fichiers
 * et les commite sous `design/<id>/` (branche et PR dédiées). La visionneuse affiche une page du
 * design dans une iframe isolée (`sandbox`, sans accès au plugin), images et styles relatifs
 * incorporés par le serveur (`get_design` avec `inline`). L'IA voit les mêmes designs
 * (`list_designs`, `get_design`) : on peut les citer dans le chat ou en tirer des issues.
 */
import { useState, type ReactNode } from "react";
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
  Textarea,
  cn,
} from "@cadence/ui";
import type { Design, DesignDetail, DesignList } from "../domain";
import { EmptyCard, Loading, NoRepos, PageHeader, ToolError } from "../components";
import { formatDay } from "../planning";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

/** Nom lisible d'une page : `project/V2-Chat.dc.html` → `V2-Chat`. */
const pageLabel = (path: string) => (path.split("/").pop() ?? path).replace(/(\.dc)?\.html?$/i, "");

const notifyError = (e: unknown) =>
  cadence.notify(isCadenceError(e) ? e.message : String(e), "error");

export function DesignsView() {
  const { repos, repo, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const {
    data,
    error: listError,
    loading,
  } = useTool<DesignList>("list_designs", { repo }, String(tick), ready && repo !== null);
  const designs = data?.repo === repo ? data.designs : null;
  const reload = () => setTick((t) => t + 1);
  const opened = designs?.find((d) => d.id === open) ?? null;

  let body: ReactNode;
  if (error) body = <ToolError message={error.message} />;
  else if (repos && repos.length === 0) body = <NoRepos />;
  else if (!repo)
    body = (
      <EmptyCard icon="layers" title="Choisissez un dépôt">
        Les designs sont rangés par dépôt : sélectionnez-en un dans le sélecteur de la barre du
        plugin.
      </EmptyCard>
    );
  else if (listError) body = <ToolError message={listError.message} />;
  else if (!designs) body = loading ? <Loading label="Lecture des designs…" /> : null;
  else if (opened) body = <Viewer repo={repo} design={opened} onChanged={reload} />;
  else if (designs.length === 0)
    body = (
      <EmptyCard icon="layers" title="Aucun design pour l'instant">
        Ajoutez un design de Claude Design avec son lien claude.ai : l'IA en récupère les fichiers
        et les range dans le dépôt (dossier design/), visibles ici par toute l'équipe et utilisables
        dans le chat pour créer les issues ou implémenter les écrans.
      </EmptyCard>
    );
  else
    body = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {designs.map((d) => (
          <DesignCard key={d.id} design={d} onOpen={() => setOpen(d.id)} />
        ))}
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="layers"
        title={opened ? opened.name : "Designs"}
        subtitle={repo && <span className="mono text-caption text-tx3">{repo}</span>}
      >
        {opened && (
          <Button
            size="sm"
            variant="ghost"
            icon="arrowRight"
            className="[&_svg]:rotate-180"
            onClick={() => setOpen(null)}
          >
            Tous les designs
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          disabled={!repo}
          onClick={() => setAdding(true)}
        >
          Ajouter un design
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={reload}
          disabled={!repo}
        />
      </PageHeader>
      <main className="flex min-h-0 grow flex-col overflow-y-auto p-5">{body}</main>
      {adding && repo && (
        <AddDialog
          repo={repo}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            setOpen(id);
            reload();
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ design }: { design: Design }) {
  return design.status === "imported" ? (
    <Badge tone="green" dot>
      Importé
    </Badge>
  ) : (
    <Badge tone="amber" dot>
      À importer
    </Badge>
  );
}

function DesignCard({ design, onOpen }: { design: Design; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-card border border-line bg-panel p-[15px] text-left hover:border-line2"
    >
      <div className="flex items-center gap-2">
        <span className="flex text-clay">
          <Icon name="layers" size={16} />
        </span>
        <span className="min-w-0 grow truncate text-body font-semibold">{design.name}</span>
        <StatusBadge design={design} />
      </div>
      {design.description && (
        <p className="line-clamp-2 text-body-sm leading-[1.5] text-tx2">{design.description}</p>
      )}
      <span className="mt-auto text-tiny text-tx3">
        {design.status === "imported" && design.imported_on
          ? `importé le ${formatDay(design.imported_on)} · ${design.path ?? `design/${design.id}`}`
          : `ajouté le ${formatDay(design.added_on)}`}
      </span>
    </button>
  );
}

function Viewer({
  repo,
  design,
  onChanged,
}: {
  repo: string;
  design: Design;
  onChanged: () => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  const { data, error, loading } = useTool<DesignDetail>(
    "get_design",
    { repo, id: design.id, inline: true, ...(file ? { file } : {}) },
    design.status,
  );
  const detail = data?.design.id === design.id ? data : null;
  const pages = (detail?.files ?? []).filter((f) => /\.html?$/i.test(f.path));
  const current = detail?.file ?? null;

  const importNow = () =>
    cadence
      .runAction("importer-design", {
        type: "design",
        repo,
        design: design.id,
        url: design.url,
        name: design.name,
      })
      .catch(notifyError);
  const toIssues = () =>
    cadence.runAction("extraire-issues", { repo, design: design.id }).catch(notifyError);
  const remove = async () => {
    try {
      await cadence.call("design_delete", { repo, id: design.id });
      onChanged();
    } catch (e) {
      await notifyError(e);
    }
  };

  return (
    <div className="flex min-h-0 grow flex-col gap-3">
      <Card className="flex flex-wrap items-center gap-2 px-[15px] py-2.5">
        <StatusBadge design={design} />
        {detail?.branch && (
          <span className="mono text-caption text-tx3">
            {detail.path} · {detail.branch}
          </span>
        )}
        <div className="grow" />
        <Button
          size="xs"
          variant="ghost"
          icon="link"
          onClick={() => void cadence.openExternal(design.url)}
        >
          Ouvrir sur claude.ai
        </Button>
        <Button size="xs" variant="ghost" icon="download" onClick={() => void importNow()}>
          {design.status === "imported" ? "Réimporter" : "Importer"}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          icon="sparkle"
          disabled={design.status !== "imported"}
          onClick={() => void toIssues()}
        >
          Créer des issues depuis ce design
        </Button>
        <Button size="xs" variant="quiet" icon="close" onClick={() => void remove()}>
          Retirer
        </Button>
      </Card>
      {design.description && <p className="text-body-sm text-tx2">{design.description}</p>}
      {pages.length > 6 && (
        <label className="flex items-center gap-2 text-caption text-tx3">
          Écran
          <Select
            size="sm"
            value={current ?? ""}
            onChange={(e) => setFile(e.target.value)}
            aria-label="Écran du design"
          >
            {pages.map((p) => (
              <option key={p.path} value={p.path}>
                {pageLabel(p.path)}
              </option>
            ))}
          </Select>
          <span>· {pages.length} écrans</span>
        </label>
      )}
      {pages.length > 1 && pages.length <= 6 && (
        <div role="tablist" aria-label="Pages du design" className="flex flex-wrap gap-1">
          {pages.map((p) => (
            <button
              key={p.path}
              role="tab"
              aria-selected={current === p.path}
              onClick={() => setFile(p.path)}
              className={cn(
                "mono h-[26px] rounded-control px-2.5 text-caption text-tx3",
                current === p.path ? "bg-p4 text-tx" : "hover:bg-p2",
              )}
            >
              {pageLabel(p.path)}
            </button>
          ))}
        </div>
      )}
      {error && <ToolError message={error.message} />}
      {!detail && loading && <Loading label="Chargement du design…" />}
      {detail && !detail.content && (
        <EmptyCard icon="download" title="Fichiers pas encore dans le dépôt">
          {detail.message ??
            "Lancez « Importer » : l'IA récupère le design sur claude.ai et le commite dans design/."}
        </EmptyCard>
      )}
      {detail?.content && (
        <iframe
          title={`${design.name} — ${current ?? ""}`}
          sandbox="allow-scripts"
          srcDoc={detail.content}
          className="min-h-[520px] w-full grow rounded-card border border-line"
        />
      )}
    </div>
  );
}

function AddDialog({
  repo,
  onClose,
  onAdded,
}: {
  repo: string;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim() !== "" && url.trim().startsWith("https://claude.ai/");

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await cadence.call<{ id: string }>("design_add", {
        repo,
        name: name.trim(),
        url: url.trim(),
        description: description.trim(),
      });
      // L'IA récupère les fichiers dans une conversation (accès claude.ai, ou export joint).
      await cadence
        .runAction("importer-design", {
          type: "design",
          repo,
          design: res.id,
          url: url.trim(),
          name: name.trim(),
        })
        .catch(notifyError);
      onAdded(res.id);
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={560}>
      <DialogHeader title="Ajouter un design" icon="layers" />
      <DialogBody className="flex flex-col gap-4">
        <Field
          label="Lien claude.ai"
          htmlFor="design-url"
          hint="le lien du design ou du canvas dans Claude Design"
        >
          <Input
            id="design-url"
            size="md"
            mono
            placeholder="https://claude.ai/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Nom" htmlFor="design-nom" hint="« Écrans de l'app », « Page d'accueil »…">
          <Input id="design-nom" size="md" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="design-desc" hint="facultative">
          <Textarea
            id="design-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <p className="text-caption leading-[1.6] text-tx3">
          Une conversation s'ouvre : l'IA récupère le design sur claude.ai et le commite dans
          design/ (branche et pull request dédiées). Sans accès à claude.ai, elle vous demandera
          d'exporter le design et de le joindre au chat.
        </p>
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="primary" size="md" disabled={!valid || busy} onClick={() => void add()}>
          Ajouter et importer
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
