/**
 * Éditeur de note façon Notion : titre, blocs (TipTap / ProseMirror), menu « / », raccourcis
 * Markdown à la frappe, poignée pour glisser un bloc (et Alt+↑ / Alt+↓), barre de mise en forme
 * sur la sélection, liens vers les autres documents, sauvegarde automatique avec indicateur.
 *
 * Le Markdown est enregistré par `update_note` avec la révision lue : si l'IA (ou une autre
 * fenêtre) a modifié la note entre-temps, l'enregistrement est refusé et l'écran propose de
 * charger sa version ou de garder la sienne.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { cadence } from "@cadence/plugin-sdk";
import {
  Button,
  Callout,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Icon,
  Input,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  cn,
} from "@cadence/ui";
import { formatDate, headingIndexForPage, kindMeta, type DocumentInfo, type NoteDoc } from "../domain";
import { errorText, openLink } from "./actions";
import { createAutosaver, saveLabel, type AutosaveState } from "./autosave";
import { documentLink, foldText, linkText, pageAbbrev } from "./blocks";
import { createSlashStore, noteExtensions, type SlashStore } from "./extensions";
import { docToMarkdown, markdownToDoc } from "./markdown";
import "./editor.css";

interface Snapshot {
  markdown: string;
  title: string;
}

export function NoteEditor({
  note,
  page,
  documents,
}: {
  note: NoteDoc;
  page?: number;
  /** Documents de la bibliothèque, pour le sélecteur de liens. */
  documents: DocumentInfo[];
}) {
  const [title, setTitle] = useState(note.title === "Sans titre" ? "" : note.title);
  const [meta, setMeta] = useState({ updatedAt: note.updated_at, source: note.source, missing: note.missing_file });
  const [conflict, setConflict] = useState<NoteDoc | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [empty, setEmpty] = useState(!note.markdown.trim());
  const revision = useRef(note.revision);
  const saved = useRef<Snapshot>({ markdown: note.markdown, title: note.title });
  const conflictRef = useRef<NoteDoc | null>(null);
  const titleRef = useRef(title);
  const container = useRef<HTMLDivElement>(null);
  const slash = useMemo(createSlashStore, []);

  const saver = useMemo(
    () =>
      createAutosaver<Snapshot>(
        async (snap) => {
          if (conflictRef.current) throw new Error("Note modifiée ailleurs : choisissez quelle version garder.");
          if (snap.markdown === saved.current.markdown && snap.title === saved.current.title) return;
          try {
            const r = await cadence.call<{ note: NoteDoc }>("update_note", {
              note: note.id,
              content: snap.markdown,
              title: snap.title,
              revision: revision.current,
            });
            revision.current = r.note.revision;
            saved.current = { markdown: snap.markdown, title: r.note.title };
            setMeta({ updatedAt: r.note.updated_at, source: r.note.source, missing: false });
          } catch (e) {
            // Refus de révision ? La note a changé ailleurs : on relit pour proposer un choix.
            const fresh = await cadence.call<{ note: NoteDoc }>("get_note", { note: note.id }).catch(() => null);
            if (fresh && fresh.note.revision !== revision.current) {
              conflictRef.current = fresh.note;
              setConflict(fresh.note);
            }
            throw new Error(errorText(e));
          }
        },
        { delay: 800 },
      ),
    [note.id],
  );
  const status = useSyncExternalStore(saver.subscribe, () => saver.state);

  const extensions = useMemo(() => noteExtensions({ slash, onLink: () => setLinkOpen(true) }), [slash]);
  const editorRef = useRef<Editor | null>(null);
  const snapshot = useCallback(
    (editor: Editor): Snapshot => ({ markdown: docToMarkdown(editor.getJSON()), title: titleRef.current.trim() || "Sans titre" }),
    [],
  );

  const editor = useEditor({
    extensions,
    content: markdownToDoc(note.markdown),
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "note-content", spellcheck: "true", lang: "fr", "aria-label": "Contenu de la note" },
      // Ctrl/⌘ + clic sur un lien : l'ouvrir.
      handleClick: (view, pos, event) => {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const link = view.state.doc
          .resolve(pos)
          .marks()
          .find((m) => m.type.name === "link");
        if (!link) return false;
        openLink(String(link.attrs.href));
        return true;
      },
    },
    onCreate: ({ editor }) => {
      editorRef.current = editor;
    },
    onUpdate: ({ editor }) => {
      setEmpty(editor.isEmpty);
      saver.change(snapshot(editor));
    },
  });
  editorRef.current = editor;

  // Remplace le contenu par une version enregistrée (IA, autre fenêtre), sans la renvoyer.
  const load = useCallback(
    (fresh: NoteDoc) => {
      saver.cancel();
      editor.commands.setContent(markdownToDoc(fresh.markdown), { emitUpdate: false });
      setTitle(fresh.title === "Sans titre" ? "" : fresh.title);
      titleRef.current = fresh.title;
      revision.current = fresh.revision;
      saved.current = { markdown: fresh.markdown, title: fresh.title };
      setMeta({ updatedAt: fresh.updated_at, source: fresh.source, missing: fresh.missing_file });
      setEmpty(editor.isEmpty);
      conflictRef.current = null;
      setConflict(null);
    },
    [editor, saver],
  );

  // Note enregistrée ailleurs (IA, autre fenêtre) ou supprimée.
  useEffect(() => {
    const offSaved = cadence.on("note-saved", (data) => {
      const d = data as { id?: string; revision?: number };
      if (d.id !== note.id || (d.revision ?? 0) <= revision.current) return;
      // Pendant notre propre enregistrement, l'événement arrive parfois avant la réponse.
      if (saver.state.status === "saving") return;
      void cadence.call<{ note: NoteDoc }>("get_note", { note: note.id }).then(({ note: fresh }) => {
        if (fresh.revision <= revision.current) return;
        if (saver.state.status === "saved") load(fresh);
        else {
          conflictRef.current = fresh;
          setConflict(fresh);
        }
      });
    });
    const offDeleted = cadence.on("note-deleted", (data) => {
      if ((data as { id?: string }).id === note.id) {
        saver.cancel();
        setDeleted(true);
      }
    });
    return () => {
      offSaved();
      offDeleted();
    };
  }, [note.id, saver, load]);

  // Enregistre ce qui reste en quittant la note ou en cachant la fenêtre.
  useEffect(() => {
    const flush = () => void saver.flush().catch(() => {});
    const onHide = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [saver]);

  // Lien vers une section (`page`) : défile jusqu'à son titre.
  useEffect(() => {
    if (!page || page <= 1) return;
    const target = headingIndexForPage(note.sections, page);
    if (target < 0) return;
    let seen = -1;
    let found: number | null = null;
    editor.state.doc.forEach((node, offset) => {
      if (found === null && node.type.name === "heading" && Number(node.attrs.level) <= 3 && ++seen === target) {
        found = offset;
      }
    });
    if (found === null) return;
    const pos: number = found;
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "start" });
    editor.commands.setTextSelection(pos + 1);
  }, [editor, page, note.sections]);

  const changeTitle = (value: string) => {
    setTitle(value);
    titleRef.current = value;
    saver.change(snapshot(editor));
  };

  const keepMine = () => {
    if (!conflict) return;
    revision.current = conflict.revision;
    conflictRef.current = null;
    setConflict(null);
    saved.current = { markdown: "\u0000", title: "" }; // force l'envoi
    saver.change(snapshot(editor));
    void saver.flush().catch(() => {});
  };

  const remove = async () => {
    try {
      saver.cancel();
      await cadence.call("delete_note", { note: note.id });
      await cadence.notify(`Note « ${saved.current.title} » supprimée`, "success");
      await cadence.navigate("bibliotheque");
    } catch (e) {
      await cadence.notify(errorText(e), "error");
    }
  };

  const summarize = async () => {
    try {
      await cadence.runAction("prendre-des-notes", { subject: note.subject, chapter: note.chapter, note: note.id });
      await cadence.notify("Résumé en préparation : il s'écrira dans cette note.", "info");
    } catch (e) {
      await cadence.notify(errorText(e), "error");
    }
  };

  if (deleted) {
    return (
      <div className="p-6">
        <Callout tone="warning">Cette note a été supprimée.</Callout>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saver.flush().catch(() => {});
        }
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="pen" size={17} className="text-green" />
        <button
          type="button"
          className="min-w-0 truncate text-caption text-tx3 hover:text-tx"
          onClick={() => void cadence.navigate("bibliotheque")}
        >
          {note.subject_name} › {note.chapter_name}
        </button>
        <div className="grow" />
        <SaveIndicator state={status} />
        <Button
          size="xs"
          variant="ghost"
          icon="sparkle"
          onClick={() =>
            void cadence.runAction("poser-question", { subject: note.subject, chapter: note.chapter, document: note.id })
          }
        >
          Poser une question
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button size="xs" variant="ghost" iconRight="chevronDown">
              Note
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => void saver.flush().catch(() => {})}>Enregistrer maintenant</MenuItem>
            <MenuItem onSelect={() => void summarize()}>Compléter avec l'IA (résumé du chapitre)</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => setConfirmDelete(true)}>Supprimer la note…</MenuItem>
          </MenuContent>
        </Menu>
      </header>

      <main className="min-h-0 grow overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-16 pt-10 pb-24">
          <input
            className="w-full bg-transparent font-display text-display font-semibold text-tx outline-none placeholder:text-tx3"
            placeholder="Sans titre"
            aria-label="Titre de la note"
            // Note toute neuve : on commence par son titre.
            autoFocus={note.title === "Sans titre" && !note.markdown.trim()}
            value={title}
            onChange={(e) => changeTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                // Focus synchrone (la commande `focus` attend une frame d'animation).
                const { state, view } = editor;
                view.dispatch(state.tr.setSelection(Selection.atStart(state.doc)));
                view.focus();
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-tiny text-tx3">
            <span className="mono truncate" title={meta.source}>
              {meta.source}
            </span>
            {meta.updatedAt && <span>modifiée {formatDate(meta.updatedAt)}</span>}
          </div>
          {meta.missing && (
            <Callout tone="warning">
              Le fichier de cette note a été déplacé ou supprimé : le texte vient de la copie de Cadence, et le
              prochain enregistrement recrée le fichier.
            </Callout>
          )}
          {conflict && (
            <Callout tone="warning">
              <div className="flex flex-col gap-2">
                <span>
                  Cette note a été modifiée ailleurs (révision {conflict.revision}, peut-être par l'IA) pendant que vous
                  l'éditiez.
                </span>
                <div className="flex gap-2">
                  <Button size="xs" variant="secondary" onClick={() => load(conflict)}>
                    Charger cette version
                  </Button>
                  <Button size="xs" variant="ghost" onClick={keepMine}>
                    Garder la mienne
                  </Button>
                </div>
              </div>
            </Callout>
          )}

          <TableBar editor={editor} />
          <div ref={container} className="relative">
            <EditorContent editor={editor} />
            <BlockHandle editor={editor} container={container} />
          </div>

          {empty && !conflict && (
            <Card className="mt-2 flex items-center gap-3 px-4 py-3">
              <Icon name="sparkle" size={15} className="text-clay" />
              <span className="grow text-body-sm text-tx2">
                Tapez <Kbd boxed>/</Kbd> pour insérer un titre, une liste, un tableau ou un lien vers un cours, ou
                laissez l'IA résumer le chapitre dans cette note.
              </span>
              <Button size="xs" variant="ghost" icon="sparkle" onClick={() => void summarize()}>
                Résumer le chapitre
              </Button>
            </Card>
          )}
        </div>
      </main>

      <SlashMenu store={slash} />
      <FormatBubble editor={editor} onLink={() => setLinkOpen(true)} />
      <LinkDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        editor={editor}
        documents={documents.filter((d) => d.id !== note.id)}
      />
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete} width={440}>
        <DialogHeader title="Supprimer la note" icon="warning" />
        <DialogBody>
          <p className="text-body-sm leading-[1.6] text-tx2">
            « {saved.current.title} » sera retirée de la bibliothèque et son fichier Markdown effacé du dossier des
            cours.
          </p>
        </DialogBody>
        <DialogFooter className="justify-end">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
            Annuler
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            Supprimer
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

/* ---------- Indicateur de sauvegarde ---------- */

function SaveIndicator({ state }: { state: AutosaveState }) {
  const tone =
    state.status === "error" ? "text-red" : state.status === "saved" ? "text-tx3" : "text-tx2";
  return (
    <span className={cn("flex items-center gap-1.5 text-caption", tone)} title={state.error ?? undefined} role="status">
      {state.status === "saving" ? (
        <Spinner size={12} />
      ) : state.status === "error" ? (
        <Icon name="warning" size={13} />
      ) : state.status === "saved" ? (
        <Icon name="check" size={13} />
      ) : (
        <span className="size-1.5 rounded-full bg-amber" />
      )}
      {saveLabel(state)}
    </span>
  );
}

/* ---------- Menu « / » ---------- */

function SlashMenu({ store }: { store: SlashStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [state.index, state.open]);
  if (!state.open || !state.rect) return null;
  const height = 320;
  const below = state.rect.bottom + 6 + height < window.innerHeight;
  const left = Math.min(state.rect.left, window.innerWidth - 300);
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Insérer un bloc"
      className="fixed z-50 flex max-h-[320px] w-[288px] flex-col overflow-y-auto rounded-card border border-line2 bg-panel p-1 shadow-modal"
      style={below ? { left, top: state.rect.bottom + 6 } : { left, bottom: window.innerHeight - state.rect.top + 6 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.items.length === 0 && <div className="px-3 py-2 text-caption text-tx3">Aucun bloc ne correspond</div>}
      {state.items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === state.index}
          className={cn(
            "flex items-center gap-2.5 rounded-control px-2 py-1.5 text-left",
            i === state.index ? "bg-p3" : "hover:bg-p2",
          )}
          onMouseEnter={() => store.set({ index: i })}
          onClick={() => state.choose?.(item)}
        >
          <span className="mono flex size-7 shrink-0 items-center justify-center rounded-control border border-line bg-p2 text-caption text-tx2">
            {item.glyph}
          </span>
          <span className="flex min-w-0 grow flex-col">
            <span className="text-body text-tx">{item.label}</span>
            <span className="truncate text-tiny text-tx3">{item.hint}</span>
          </span>
          {item.markdown && <Kbd>{item.markdown}</Kbd>}
        </button>
      ))}
    </div>
  );
}

