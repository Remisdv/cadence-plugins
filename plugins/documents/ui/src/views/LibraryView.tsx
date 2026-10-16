/** Vue « Bibliothèque » : Matière → Chapitre → Documents, import de fichiers. */
import { useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card, Field, Icon, Input, SectionLabel, Spinner } from "@cadence/ui";
import { ACCEPTED_EXTENSIONS, groupDocuments, kindMeta, type DocumentInfo } from "../domain";
import { useTool } from "../useTool";

export function LibraryView() {
  const { data, error, loading, reload } = useTool<{ documents: DocumentInfo[] }>("list_documents");
  const [importing, setImporting] = useState(false);
  const groups = groupDocuments(data?.documents ?? []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="book" size={17} className="text-clay" />
        <h1 className="font-display text-title">Bibliothèque</h1>
        <span className="text-caption text-tx3">{data ? `${data.documents.length} document(s)` : ""}</span>
        <div className="grow" />
        <Button size="sm" variant="ghost" icon="refresh" iconOnly aria-label="Rafraîchir" onClick={reload} />
        <Button size="sm" variant="primary" icon="plus" onClick={() => setImporting(true)}>
          Importer
        </Button>
      </header>

      <main className="min-h-0 grow overflow-y-auto p-5">
        {importing && (
          <ImportCard
            onDone={() => {
              setImporting(false);
              reload();
            }}
            onCancel={() => setImporting(false)}
          />
        )}
        {loading && !data && (
          <div className="flex items-center gap-2 text-body-sm text-tx3">
            <Spinner /> Chargement…
          </div>
        )}
        {error && <Callout tone="danger">{error.message}</Callout>}
        {data && data.documents.length === 0 && !importing && (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <Icon name="folder" size={19} className="text-tx3" />
            <p className="text-body-sm text-tx2">
              Aucun cours pour l'instant. Importez des PDF, Word, PowerPoint ou Markdown et rangez-les par
              matière et chapitre.
            </p>
            <Button variant="secondary" icon="plus" onClick={() => setImporting(true)}>
              Importer des cours
            </Button>
          </Card>
        )}

        <div className="flex flex-col gap-6">
          {[...groups].map(([subjectId, subject]) => (
            <section key={subjectId} className="flex flex-col gap-3">
              <h2 className="text-title-sm">{subject.name}</h2>
              {[...subject.chapters].map(([chapterId, chapter]) => (
                <div key={chapterId} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <SectionLabel>{chapter.name}</SectionLabel>
                    <div className="grow" />
                    <Button
                      size="xs"
                      variant="ghost"
                      icon="sparkle"
                      onClick={() => void cadence.runAction("poser-question", { subject: subjectId, chapter: chapterId })}
                    >
                      Poser une question
                    </Button>
                  </div>
                  <Card className="divide-y divide-line">
                    {chapter.docs.map((d) => (
                      <div key={d.id} className="flex min-h-[42px] items-center gap-3 px-3.5 py-2">
                        <Icon name="file" size={15} className="text-tx3" />
                        <div className="min-w-0 grow">
                          <div className="truncate text-body">{d.title}</div>
                          <div className="mono truncate text-tiny text-tx3">{d.source}</div>
                        </div>
                        <Badge tone={kindMeta[d.kind].tone}>{kindMeta[d.kind].label}</Badge>
                        <span className="mono w-[90px] shrink-0 text-right text-caption text-tx3">
                          {d.pages} {d.kind === "pptx" ? "diapo." : d.kind === "pdf" ? "p." : "blocs"}
                        </span>
                      </div>
                    ))}
                  </Card>
                </div>
              ))}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

function ImportCard({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [chapter, setChapter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    const picked = await cadence.pickFiles({
      title: "Cours à importer",
      multiple: true,
      filters: [{ name: "Cours", extensions: ACCEPTED_EXTENSIONS }],
    });
    if (picked.length) setFiles(picked);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const path of files) {
        await cadence.call("import_document", { path, subject: subject.trim(), chapter: chapter.trim() });
      }
      await cadence.notify(`${files.length} document(s) importé(s)`, "success");
      onDone();
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = files.length > 0 && subject.trim() && chapter.trim();
  return (
    <Card className="mb-5 flex flex-col gap-4 p-[18px]">
      <div className="flex items-center gap-2">
        <Icon name="download" size={16} className="text-clay" />
        <h2 className="grow text-title-sm">Importer des cours</h2>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="secondary" icon="folder" onClick={() => void pick()}>
          Choisir des fichiers
        </Button>
        <span className="text-caption text-tx3">
          {files.length ? `${files.length} fichier(s) choisi(s)` : "PDF, Word (.docx), PowerPoint (.pptx), Markdown, texte"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Matière" htmlFor="subject" required>
          <Input id="subject" size="md" placeholder="Chimie" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Chapitre" htmlFor="chapter" required>
          <Input id="chapter" size="md" placeholder="Atomistique" value={chapter} onChange={(e) => setChapter(e.target.value)} />
        </Field>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Annuler
        </Button>
        <Button variant="primary" icon="check" disabled={!ready || busy} onClick={() => void run()}>
          {busy ? "Import en cours…" : "Importer"}
        </Button>
      </div>
    </Card>
  );
}
