/** Actions des notes qui passent par Cadence (création, ouverture d'un lien). */
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import type { NoteDoc } from "../domain";
import { parseDocumentLink } from "./blocks";

export const errorText = (e: unknown) =>
  isCadenceError(e) ? e.message : e instanceof Error ? e.message : String(e);

/** Crée une note (matière et chapitre créés au besoin) et l'ouvre dans l'éditeur. */
export async function createNote(args: { subject: string; chapter: string; title?: string; content?: string }) {
  try {
    const { note } = await cadence.call<{ note: NoteDoc }>("create_note", args);
    await cadence.navigate("document", { doc: note.id });
    return note;
  } catch (e) {
    await cadence.notify(errorText(e), "error");
    return null;
  }
}

/** Ouvre un lien d'une note : document de la bibliothèque, autre vue du plugin ou page web. */
export function openLink(href: string) {
  const target = parseDocumentLink(href);
  if (target) {
    void cadence.navigate("document", target.page ? { doc: target.doc, page: String(target.page) } : { doc: target.doc });
    return;
  }
  const view = /^cadence:documents\/([a-z0-9-]+)(?:\?(.*))?$/.exec(href);
  if (view) {
    void cadence.navigate(view[1]!, Object.fromEntries(new URLSearchParams(view[2] ?? "")));
    return;
  }
  if (/^https?:\/\//i.test(href)) void cadence.openExternal(href);
}