/* ---------- Poignée de bloc : ajouter, glisser ---------- */

function BlockHandle({ editor, container }: { editor: Editor; container: RefObject<HTMLDivElement | null> }) {
  const [hover, setHover] = useState<{ top: number; pos: number } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      if (dragging.current || editor.isDestroyed) return;
      const view = editor.view;
      const box = view.dom.getBoundingClientRect();
      if (e.clientY < box.top || e.clientY > box.bottom) return setHover(null);
      const hit = view.posAtCoords({ left: box.left + 12, top: e.clientY });
      if (!hit) return;
      const $pos = view.state.doc.resolve(hit.pos);
      const pos = $pos.depth > 0 ? $pos.before(1) : hit.inside >= 0 ? hit.inside : hit.pos;
      const node = view.state.doc.nodeAt(pos);
      const dom = node ? view.nodeDOM(pos) : null;
      if (!(dom instanceof HTMLElement)) return;
      const r = dom.getBoundingClientRect();
      const c = el.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(dom).lineHeight) || 24;
      const first = node?.isTextblock ? Math.min(line, r.height) : 24;
      setHover({ top: r.top - c.top + (first - 24) / 2, pos });
    };
    const onLeave = () => !dragging.current && setHover(null);
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [editor, container]);

  if (!hover) return null;

  const add = () => {
    const node = editor.state.doc.nodeAt(hover.pos);
    if (!node) return;
    const after = hover.pos + node.nodeSize;
    editor
      .chain()
      .insertContentAt(after, { type: "paragraph", content: [{ type: "text", text: "/" }] })
      .setTextSelection(after + 2)
      .focus()
      .run();
  };

  const select = () => {
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hover.pos)));
    view.focus();
  };

  return (
    <div className="absolute -left-12 flex items-center gap-0.5" style={{ top: hover.top }} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label="Ajouter un bloc en dessous"
        title="Ajouter un bloc en dessous"
        className="flex size-6 items-center justify-center rounded-control text-tx3 hover:bg-p3 hover:text-tx"
        onClick={add}
      >
        <Icon name="plus" size={14} />
      </button>
      <span
        role="button"
        tabIndex={-1}
        aria-label="Glisser pour déplacer le bloc (ou Alt+↑ / Alt+↓)"
        title="Glisser pour déplacer · Alt+↑ / Alt+↓"
        draggable
        className="flex h-6 w-4 cursor-grab items-center justify-center rounded-control text-caption leading-none text-tx3 select-none hover:bg-p3 hover:text-tx"
        onClick={select}
        onDragStart={(e) => {
          const { view } = editor;
          const selection = NodeSelection.create(view.state.doc, hover.pos);
          view.dispatch(view.state.tr.setSelection(selection));
          const dom = view.nodeDOM(hover.pos);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", selection.node.textContent);
          if (dom instanceof HTMLElement) e.dataTransfer.setDragImage(dom, 0, 0);
          // ProseMirror déplace la tranche au dépôt (`move`) et retire le bloc d'origine.
          (view as unknown as { dragging: unknown }).dragging = { slice: selection.content(), move: true, node: selection };
          dragging.current = true;
        }}
        onDragEnd={() => {
          dragging.current = false;
          setHover(null);
        }}
      >
        ⋮⋮
      </span>
    </div>
  );
}

