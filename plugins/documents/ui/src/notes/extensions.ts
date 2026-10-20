/**
 * Extensions TipTap de l'éditeur de notes : StarterKit (titres, listes, citation, code,
 * séparateur, gras, italique, barré, liens, raccourcis Markdown à la frappe), cases à cocher,
 * tableaux, texte d'invite, menu « / » et déplacement des blocs au clavier (Alt+↑ / Alt+↓).
 * Tout est embarqué dans le build : aucun appel réseau.
 */
import { Extension, type Editor, type Range } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Selection, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Suggestion from "@tiptap/suggestion";
import { filterBlocks, type BlockChoice, type BlockId } from "./blocks";

/* ---------- Menu « / » ---------- */

export interface SlashState {
  open: boolean;
  items: BlockChoice[];
  index: number;
  /** Position du curseur à l'écran (le menu s'affiche dessous). */
  rect: { left: number; top: number; bottom: number } | null;
  choose: ((block: BlockChoice) => void) | null;
}

/** Petit magasin observable, lu par le composant du menu avec useSyncExternalStore. */
export function createSlashStore() {
  let state: SlashState = { open: false, items: [], index: 0, rect: null, choose: null };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: Partial<SlashState>) {
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type SlashStore = ReturnType<typeof createSlashStore>;

/** Applique un bloc du menu à la position du curseur (après avoir effacé « /requête »). */
export function runBlock(editor: Editor, id: Exclude<BlockId, "link">, range?: Range) {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  switch (id) {
    case "paragraph":
      chain.setParagraph();
      break;
    case "h1":
    case "h2":
    case "h3":
      chain.setHeading({ level: Number(id[1]) as 1 | 2 | 3 });
      break;
    case "bullets":
      chain.toggleBulletList();
      break;
    case "numbers":
      chain.toggleOrderedList();
      break;
    case "tasks":
      chain.toggleTaskList();
      break;
    case "quote":
      chain.toggleBlockquote();
      break;
    case "code":
      chain.setCodeBlock();
      break;
    case "divider":
      chain.setHorizontalRule();
      break;
    case "table":
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true });
      break;
  }
  chain.run();
}

interface SlashOptions {
  store: SlashStore | null;
  /** « Lien vers un document » : ouvre le sélecteur de l'écran. */
  onLink: (editor: Editor) => void;
}

const SlashCommand = Extension.create<SlashOptions>({
  name: "slashCommand",
  addOptions() {
    return { store: null, onLink: () => {} };
  },
  addProseMirrorPlugins() {
    const { store, onLink } = this.options;
    const close = () => store?.set({ open: false, choose: null, rect: null });
    const show = (props: { items: BlockChoice[]; clientRect?: (() => DOMRect | null) | null; command: (b: BlockChoice) => void }) => {
      const rect = props.clientRect?.() ?? null;
      const index = Math.min(store?.get().index ?? 0, Math.max(props.items.length - 1, 0));
      store?.set({
        open: true,
        items: props.items,
        index,
        rect: rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null,
        choose: props.command,
      });
    };
    return [
      Suggestion<BlockChoice, BlockChoice>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        allowedPrefixes: [" "],
        items: ({ query }) => filterBlocks(query),
        allow: ({ editor }) => !editor.isActive("codeBlock"),
        command: ({ editor, range, props }) => {
          if (props.id === "link") {
            editor.chain().focus().deleteRange(range).run();
            onLink(editor);
          } else {
            runBlock(editor, props.id, range);
          }
        },
        render: () => ({
          onStart: (props) => {
            store?.set({ index: 0 });
            show(props);
          },
          onUpdate: show,
          onExit: close,
          onKeyDown: ({ event }) => {
            const s = store?.get();
            if (!s?.open) return false;
            const n = s.items.length;
            if (event.key === "Escape") {
              close();
              return true;
            }
            if (!n) return false;
            if (event.key === "ArrowDown") {
              store?.set({ index: (s.index + 1) % n });
              return true;
            }
            if (event.key === "ArrowUp") {
              store?.set({ index: (s.index - 1 + n) % n });
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              const item = s.items[s.index];
              if (item) s.choose?.(item);
              return true;
            }
            return false;
          },
        }),
      }),
    ];
  },
});

/* ---------- Déplacer un bloc ---------- */

/** Échange le bloc de premier niveau du curseur avec son voisin (`-1` : au-dessus). */
export function moveBlock(editor: Editor, dir: -1 | 1): boolean {
  const { state, view } = editor;
  const { $from } = state.selection;
  if ($from.depth < 1) return false;
  const index = $from.index(0);
  const target = index + dir;
  if (target < 0 || target >= state.doc.childCount) return false;
  const node = state.doc.child(index);
  const other = state.doc.child(target);
  const pos = $from.before(1);
  const offset = state.selection.from - pos;
  const start = dir < 0 ? pos - other.nodeSize : pos;
  const end = dir < 0 ? pos + node.nodeSize : pos + node.nodeSize + other.nodeSize;
  const tr = state.tr.replaceWith(start, end, dir < 0 ? [node, other] : [other, node]);
  const at = dir < 0 ? start + offset : start + other.nodeSize + offset;
  const selection = (() => {
    try {
      return TextSelection.create(tr.doc, at);
    } catch {
      return Selection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size)));
    }
  })();
  view.dispatch(tr.setSelection(selection).scrollIntoView());
  return true;
}

const MoveBlock = Extension.create({
  name: "moveBlock",
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": () => moveBlock(this.editor, -1),
      "Alt-ArrowDown": () => moveBlock(this.editor, 1),
    };
  },
});

/* ---------- Ensemble ---------- */

export function noteExtensions({ slash, onLink }: { slash: SlashStore; onLink: (editor: Editor) => void }) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      // Pas de soulignement en Markdown : on ne le propose pas.
      underline: false,
      dropcursor: { color: "var(--color-clay)", width: 2 },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        protocols: [{ scheme: "cadence", optionalSlashes: true }],
        isAllowedUri: (url, ctx) => url.startsWith("cadence:") || ctx.defaultValidate(url),
        HTMLAttributes: { rel: null, target: null },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Placeholder.configure({
      placeholder: ({ node }) =>
        node.type.name === "heading" ? "Titre" : "Écrivez, ou tapez « / » pour insérer un bloc…",
      showOnlyCurrent: true,
    }),
    SlashCommand.configure({ store: slash, onLink }),
    MoveBlock,
  ];
}
