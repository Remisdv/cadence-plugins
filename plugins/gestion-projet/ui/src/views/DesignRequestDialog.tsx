/**
 * « Créer un design » : on écrit d'abord la demande (écrans, parcours, états) et on choisit, au
 * besoin, le design du projet à modifier ; l'action `creer-design` part ensuite avec ce contexte
 * (`{ type: "demande-design", repo, request, design? }`). Sans demande, rien n'est lancé.
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
  Select,
  Spinner,
  Textarea,
} from "@cadence/ui";
import { designRequestContext, type Design } from "../domain";

export function DesignRequestDialog({
  repo,
  designs,
  onClose,
}: {
  repo: string;
  /** Designs du projet, proposés comme point de départ à modifier. */
  designs: Design[];
  onClose: () => void;
}) {
  const ids = { request: useId(), design: useId() };
  const [request, setRequest] = useState("");
  const [design, setDesign] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const context = designRequestContext(repo, request, design || null);

  const launch = async () => {
    if (!context) return;
    setBusy(true);
    setError(null);
    try {
      await cadence.runAction("creer-design", context);
      onClose();
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={600}>
      <DialogHeader title="Créer un design" icon="layers" meta={repo} />
      <DialogBody className="flex max-h-[calc(100vh-200px)] flex-col gap-4 overflow-y-auto">
        <p className="text-body-sm leading-[1.6] text-tx2">
          L'IA dessine les écrans dans Claude Design en reprenant le style du projet, vous les
          validez, puis elle les range dans le dépôt (dossier design/, branche et PR).
        </p>
        <Field label="Ce qu'il faut dessiner" htmlFor={ids.request} required>
          <Textarea
            id={ids.request}
            rows={5}
            autoFocus
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={
              "Écrans, parcours, états (vide, chargement, erreur), plateforme :\nex. l'écran de connexion par lien magique, sur mobile"
            }
          />
        </Field>
        {designs.length > 0 && (
          <Field label="Point de départ" htmlFor={ids.design}>
            <Select id={ids.design} value={design} onChange={(e) => setDesign(e.target.value)}>
              <option value="">Nouveau design</option>
              {designs.map((d) => (
                <option key={d.id} value={d.id}>
                  Modifier « {d.name} »
                </option>
              ))}
            </Select>
          </Field>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        <div className="grow" />
        <Button type="button" variant="ghost" onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="primary"
          icon={busy ? undefined : "sparkle"}
          disabled={busy || !context}
          onClick={() => void launch()}
        >
          {busy && <Spinner />}
          Lancer l'IA
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