/* ---------- Barre des tableaux ---------- */

function TableBar({ editor }: { editor: Editor }) {
  const inTable = useEditorState({ editor, selector: ({ editor }) => editor.isActive("table") });
  if (!inTable) return null;
  const run = (f: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => f(editor.chain().focus()).run();
  return (
    <div className="sticky top-2 z-10 flex flex-wrap items-center gap-1.5 self-start rounded-card border border-line2 bg-panel px-2 py-1.5 shadow-modal">
      <span className="px-1 text-caption text-tx3">Tableau</span>
      <Button size="xs" variant="quiet" icon="plus" onClick={() => run((c) => c.addRowAfter())}>
        Ligne
      </Button>
      <Button size="xs" variant="quiet" icon="plus" onClick={() => run((c) => c.addColumnAfter())}>
        Colonne
      </Button>
      <Button size="xs" variant="quiet" onClick={() => run((c) => c.deleteRow())}>
        Retirer la ligne
      </Button>
      <Button size="xs" variant="quiet" onClick={() => run((c) => c.deleteColumn())}>
        Retirer la colonne
      </Button>
      <Button size="xs" variant="quiet" icon="close" onClick={() => run((c) => c.deleteTable())}>
        Supprimer
      </Button>
    </div>
  );
}

/* ---------- Mise en forme de la sélection ---------- */

function FormatBubble({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      strike: editor.isActive("strike"),
      code: editor.isActive("code"),
      link: editor.isActive("link") ? String(editor.getAttributes("link").href ?? "") : null,
      empty: editor.state.selection.empty,
    }),
  });
  const mark = (active: boolean, label: string, title: string, toggle: () => void, className?: string) => (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      className={cn(
        "flex h-7 min-w-7 items-center justify-center rounded-control px-1.5 text-body-sm",
        active ? "bg-p4 text-tx" : "text-tx2 hover:bg-p3 hover:text-tx",
        className,
      )}
      onClick={toggle}
    >
      {label}
    </button>
  );
  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor, state: s }) =>
        editor.isEditable &&
        s.selection instanceof TextSelection &&
        !editor.isActive("codeBlock") &&
        (!s.selection.empty || editor.isActive("link"))
      }
      className="z-40 flex items-center gap-0.5 rounded-card border border-line2 bg-panel p-1 shadow-modal"
    >
      {!state.empty && (
        <>
          {mark(state.bold, "G", "Gras (Ctrl+B)", () => editor.chain().focus().toggleBold().run(), "font-bold")}
          {mark(state.italic, "I", "Italique (Ctrl+I)", () => editor.chain().focus().toggleItalic().run(), "italic")}
          {mark(state.strike, "S", "Barré", () => editor.chain().focus().toggleStrike().run(), "line-through")}
          {mark(state.code, "</>", "Code (Ctrl+E)", () => editor.chain().focus().toggleCode().run(), "mono text-caption")}
          {mark(!!state.link, "Lien", "Lier à un document ou une adresse", onLink)}
        </>
      )}
      {state.link !== null && (
        <>
          {!state.empty && <span className="mx-0.5 h-4 w-px bg-line2" />}
          <span className="mono max-w-[220px] truncate px-1.5 text-tiny text-tx3" title={state.link}>
            {state.link}
          </span>
          {mark(false, "Ouvrir", "Ouvrir le lien (Ctrl+clic)", () => openLink(state.link ?? ""))}
          {mark(false, "Retirer", "Retirer le lien", () => editor.chain().focus().extendMarkRange("link").unsetLink().run())}
        </>
      )}
    </BubbleMenu>
  );
}

