/**
 * Vue « Notes » (`document`) : cible des liens `cadence:documents/document?doc=…&page=…`.
 *
 * - sans `doc` : les notes de la bibliothèque, les plus récentes d'abord, et « Nouvelle note » ;
 * - une note : l'éditeur (la `page` désigne une section) ;
 * - un autre document : son texte, page par page, depuis le cache d'extraction.
 */
import { useEffect, useState } from "react";
import { cadence } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card, Field, Icon, Input, SectionLabel, Spinner } from "@cadence/ui";
import {
  formatDate,
  kindMeta,
  pageName,
  type DocumentInfo,
  type NoteDoc,
  type NoteSummary,
  type PagesRead,
} from "../domain";
import { createNote, errorText } from "../notes/actions";
import { documentLink, linkText, pageAbbrev } from "../notes/blocks";
import { NoteEditor } from "../notes/NoteEditor";
import { useTool } from "../useTool";

export function DocumentView({ params }: { params: Record<string, string> }) {
  const page = Number(params.page);
  if (!params.doc) return <NotesIndex />;
  return <DocumentScreen key={params.doc} doc={params.doc} page={Number.isInteger(page) && page > 0 ? page : undefined} />;
}

function DocumentScreen({ doc, page }: { doc: string; page?: number }) {
  const docs = useTool<{ documents: DocumentInfo[] }>("list_documents");
  const [note, setNote] = useState<NoteDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = docs.data?.documents.find((d) => d.id === doc);

  // Une note se charge une fois : l'éditeur gère ensuite son contenu et ses enregistrements.
  useEffect(() => {
    if (info?.kind !== "note" || note) return;
    cadence
      .call<{ note: NoteDoc }>("get_note", { note: doc })
      .then((r) => setNote(r.note))
      .catch((e: unknown) => setError(errorText(e)));
  }, [info?.kind, doc, note]);

  if (docs.error || error) {
    return (
      <div className="p-6">
        <Callout tone="danger">{error ?? docs.error?.message}</Callout>
      </div>
    );
  }
  if (!docs.data || (info?.kind === "note" && !note)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }
  if (!info) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Callout tone="warning">Document « {doc} » introuvable dans la bibliothèque (supprimé ou renommé ?).</Callout>
        <div>
          <Button variant="secondary" icon="book" onClick={() => void cadence.navigate("bibliotheque")}>
            Ouvrir la bibliothèque
          </Button>
        </div>
      </div>
    );
  }
  if (note) return <NoteEditor note={note} page={page} documents={docs.data.documents} />;
  return <PageReader doc={info} page={page ?? 1} />;
}

/* ---------- Lecture d'un cours ---------- */

