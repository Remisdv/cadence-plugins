/**
 * « Créer des issues depuis un document » : on choisit d'abord le document — fichiers
 * (`cadence.pickFiles`) et/ou texte collé — puis l'action `extraire-issues` part avec ce contexte
 * (`{ type: "document", repo, document: { text?, files? } }`). Sans document, rien n'est lancé :
 * un tour d'IA ne sert plus à réclamer le document.
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
  Textarea,
} from "@cadence/ui";
import { documentContext, fileName } from "../issues";

export function DocumentDialog({
  repos,
  initialRepo,
  onClose,
}: {
  repos: string[];
  initialRepo: string | null;
  onClose: () => void;
}) {
  const ids = { repo: useId(), text: useId() };
  const [repo, setRepo] = useState(initialRepo ?? (repos.length === 1 ? repos[0]! : ""));
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const context = repo ? documentContext(repo, { text, files }) : null;

  const pick = async () => {
    try {
      const chosen = await cadence.pickFiles({
        title: "Document à transformer en issues",
        multiple: true,
      });
      if (chosen.length) setFiles((f) => [...f, ...chosen.filter((c) => !f.includes(c))]);
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    }
  };

  const launch = async () => {
    if (!context) return;
    setBusy(true);
    setError(null);
    try {
      await cadence.runAction("extraire-issues", context);
      onClose();
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={600}>
      <DialogHeader
        title="Créer des issues depuis un document"
        icon="file"
        meta={repo || undefined}
      />
      <DialogBody className="flex max-h-[calc(100vh-200px)] flex-col gap-4 overflow-y-auto">
        <p className="text-body-sm leading-[1.6] text-tx2">
          L'IA lit le document, vérifie le code et les issues existantes, puis crée les issues
          manquantes, chiffrées en story points et rangées dans un jalon de la roadmap.
        </p>
        {!initialRepo && repos.length > 1 && (
          <Field label="Dépôt" htmlFor={ids.repo} required>
            <Select id={ids.repo} value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">Choisir un dépôt…</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-small font-medium text-tx2">Fichiers</span>
            <div className="grow" />
            <Button size="sm" icon="file" onClick={() => void pick()}>
              Choisir des fichiers…
            </Button>
          </div>
          {files.length === 0 ? (
            <p className="text-caption text-tx3">
              Texte, Markdown, PDF, Word, HTML… plusieurs fichiers possibles.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {files.map((f) => (
                <Badge key={f} tone="muted" icon="file">
                  <span title={f}>{fileName(f)}</span>
                  <button
                    type="button"
                    aria-label={`Retirer ${fileName(f)}`}
                    onClick={() => setFiles((all) => all.filter((x) => x !== f))}
                    className="flex text-tx3 hover:text-tx"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        <Field
          label="Ou collez le texte"
          htmlFor={ids.text}
          aside="cahier des charges, description de fonctionnalité, compte rendu…"
        >
          <Textarea
            id={ids.text}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Décrivez la fonctionnalité ou collez le document ici."
          />
        </Field>
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        <span className="text-caption text-tx3">
          {context
            ? "Une conversation s'ouvre avec ce document."
            : "Ajoutez un fichier ou un texte."}
        </span>
        <div className="grow" />
        <Button variant="ghost" onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="primary"
          icon="sparkle"
          disabled={busy || !context}
          onClick={() => void launch()}
        >
          Créer les issues
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