/* ---------- Lien vers un document ---------- */

function LinkDialog({
  open,
  onClose,
  editor,
  documents,
}: {
  open: boolean;
  onClose: () => void;
  editor: Editor;
  documents: DocumentInfo[];
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [page, setPage] = useState("");
  useEffect(() => {
    if (open) {
      setQuery("");
      setChosen(null);
      setPage("");
    }
  }, [open]);

  const q = foldText(query.trim());
  const matches = documents.filter((d) =>
    [d.title, d.subject_name, d.chapter_name].some((t) => foldText(t).includes(q)),
  );
  const url = /^https?:\/\/\S+$/i.test(query.trim()) ? query.trim() : null;
  const doc = documents.find((d) => d.id === chosen) ?? null;
  const pageNumber = Number(page);
  const validPage = Number.isInteger(pageNumber) && pageNumber > 0 && (!doc || pageNumber <= doc.pages) ? pageNumber : null;

  const insert = (href: string, text: string) => {
    const chain = editor.chain().focus();
    if (editor.state.selection.empty) {
      chain.insertContent([{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }, { type: "text", text: " " }]);
    } else {
      chain.extendMarkRange("link").setLink({ href });
    }
    chain.run();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} width={560} placement="top">
      <DialogHeader title="Lien vers un document" icon="link" />
      <DialogBody>
        <Input
          autoFocus
          size="md"
          placeholder="Rechercher un cours, une note… ou coller une adresse web"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex max-h-[280px] flex-col overflow-y-auto rounded-field border border-line">
          {url && (
            <button
              type="button"
              className="flex items-center gap-2.5 border-b border-line px-3 py-2 text-left hover:bg-p2"
              onClick={() => insert(url, url)}
            >
              <Icon name="link" size={14} className="text-tx3" />
              <span className="truncate text-body">Lien web : {url}</span>
            </button>
          )}
          {matches.length === 0 && !url && <div className="px-3 py-3 text-caption text-tx3">Aucun document trouvé.</div>}
          {matches.map((d) => (
            <button
              key={d.id}
              type="button"
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 text-left",
                d.id === chosen ? "bg-p3" : "hover:bg-p2",
              )}
              onClick={() => setChosen(d.id)}
              onDoubleClick={() => insert(documentLink(d.id), d.title)}
            >
              <Icon name={d.kind === "note" ? "pen" : "file"} size={14} className={d.kind === "note" ? "text-green" : "text-tx3"} />
              <span className="min-w-0 grow">
                <span className="block truncate text-body">{d.title}</span>
                <span className="block truncate text-tiny text-tx3">
                  {d.subject_name} › {d.chapter_name}
                </span>
              </span>
              <span className="text-tiny text-tx3">{kindMeta[d.kind].label}</span>
            </button>
          ))}
        </div>
        {doc && (
          <div className="flex items-center gap-3">
            <span className="text-body-sm text-tx2">
              {doc.kind === "note" ? "Section" : doc.kind === "pptx" ? "Diapositive" : doc.kind === "pdf" ? "Page" : "Bloc"}{" "}
              (facultatif, 1 à {doc.pages})
            </span>
            <Input
              size="sm"
              className="w-24"
              inputMode="numeric"
              placeholder="—"
              value={page}
              onChange={(e) => setPage(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        )}
      </DialogBody>
      <DialogFooter className="justify-end">
        <Button variant="ghost" onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="primary"
          icon="link"
          disabled={!doc || (page !== "" && validPage === null)}
          onClick={() => doc && insert(documentLink(doc.id, validPage), linkText(doc.title, validPage, pageAbbrev(doc.kind)))}
        >
          Insérer le lien
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