function PageReader({ doc, page: initial }: { doc: DocumentInfo; page: number }) {
  const [page, setPage] = useState(Math.min(initial, doc.pages || 1));
  useEffect(() => setPage(Math.min(initial, doc.pages || 1)), [initial, doc.pages]);
  const read = useTool<PagesRead>("read_pages", { document: doc.id, from: page, to: page });
  const text = read.data?.pages[0]?.text ?? "";
  const total = read.data?.total_pages ?? doc.pages;

  const takeNote = () =>
    void createNote({
      subject: doc.subject,
      chapter: doc.chapter,
      title: `Notes — ${doc.title}`,
      content: `Source : [${linkText(doc.title, page, pageAbbrev(doc.kind))}](${documentLink(doc.id, page)})\n`,
    });

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="file" size={17} className="text-clay" />
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate font-display text-title">{doc.title}</h1>
          <button
            type="button"
            className="truncate text-left text-tiny text-tx3 hover:text-tx"
            onClick={() => void cadence.navigate("bibliotheque")}
          >
            {doc.subject_name} › {doc.chapter_name}
          </button>
        </div>
        <Badge tone={kindMeta[doc.kind].tone}>{kindMeta[doc.kind].label}</Badge>
        <div className="grow" />
        <Button
          size="xs"
          variant="ghost"
          icon="sparkle"
          onClick={() => void cadence.runAction("poser-question", { subject: doc.subject, chapter: doc.chapter, document: doc.id })}
        >
          Poser une question
        </Button>
        <Button size="xs" variant="ghost" icon="pen" onClick={takeNote}>
          Prendre une note
        </Button>
      </header>
      <main className="min-h-0 grow overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button size="xs" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Précédente
            </Button>
            <span className="mono text-caption text-tx2">
              {pageName(doc.kind, page)} / {total}
            </span>
            <Button size="xs" variant="ghost" disabled={page >= total} onClick={() => setPage(page + 1)}>
              Suivante
            </Button>
            <div className="grow" />
            <span className="mono truncate text-tiny text-tx3" title={doc.source}>
              {doc.source}
            </span>
          </div>
          {read.error && <Callout tone="danger">{read.error.message}</Callout>}
          <Card className="min-h-[200px] p-5">
            {read.loading && !read.data ? (
              <Spinner />
            ) : (
              <p className="text-body-lg leading-[1.7] whitespace-pre-wrap text-tx">{text || "Page sans texte."}</p>
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}

/* ---------- Liste des notes ---------- */

function NotesIndex() {
  const notes = useTool<{ notes: NoteSummary[]; notes_dir: string }>("list_notes");
  const [creating, setCreating] = useState(false);
  const { reload } = notes;
  useEffect(() => {
    const offs = [cadence.on("note-saved", reload), cadence.on("note-deleted", reload)];
    return () => offs.forEach((off) => off());
  }, [reload]);
  const list = notes.data?.notes ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="pen" size={17} className="text-green" />
        <h1 className="font-display text-title">Notes</h1>
        <span className="text-caption text-tx3">{notes.data ? `${list.length} note(s)` : ""}</span>
        <div className="grow" />
        <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
          Nouvelle note
        </Button>
      </header>
      <main className="min-h-0 grow overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[760px] flex-col gap-4">
          {creating && <NewNoteCard onCancel={() => setCreating(false)} />}
          {notes.loading && !notes.data && (
            <div className="flex items-center gap-2 text-body-sm text-tx3">
              <Spinner /> Chargement…
            </div>
          )}
          {notes.error && <Callout tone="danger">{notes.error.message}</Callout>}
          {notes.data && list.length === 0 && !creating && (
            <Card className="flex flex-col items-center gap-3 p-8 text-center">
              <Icon name="pen" size={19} className="text-tx3" />
              <p className="text-body-sm text-tx2">
                Pas encore de note. Créez-en une depuis un chapitre de la bibliothèque, ou ici : elle est rangée avec
                vos cours, en Markdown, dans <span className="mono">{notes.data.notes_dir}</span>.
              </p>
              <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>
                Nouvelle note
              </Button>
            </Card>
          )}
          {list.length > 0 && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Modifiées récemment</SectionLabel>
              <Card className="divide-y divide-line">
                {list.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="flex min-h-[46px] w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-p2"
                    onClick={() => void cadence.navigate("document", { doc: n.id })}
                  >
                    <Icon name="pen" size={15} className="text-green" />
                    <div className="min-w-0 grow">
                      <div className="truncate text-body">{n.title}</div>
                      <div className="truncate text-tiny text-tx3">
                        {n.subject_name} › {n.chapter_name}
                        {n.sections.some((s) => s.title) &&
                          ` · ${n.sections
                            .flatMap((s) => (s.title ? [s.title] : []))
                            .slice(0, 4)
                            .join(" · ")}`}
                      </div>
                    </div>
                    {n.updated_at && <span className="shrink-0 text-caption text-tx3">{formatDate(n.updated_at)}</span>}
                  </button>
                ))}
              </Card>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** Formulaire « Nouvelle note » : matière, chapitre (créés au besoin) et titre. */
export function NewNoteCard({
  onCancel,
  subject: initialSubject = "",
  chapter: initialChapter = "",
}: {
  onCancel: () => void;
  subject?: string;
  chapter?: string;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [chapter, setChapter] = useState(initialChapter);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = subject.trim() && chapter.trim();
  const run = async () => {
    setBusy(true);
    const note = await createNote({ subject: subject.trim(), chapter: chapter.trim(), title: title.trim() || undefined });
    setBusy(false);
    if (note) onCancel();
  };
  return (
    <Card className="flex flex-col gap-4 p-[18px]">
      <div className="flex items-center gap-2">
        <Icon name="pen" size={16} className="text-green" />
        <h2 className="grow text-title-sm">Nouvelle note</h2>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Matière" htmlFor="note-subject" required>
          <Input id="note-subject" size="md" placeholder="Chimie" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Chapitre" htmlFor="note-chapter" required>
          <Input id="note-chapter" size="md" placeholder="Atomistique" value={chapter} onChange={(e) => setChapter(e.target.value)} />
        </Field>
      </div>
      <Field label="Titre" htmlFor="note-title">
        <Input
          id="note-title"
          size="md"
          placeholder="Sans titre"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ready && void run()}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Annuler
        </Button>
        <Button variant="primary" icon="check" disabled={!ready || busy} onClick={() => void run()}>
          {busy ? "Création…" : "Créer et ouvrir"}
        </Button>
      </div>
    </Card>
  );
}
