/**
 * Écran « Documents » : les documents du projet (cahier des charges, sujet, fiches de mission,
 * données attendues, comptes-rendus…) rangés dans le dépôt, sous `docs/intern` (réglage
 * `documents_dir`), donc partagés avec toute l'équipe. Dossiers et sous-dossiers libres (un
 * modèle est proposé), dépôt par le sélecteur de fichiers ou par glisser-déposer (un ZIP est
 * décompressé), aperçu des PDF, tableaux (CSV, Excel), images, Markdown et texte. L'IA y pioche
 * d'elle-même (`docs_list`, `docs_read`, `docs_search`) pour rédiger des issues pertinentes.
 */
import { Component, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import {
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  Spinner,
  cn,
} from "@cadence/ui";
import { EmptyCard, Loading, NoRepos, PageHeader, ToolError } from "../components";
import {
  DROP_MAX,
  KIND_ICON,
  KIND_LABEL,
  buildTree,
  fileCount,
  findNode,
  folderPaths,
  githubUrl,
  humanSize,
  joinPath,
  parentOf,
  previewOf,
  toBase64,
  validName,
  type DocList,
  type DocNode,
} from "../docs";
import { useLiveRefresh } from "../useLiveRefresh";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";
import { ImageViewer, PdfViewer, TableViewer, TextViewer } from "./docs/viewers";

const message = (e: unknown) => (isCadenceError(e) ? e.message : String(e));

type Dialogs =
  | { kind: "folder"; parent: string }
  | { kind: "rename"; node: DocNode }
  | { kind: "delete"; node: DocNode }
  | null;

export function DocumentsView() {
  const { repos, repo, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const list = useTool<DocList>("docs_list", { repo }, String(tick), ready && repo !== null);
  useLiveRefresh(repo ? [repo] : [], reload);
  const data = list.data?.repo === repo ? list.data : null;
  const tree = useMemo(() => buildTree(data?.entries ?? []), [data]);
  // Sélection : un dossier (`""` = racine) ou un fichier.
  const [selected, setSelected] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [dragging, setDragging] = useState(false);

  const node = findNode(tree, selected) ?? tree;
  // Dossier où déposer : le dossier sélectionné, ou celui du fichier sélectionné.
  const folder = node.folder ? node.path : parentOf(node.path);

  const run = async (label: string, op: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await op();
      if (done) void cadence.notify(done, "success");
      reload();
    } catch (e) {
      void cadence.notify(message(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const expand = (path: string) =>
    setOpen((o) => {
      const next = new Set(o);
      let p = path;
      while (p) {
        next.add(p);
        p = parentOf(p);
      }
      return next;
    });

  const uploadPaths = async () => {
    if (!repo) return;
    const paths = await cadence.pickFiles({ title: "Documents du projet à déposer", multiple: true });
    if (!paths.length) return;
    await run(
      "upload",
      () => cadence.call("docs_upload", { repo, folder, files: paths.map((path) => ({ path })) }),
      paths.length === 1 ? "Document déposé." : `${paths.length} fichiers déposés.`,
    );
    if (folder) expand(folder);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!repo) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const big = files.find((f) => f.size > DROP_MAX);
    if (big) {
      void cadence.notify(
        `« ${big.name} » fait ${humanSize(big.size)} : utilisez « Déposer des fichiers » pour les fichiers de plus de 25 Mo.`,
        "warning",
      );
      return;
    }
    await run(
      "upload",
      async () => {
        const payload = await Promise.all(
          files.map(async (f) => ({ name: f.name, content_base64: toBase64(new Uint8Array(await f.arrayBuffer())) })),
        );
        await cadence.call("docs_upload", { repo, folder, files: payload });
      },
      files.length === 1 ? "Document déposé." : `${files.length} fichiers déposés.`,
    );
    if (folder) expand(folder);
  };

  let body: ReactNode;
  if (error) body = <ToolError message={error.message} />;
  else if (repos && repos.length === 0) body = <NoRepos />;
  else if (!repo) body = <Loading label="Lecture du dépôt…" />;
  else if (list.error && !data) body = <ToolError message={list.error.message} />;
  else if (!data) body = <Loading label="Lecture des documents…" />;
  else if (data.entries.length === 0)
    body = (
      <div className="p-6">
        <EmptyCard icon="folder" title="Aucun document pour l'instant">
          Déposez ici le cahier des charges, le sujet, les fiches de mission, les données attendues,
          les comptes-rendus… Ils sont rangés dans le dépôt ({data.dir}), donc partagés avec toute
          l'équipe, et l'IA va y piocher seule quand elle crée ou complète des issues.
        </EmptyCard>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button
            variant="primary"
            icon="folder"
            disabled={busy !== null}
            onClick={() =>
              void run(
                "templates",
                () => cadence.call("docs_mkdir", { repo, paths: data.templates }),
                "Dossiers créés.",
              )
            }
          >
            Créer les dossiers proposés
          </Button>
          <Button icon="download" disabled={busy !== null} onClick={() => void uploadPaths()}>
            Déposer des fichiers
          </Button>
        </div>
        <p className="mt-3 text-center text-caption text-tx3">
          Proposés : {data.templates.join(", ")}. Vous pourrez les renommer ou les supprimer.
        </p>
      </div>
    );
  else
    body = (
      <div className="flex min-h-0 grow">
        <aside className="flex w-[290px] shrink-0 flex-col border-r border-line">
          <div className="min-h-0 grow overflow-y-auto p-2">
            <TreeRow
              node={tree}
              depth={0}
              label="Tous les documents"
              selected={selected}
              open={open}
              onSelect={setSelected}
              onToggle={(p) =>
                setOpen((o) => {
                  const next = new Set(o);
                  if (next.has(p)) next.delete(p);
                  else next.add(p);
                  return next;
                })
              }
            />
          </div>
          <div className="shrink-0 border-t border-line px-3 py-2 text-caption text-tx3">
            {data.files} document{data.files > 1 ? "s" : ""} ·{" "}
            <span className="mono">{data.dir}</span>
          </div>
        </aside>
        <section className="flex min-w-0 grow flex-col">
          {node.folder ? (
            <FolderPane
              node={node}
              list={data}
              onOpen={(p) => {
                setSelected(p);
                expand(parentOf(p));
              }}
              onAction={setDialog}
            />
          ) : (
            <FilePane repo={repo} node={node} list={data} onAction={setDialog} />
          )}
        </section>
      </div>
    );

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        if (!repo || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <PageHeader
        icon="folder"
        title="Documents"
        subtitle={repo && <span className="mono text-caption text-tx3">{repo}</span>}
      >
        {busy && <Spinner size={14} />}
        <Button size="sm" icon="plus" disabled={!data || busy !== null} onClick={() => setDialog({ kind: "folder", parent: folder })}>
          Nouveau dossier
        </Button>
        <Button size="sm" variant="primary" icon="download" disabled={!data || busy !== null} onClick={() => void uploadPaths()}>
          Déposer des fichiers
        </Button>
      </PageHeader>
      {body}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-backdrop/60">
          <div className="rounded-card border border-dashed border-clay-line bg-panel px-8 py-6 text-center">
            <Icon name="download" size={22} className="mx-auto text-clay" />
            <div className="mt-2 text-body font-medium">Déposer dans « {folder || "Tous les documents"} »</div>
            <div className="mt-1 text-caption text-tx3">Un ZIP est décompressé dans un dossier à son nom.</div>
          </div>
        </div>
      )}
      {data && repo && (
        <DocDialogs
          dialog={dialog}
          onClose={() => setDialog(null)}
          tree={tree}
          busy={busy !== null}
          onFolder={(parent, name) =>
            void run("mkdir", () => cadence.call("docs_mkdir", { repo, paths: [joinPath(parent, name)] }), "Dossier créé.").then(
              () => {
                setDialog(null);
                expand(joinPath(parent, name));
                setSelected(joinPath(parent, name));
              },
            )
          }
          onMove={(from, to) =>
            void run("move", () => cadence.call("docs_move", { repo, from, to }), "Déplacé.").then(() => {
              setDialog(null);
              setSelected(to);
              expand(parentOf(to));
            })
          }
          onDelete={(path) =>
            void run("delete", () => cadence.call("docs_delete", { repo, path }), "Supprimé.").then(() => {
              setDialog(null);
              setSelected(parentOf(path));
            })
          }
        />
      )}
    </div>
  );
}

/* ---------- Arborescence ---------- */

function TreeRow({
  node,
  depth,
  label,
  selected,
  open,
  onSelect,
  onToggle,
}: {
  node: DocNode;
  depth: number;
  label?: string;
  selected: string;
  open: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const isRoot = node.path === "";
  const expanded = isRoot || open.has(node.path);
  const kind = node.entry?.kind ?? null;
  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected === node.path}
        aria-expanded={node.folder ? expanded : undefined}
        tabIndex={0}
        onClick={() => {
          onSelect(node.path);
          if (node.folder && !isRoot && !expanded) onToggle(node.path);
        }}
        onKeyDown={(e) => e.key === "Enter" && onSelect(node.path)}
        className={cn(
          "flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-body-sm select-none",
          selected === node.path ? "bg-p3 text-tx" : "text-tx2 hover:bg-p2 hover:text-tx",
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={node.path || undefined}
      >
        {node.folder && !isRoot ? (
          <button
            type="button"
            aria-label={expanded ? "Replier" : "Déplier"}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
            className={cn("flex text-tx3", !expanded && "-rotate-90")}
          >
            <Icon name="chevronDown" size={13} />
          </button>
        ) : (
          <span className="w-[13px]" />
        )}
        <Icon
          name={node.folder ? "folder" : KIND_ICON[kind ?? "other"]}
          size={14}
          className={node.folder ? "text-clay" : "text-tx3"}
        />
        <span className={cn("min-w-0 grow truncate", isRoot && "font-medium")}>{label ?? node.name}</span>
        {node.folder && <span className="text-micro text-tx3">{fileCount(node)}</span>}
      </div>
      {node.folder &&
        expanded &&
        node.children.map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            depth={depth + 1}
            selected={selected}
            open={open}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

/* ---------- Dossier ---------- */

function ItemMenu({ node, list, onAction }: { node: DocNode; list: DocList; onAction: (d: Dialogs) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="xs" variant="quiet" iconOnly aria-label={`Actions sur ${node.name}`} onClick={(e) => e.stopPropagation()}>
          <span className="text-body leading-none">⋯</span>
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => onAction({ kind: "rename", node })}>
          <Icon name="pen" size={13} /> Renommer ou déplacer…
        </MenuItem>
        <MenuItem onSelect={() => void cadence.openExternal(githubUrl(list, node.path, node.folder))}>
          <Icon name="github" size={13} /> Ouvrir sur GitHub
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => onAction({ kind: "delete", node })}>
          <Icon name="close" size={13} /> Supprimer…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function FolderPane({
  node,
  list,
  onOpen,
  onAction,
}: {
  node: DocNode;
  list: DocList;
  onOpen: (path: string) => void;
  onAction: (d: Dialogs) => void;
}) {
  const isRoot = node.path === "";
  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <Icon name="folder" size={15} className="text-clay" />
        <span className="min-w-0 grow truncate text-body font-medium">{isRoot ? "Tous les documents" : node.path}</span>
        {!isRoot && <ItemMenu node={node} list={list} onAction={onAction} />}
      </div>
      <div className="min-h-0 grow overflow-y-auto p-4">
        {node.children.length === 0 ? (
          <div className="rounded-card border border-dashed border-line2 px-6 py-10 text-center text-body-sm text-tx3">
            Dossier vide : glissez des fichiers ici, ou utilisez « Déposer des fichiers ».
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
            {node.children.map((c) => (
              <div
                key={c.path}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(c.path)}
                onKeyDown={(e) => e.key === "Enter" && onOpen(c.path)}
                className="group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-tile border border-line bg-panel px-3 py-2.5 hover:border-line2 hover:bg-p2"
              >
                <span
                  className={cn(
                    "inline-flex size-8 shrink-0 items-center justify-center rounded-control",
                    c.folder ? "bg-clay-d text-clay" : "bg-p3 text-tx3",
                  )}
                >
                  <Icon name={c.folder ? "folder" : KIND_ICON[c.entry?.kind ?? "other"]} size={15} />
                </span>
                <span className="min-w-0 grow">
                  <span className="block truncate text-body-sm text-tx" title={c.name}>
                    {c.name}
                  </span>
                  <span className="block text-micro text-tx3">
                    {c.folder
                      ? `${fileCount(c)} document${fileCount(c) > 1 ? "s" : ""}`
                      : `${KIND_LABEL[c.entry?.kind ?? "other"]} · ${humanSize(c.entry?.size ?? 0)}`}
                  </span>
                </span>
                <span className="opacity-0 group-hover:opacity-100">
                  <ItemMenu node={c} list={list} onAction={onAction} />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Fichier ---------- */

function FilePane({
  repo,
  node,
  list,
  onAction,
}: {
  repo: string;
  node: DocNode;
  list: DocList;
  onAction: (d: Dialogs) => void;
}) {
  const entry = node.entry!;
  const kind = entry.kind ?? "other";
  const preview = previewOf(kind);
  const props = { repo, path: entry.path, sha: entry.sha };
  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <Icon name={KIND_ICON[kind]} size={15} className="text-tx3" />
        <span className="min-w-0 grow truncate text-body font-medium" title={entry.path}>
          {entry.name}
        </span>
        <span className="text-caption whitespace-nowrap text-tx3">
          {KIND_LABEL[kind]} · {humanSize(entry.size)}
        </span>
        <ItemMenu node={node} list={list} onAction={onAction} />
      </div>
      <ViewerBoundary key={entry.sha}>
        {preview === "pdf" && <PdfViewer {...props} />}
        {preview === "table" && <TableViewer {...props} />}
        {preview === "image" && <ImageViewer {...props} />}
        {(preview === "markdown" || preview === "text") && <TextViewer {...props} markdown={preview === "markdown"} />}
        {preview === "none" && (
          <div className="p-6">
            <EmptyCard icon="file" title="Pas d'aperçu pour ce format">
              {kind === "word" || kind === "powerpoint"
                ? "L'IA lit quand même son texte. Pour le voir mis en page, ouvrez-le depuis GitHub."
                : "Ouvrez-le depuis GitHub pour le télécharger."}
            </EmptyCard>
            <div className="mt-3 flex justify-center">
              <Button icon="github" onClick={() => void cadence.openExternal(githubUrl(list, entry.path, false))}>
                Ouvrir sur GitHub
              </Button>
            </div>
          </div>
        )}
      </ViewerBoundary>
    </div>
  );
}

/** Une visionneuse en erreur n'emporte pas tout l'écran : message, et le reste reste utilisable. */
class ViewerBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return (
      <div className="min-h-0 grow">
        {this.state.error ? (
          <div className="p-6">
            <Callout tone="danger">Aperçu impossible : {this.state.error}</Callout>
          </div>
        ) : (
          this.props.children
        )}
      </div>
    );
  }
}

/* ---------- Fenêtres ---------- */

function DocDialogs({
  dialog,
  onClose,
  tree,
  busy,
  onFolder,
  onMove,
  onDelete,
}: {
  dialog: Dialogs;
  onClose: () => void;
  tree: DocNode;
  busy: boolean;
  onFolder: (parent: string, name: string) => void;
  onMove: (from: string, to: string) => void;
  onDelete: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const key = dialog ? `${dialog.kind}:${"node" in dialog ? dialog.node.path : dialog.parent}` : "";
  const [lastKey, setLastKey] = useState("");
  if (key !== lastKey) {
    setLastKey(key);
    setName(dialog?.kind === "rename" ? dialog.node.name : "");
    setTarget(dialog?.kind === "rename" ? parentOf(dialog.node.path) : "");
  }
  const folders = folderPaths(tree);

  if (!dialog) return null;
  const ok = validName(name);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={460}>
      {dialog.kind === "folder" && (
        <>
          <DialogHeader icon="folder" title="Nouveau dossier" meta={dialog.parent || "Tous les documents"} />
          <DialogBody>
            <Field label="Nom" htmlFor="doc-folder">
              <Input
                id="doc-folder"
                size="md"
                autoFocus
                value={name}
                invalid={name !== "" && !ok}
                placeholder="Comptes-rendus"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ok && onFolder(dialog.parent, name.trim())}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button variant="primary" icon="plus" disabled={!ok || busy} onClick={() => onFolder(dialog.parent, name.trim())}>
              Créer
            </Button>
          </DialogFooter>
        </>
      )}
      {dialog.kind === "rename" && (
        <>
          <DialogHeader icon="pen" title="Renommer ou déplacer" />
          <DialogBody>
            <Field label="Nom" htmlFor="doc-name">
              <Input
                id="doc-name"
                size="md"
                autoFocus
                value={name}
                invalid={name !== "" && !ok}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Dossier" htmlFor="doc-target">
              <Select id="doc-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                {folders
                  .filter((f) => !dialog.node.folder || (f !== dialog.node.path && !f.startsWith(`${dialog.node.path}/`)))
                  .map((f) => (
                    <option key={f} value={f}>
                      {f || "Tous les documents (racine)"}
                    </option>
                  ))}
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button
              variant="primary"
              disabled={!ok || busy || joinPath(target, name.trim()) === dialog.node.path}
              onClick={() => onMove(dialog.node.path, joinPath(target, name.trim()))}
            >
              Enregistrer
            </Button>
          </DialogFooter>
        </>
      )}
      {dialog.kind === "delete" && (
        <>
          <DialogHeader icon="warning" title={`Supprimer « ${dialog.node.name} » ?`} />
          <DialogBody>
            <Callout tone="warning">
              {dialog.node.folder
                ? `Le dossier et ses ${fileCount(dialog.node)} document(s) sont retirés du dépôt pour toute l'équipe.`
                : "Le document est retiré du dépôt pour toute l'équipe."}{" "}
              L'historique Git en garde une copie.
            </Callout>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button variant="danger" icon="close" disabled={busy} onClick={() => onDelete(dialog.node.path)}>
              Supprimer
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
