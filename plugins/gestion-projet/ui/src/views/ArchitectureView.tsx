/**
 * Architecture du projet, à deux niveaux : le système (services et liens, schéma dessiné
 * automatiquement en colonnes de l'entrée vers les données), puis l'intérieur d'un service
 * (couches, emplacements, couches autorisées, règles, conventions). Modèles prêts
 * (`architecture_templates`), édition par formulaires sur un brouillon local, « Enregistrer »
 * commite `architecture/` sur une branche `archi/…` avec une PR (`architecture_save`).
 * « Adapter le code » lance le skill `adapter-architecture` (audit, puis PR après accord).
 */
import { useEffect, useState, type ReactNode } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
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
import type {
  ArchiLayer,
  ArchiService,
  ArchiTemplate,
  Architecture,
  ArchitectureResponse,
  ArchitectureSource,
} from "../domain";
import {
  BOX_H,
  BOX_W,
  SKIP_DEPTH,
  archiId,
  entryLayers,
  kindMeta,
  kindOf,
  layoutSystem,
  lines,
  linkPath,
  removeLayer,
  removeService,
  serviceKinds,
} from "../archi";
import { EmptyCard, Loading, NoRepos, PageHeader, ToolError } from "../components";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

const notifyError = (e: unknown) =>
  cadence.notify(isCadenceError(e) ? e.message : String(e), "error");

const empty: Architecture = { version: 1, services: [], links: [], rules: [] };

type Dialogs =
  | { kind: "service"; service: ArchiService | null }
  | { kind: "link" }
  | { kind: "layer"; layer: ArchiLayer | null }
  | { kind: "save" }
  | null;

export function ArchitectureView() {
  const { repos, repo, ready, error } = useSelection();
  const [tick, setTick] = useState(0);
  const {
    data,
    error: loadError,
    loading,
  } = useTool<ArchitectureResponse>(
    "architecture_get",
    { repo },
    String(tick),
    ready && repo !== null,
  );
  const { data: lib } = useTool<{ templates: ArchiTemplate[] }>("architecture_templates", {});
  const templates = lib?.templates ?? [];
  const loaded = data?.repo === repo ? data : null;
  const [draft, setDraft] = useState<Architecture | null>(null);
  const [source, setSource] = useState<ArchitectureSource | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);

  // Nouveau chargement : le brouillon repart de l'architecture du dépôt.
  useEffect(() => {
    setDraft(loaded?.architecture ?? null);
    setSource(loaded?.source ?? null);
  }, [loaded]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded?.architecture ?? null);
  const service = draft?.services.find((s) => s.id === open) ?? null;
  const update = (next: Architecture) => setDraft(next);
  const updateService = (next: ArchiService) =>
    draft &&
    update({ ...draft, services: draft.services.map((s) => (s.id === next.id ? next : s)) });
  const adapt = (serviceId?: string) =>
    cadence
      .runAction("adapter-architecture", { repo, ...(serviceId ? { service: serviceId } : {}) })
      .catch(notifyError);

  let body: ReactNode;
  if (error) body = <ToolError message={error.message} />;
  else if (repos && repos.length === 0) body = <NoRepos />;
  else if (!repo)
    body = (
      <EmptyCard icon="folder" title="Choisissez un dépôt">
        L'architecture est propre à chaque dépôt : sélectionnez-en un dans le sélecteur de la barre
        du plugin.
      </EmptyCard>
    );
  else if (loadError) body = <ToolError message={loadError.message} />;
  else if (!loaded) body = loading ? <Loading label="Lecture de l'architecture…" /> : null;
  else if (!draft)
    body = (
      <Start
        templates={templates.filter((t) => t.scope === "system")}
        onPick={(t) => update({ version: 1, services: t.services, links: t.links, rules: t.rules })}
        onEmpty={() => update(empty)}
      />
    );
  else if (service)
    body = (
      <ServicePanel
        service={service}
        templates={templates.filter((t) => t.scope === "service")}
        onBack={() => setOpen(null)}
        onChange={updateService}
        onEdit={() => setDialog({ kind: "service", service })}
        onRemove={() => {
          update(removeService(draft, service.id));
          setOpen(null);
        }}
        onLayer={(layer) => setDialog({ kind: "layer", layer })}
        onAdapt={() => void adapt(service.id)}
      />
    );
  else
    body = (
      <SystemPanel
        architecture={draft}
        onOpen={setOpen}
        onChange={update}
        onAddService={() => setDialog({ kind: "service", service: null })}
        onAddLink={() => setDialog({ kind: "link" })}
      />
    );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="folder"
        title="Architecture"
        subtitle={
          source && (
            <span className="mono text-caption text-tx3">
              {repo} · {source.branch}
              {source.pull_request ? ` · PR #${source.pull_request} en cours` : ""}
            </span>
          )
        }
      >
        {source?.url && (
          <Button
            size="sm"
            variant="ghost"
            icon="pullRequest"
            onClick={() => void cadence.openExternal(source.url!)}
          >
            PR #{source.pull_request}
          </Button>
        )}
        {draft && (
          <Button
            size="sm"
            variant="ghost"
            icon="sparkle"
            disabled={dirty}
            title={dirty ? "Enregistrez d'abord vos modifications" : undefined}
            onClick={() => void adapt()}
          >
            Adapter le code
          </Button>
        )}
        {dirty && (
          <Button size="sm" variant="quiet" onClick={() => setDraft(loaded?.architecture ?? null)}>
            Annuler les modifications
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          icon="check"
          disabled={!dirty || !draft}
          onClick={() => setDialog({ kind: "save" })}
        >
          Enregistrer
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={() => setTick((t) => t + 1)}
          disabled={!repo}
        />
      </PageHeader>
      <main className="min-h-0 grow overflow-y-auto p-5">
        {dirty && (
          <Callout tone="info" className="mb-4">
            Modifications non enregistrées : « Enregistrer » les commite dans architecture/ sur une
            branche archi/… avec une pull request.
          </Callout>
        )}
        {body}
      </main>
      {dialog?.kind === "service" && draft && (
        <ServiceDialog
          service={dialog.service}
          taken={draft.services.map((s) => s.id)}
          onClose={() => setDialog(null)}
          onSave={(s) => {
            setDialog(null);
            if (dialog.service) updateService(s);
            else update({ ...draft, services: [...draft.services, s] });
          }}
        />
      )}
      {dialog?.kind === "link" && draft && (
        <LinkDialog
          architecture={draft}
          onClose={() => setDialog(null)}
          onSave={(l) => {
            setDialog(null);
            update({ ...draft, links: [...draft.links, l] });
          }}
        />
      )}
      {dialog?.kind === "layer" && service && (
        <LayerDialog
          service={service}
          layer={dialog.layer}
          onClose={() => setDialog(null)}
          onSave={(l) => {
            setDialog(null);
            updateService({
              ...service,
              layers: dialog.layer
                ? service.layers.map((x) => (x.id === l.id ? l : x))
                : [...service.layers, l],
            });
          }}
          onRemove={
            dialog.layer
              ? () => {
                  setDialog(null);
                  updateService(removeLayer(service, dialog.layer!.id));
                }
              : undefined
          }
        />
      )}
      {dialog?.kind === "save" && draft && repo && (
        <SaveDialog
          repo={repo}
          architecture={draft}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

/** Aucune architecture : partir d'un modèle de système, ou de zéro. */
function Start({
  templates,
  onPick,
  onEmpty,
}: {
  templates: ArchiTemplate[];
  onPick: (t: ArchiTemplate) => void;
  onEmpty: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <EmptyCard icon="folder" title="Pas encore d'architecture">
        Décrivez les services du projet (proxy, front, back, base…) puis l'intérieur de chacun
        (controller, service, DTO, repository…) : les IA de code s'y conforment, et « Adapter le
        code » aligne l'existant. Partez d'un modèle, ou de zéro.
      </EmptyCard>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {templates.map((t) => (
          <Card key={t.id} className="flex flex-col gap-2 p-[15px]">
            <div className="text-body font-semibold">{t.name}</div>
            <p className="text-body-sm leading-[1.5] text-tx2">{t.description}</p>
            <div className="flex flex-wrap gap-1">
              {t.services.map((s) => (
                <Badge key={s.id} tone={kindMeta[kindOf(s.kind)].tone}>
                  {s.name}
                </Badge>
              ))}
            </div>
            <Button
              size="xs"
              variant="secondary"
              className="mt-auto self-start"
              onClick={() => onPick(t)}
            >
              Partir de ce modèle
            </Button>
          </Card>
        ))}
        <Card className="flex flex-col justify-center gap-2 p-[15px]">
          <div className="text-body font-semibold">Architecture vide</div>
          <p className="text-body-sm text-tx2">Ajouter soi-même services et liens.</p>
          <Button size="xs" variant="ghost" className="self-start" onClick={onEmpty}>
            Commencer vide
          </Button>
        </Card>
      </div>
    </div>
  );
}

function RulesEditor({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => setText(value.join("\n")), [value]);
  return (
    <Card className="px-[15px] py-3.5">
      <CardHeader title={title} actions={<span className="text-caption text-tx3">{hint}</span>} />
      <Textarea
        className="mt-2 w-full"
        rows={Math.max(3, value.length + 1)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(lines(text))}
      />
    </Card>
  );
}

/** Niveau système : schéma des services et de leurs liens, règles du projet. */
function SystemPanel({
  architecture,
  onOpen,
  onChange,
  onAddService,
  onAddLink,
}: {
  architecture: Architecture;
  onOpen: (id: string) => void;
  onChange: (a: Architecture) => void;
  onAddService: () => void;
  onAddLink: () => void;
}) {
  const { boxes, width, height } = layoutSystem(architecture);
  const at = new Map(boxes.map((b) => [b.service.id, b]));
  const pad = 40;
  // Place sous les boîtes pour les liens qui sautent une colonne.
  const below = architecture.links.some((l) => {
    const a = at.get(l.from);
    const b = at.get(l.to);
    return a && b && linkPath(a, b).below;
  });
  const extra = below ? SKIP_DEPTH + 8 : 0;
  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-[15px] py-2.5">
          <h2 className="text-body font-semibold">Système</h2>
          <span className="text-caption text-tx3">
            {architecture.services.length} services · {architecture.links.length} liens · cliquez
            sur un service pour définir ses couches
          </span>
          <div className="grow" />
          <Button
            size="xs"
            variant="ghost"
            icon="link"
            disabled={architecture.services.length < 2}
            onClick={onAddLink}
          >
            Ajouter un lien
          </Button>
          <Button size="xs" variant="secondary" icon="plus" onClick={onAddService}>
            Ajouter un service
          </Button>
        </div>
        <div
          className="overflow-auto"
          style={{
            backgroundColor: "var(--color-bg)",
            backgroundImage: "radial-gradient(var(--color-line2) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          {architecture.services.length === 0 ? (
            <p className="p-8 text-center text-body-sm text-tx3">Aucun service pour l'instant.</p>
          ) : (
            <div
              className="relative mx-auto"
              style={{ width: width + 2 * pad, height: height + 2 * pad + extra }}
            >
              <svg
                className="pointer-events-none absolute inset-0 text-tx3"
                width={width + 2 * pad}
                height={height + 2 * pad + extra}
              >
                <defs>
                  <marker
                    id="fleche-archi"
                    markerWidth="7"
                    markerHeight="7"
                    refX="6"
                    refY="3.5"
                    orient="auto"
                  >
                    <path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" />
                  </marker>
                </defs>
                <g transform={`translate(${pad},${pad})`}>
                  {architecture.links.map((l, i) => {
                    const a = at.get(l.from);
                    const b = at.get(l.to);
                    if (!a || !b) return null;
                    const p = linkPath(a, b);
                    // Liens parallèles (REST et WebSocket entre les mêmes services) : étiquettes empilées.
                    const rank = architecture.links
                      .slice(0, i)
                      .filter((x) => x.from === l.from && x.to === l.to).length;
                    return (
                      <g key={i}>
                        <path
                          d={p.d}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          markerEnd="url(#fleche-archi)"
                        />
                        {l.label && (
                          <text
                            x={p.mx}
                            y={p.my - 6 - rank * 14}
                            textAnchor="middle"
                            className="fill-tx2 text-micro"
                          >
                            {l.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>
              {boxes.map((b) => {
                const meta = kindMeta[kindOf(b.service.kind)];
                return (
                  <button
                    key={b.service.id}
                    type="button"
                    onClick={() => onOpen(b.service.id)}
                    className="absolute flex flex-col gap-1 rounded-card border border-line2 bg-panel px-3 py-2.5 text-left shadow-lg hover:border-clay-line"
                    style={{ left: b.x + pad, top: b.y + pad, width: BOX_W, height: BOX_H }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 grow truncate text-body-sm font-semibold">
                        {b.service.name}
                      </span>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>
                    <span className="truncate text-caption text-tx2">{b.service.tech || "—"}</span>
                    <span className="mt-auto flex items-center gap-1.5 text-tiny text-tx3">
                      <span className="mono truncate">{b.service.path || "sans code"}</span>
                      <span className="grow" />
                      {b.service.layers.length > 0
                        ? `${b.service.layers.length} couches`
                        : "couches à définir"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>
      {architecture.links.length > 0 && (
        <Card className="px-[15px] py-3.5">
          <CardHeader title="Liens" />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {architecture.links.map((l, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-badge bg-p3 px-2 py-0.5 text-caption text-tx2"
              >
                {l.from} → {l.to}
                {l.label && <span className="text-tx3">· {l.label}</span>}
                <button
                  type="button"
                  aria-label={`Retirer le lien ${l.from} → ${l.to}`}
                  className="flex text-tx3 hover:text-tx"
                  onClick={() =>
                    onChange({
                      ...architecture,
                      links: architecture.links.filter((_, j) => j !== i),
                    })
                  }
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        </Card>
      )}
      <RulesEditor
        title="Règles du projet"
        hint="une par ligne"
        value={architecture.rules}
        onChange={(rules) => onChange({ ...architecture, rules })}
      />
    </div>
  );
}

/** Intérieur d'un service : couches (pile, dépendances autorisées), règles, conventions. */
function ServicePanel({
  service,
  templates,
  onBack,
  onChange,
  onEdit,
  onRemove,
  onLayer,
  onAdapt,
}: {
  service: ArchiService;
  templates: ArchiTemplate[];
  onBack: () => void;
  onChange: (s: ArchiService) => void;
  onEdit: () => void;
  onRemove: () => void;
  onLayer: (layer: ArchiLayer | null) => void;
  onAdapt: () => void;
}) {
  const meta = kindMeta[kindOf(service.kind)];
  const [pick, setPick] = useState("");
  const apply = () => {
    const t = templates.find((x) => x.id === pick);
    if (!t) return;
    onChange({
      ...service,
      tech: service.tech || t.tech,
      template: t.id,
      layers: t.layers,
      rules: t.rules,
      conventions: t.conventions,
    });
    setPick("");
  };
  const entries = entryLayers(service.layers);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon="arrowRight"
          className="[&_svg]:rotate-180"
          onClick={onBack}
        >
          Système
        </Button>
        <h2 className="font-display text-title-sm font-semibold">{service.name}</h2>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {service.tech && <span className="text-body-sm text-tx2">{service.tech}</span>}
        {service.path && <span className="mono text-caption text-tx3">{service.path}</span>}
        <div className="grow" />
        <Button size="xs" variant="ghost" icon="settings" onClick={onEdit}>
          Modifier
        </Button>
        <Button size="xs" variant="ghost" icon="sparkle" onClick={onAdapt}>
          Adapter ce service
        </Button>
        <Button size="xs" variant="quiet" icon="close" onClick={onRemove}>
          Supprimer
        </Button>
      </div>
      {service.description && <p className="text-body-sm text-tx2">{service.description}</p>}

      <Card className="flex flex-wrap items-center gap-2 px-[15px] py-2.5">
        <span className="text-caption text-tx3">Modèle</span>
        <Select
          size="sm"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          aria-label="Modèle de service"
        >
          <option value="">
            {service.template
              ? `Appliqué : ${templates.find((t) => t.id === service.template)?.name ?? service.template}`
              : "Choisir un modèle…"}
          </option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Button size="xs" variant="secondary" disabled={!pick} onClick={apply}>
          Appliquer
        </Button>
        {pick && (
          <span
            className="min-w-0 grow truncate text-caption text-tx3"
            title={templates.find((t) => t.id === pick)?.description}
          >
            Remplace couches, règles et conventions :{" "}
            {templates.find((t) => t.id === pick)?.description}
          </span>
        )}
      </Card>

      <Card className="px-[15px] py-3.5">
        <CardHeader
          title="Couches"
          actions={
            <Button size="xs" variant="secondary" icon="plus" onClick={() => onLayer(null)}>
              Ajouter une couche
            </Button>
          }
        />
        {service.layers.length === 0 ? (
          <p className="mt-3 text-body-sm text-tx3">
            Aucune couche : appliquez un modèle ou ajoutez-les (controller, service, DTO,
            repository…).
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {service.layers.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => onLayer(l)}
                className={cn(
                  "flex flex-wrap items-start gap-x-4 gap-y-1 rounded-card border bg-p2 px-3 py-2.5 text-left hover:border-clay-line",
                  entries.includes(l.id) ? "border-line2" : "border-line",
                )}
              >
                <div className="flex w-[200px] shrink-0 flex-col gap-0.5">
                  <span className="text-body-sm font-semibold">{l.name}</span>
                  <span className="mono truncate text-tiny text-tx3">
                    {l.path || "emplacement libre"}
                  </span>
                </div>
                <span className="min-w-[200px] flex-1 text-body-sm leading-[1.5] text-tx2">
                  {l.role}
                </span>
                <span className="flex flex-wrap items-center gap-1 text-caption text-tx3">
                  {l.uses.length === 0 ? (
                    <span>n'utilise aucune couche</span>
                  ) : (
                    <>
                      utilise
                      {l.uses.map((u) => (
                        <Badge key={u} tone="neutral">
                          → {service.layers.find((x) => x.id === u)?.name ?? u}
                        </Badge>
                      ))}
                    </>
                  )}
                </span>
              </button>
            ))}
            <p className="text-caption text-tx3">
              Une couche n'utilise que celles listées : toute autre dépendance est un écart que l'IA
              évite en codant et que « Adapter le code » corrige.
            </p>
          </div>
        )}
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <RulesEditor
          title="Règles"
          hint="une par ligne"
          value={service.rules}
          onChange={(rules) => onChange({ ...service, rules })}
        />
        <RulesEditor
          title="Conventions"
          hint="nommage, organisation"
          value={service.conventions}
          onChange={(conventions) => onChange({ ...service, conventions })}
        />
      </div>
    </div>
  );
}

function ServiceDialog({
  service,
  taken,
  onClose,
  onSave,
}: {
  service: ArchiService | null;
  taken: string[];
  onClose: () => void;
  onSave: (s: ArchiService) => void;
}) {
  const [name, setName] = useState(service?.name ?? "");
  const [kind, setKind] = useState(service?.kind ?? "backend");
  const [tech, setTech] = useState(service?.tech ?? "");
  const [path, setPath] = useState(service?.path ?? "");
  const [description, setDescription] = useState(service?.description ?? "");
  const submit = () =>
    onSave({
      id: service?.id ?? archiId(name, taken, "service"),
      name: name.trim(),
      kind,
      tech: tech.trim(),
      path: path.trim().replace(/^\/+|\/+$/g, ""),
      description: description.trim(),
      template: service?.template ?? null,
      layers: service?.layers ?? [],
      rules: service?.rules ?? [],
      conventions: service?.conventions ?? [],
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={560}>
      <DialogHeader title={service ? "Modifier le service" : "Nouveau service"} icon="folder" />
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <Field label="Nom" htmlFor="svc-nom">
            <Input
              id="svc-nom"
              size="md"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Nature" htmlFor="svc-nature">
            <Select id="svc-nature" value={kind} onChange={(e) => setKind(e.target.value)}>
              {serviceKinds.map((k) => (
                <option key={k} value={k}>
                  {kindMeta[k].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-3">
          <Field label="Technologie" htmlFor="svc-tech" hint="NestJS, React + Vite, PostgreSQL…">
            <Input id="svc-tech" size="md" value={tech} onChange={(e) => setTech(e.target.value)} />
          </Field>
          <Field label="Dossier" htmlFor="svc-dossier" hint="dans le dépôt, vide si pas de code">
            <Input
              id="svc-dossier"
              size="md"
              mono
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Rôle" htmlFor="svc-role">
          <Textarea
            id="svc-role"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="primary" size="md" disabled={!name.trim()} onClick={submit}>
          {service ? "Valider" : "Ajouter"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function LinkDialog({
  architecture,
  onClose,
  onSave,
}: {
  architecture: Architecture;
  onClose: () => void;
  onSave: (l: { from: string; to: string; label: string }) => void;
}) {
  const ids = architecture.services.map((s) => s.id);
  const [from, setFrom] = useState(ids[0] ?? "");
  const [to, setTo] = useState(ids[1] ?? "");
  const [label, setLabel] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={520}>
      <DialogHeader title="Nouveau lien" icon="link" />
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="De" htmlFor="lien-de">
            <Select id="lien-de" value={from} onChange={(e) => setFrom(e.target.value)}>
              {architecture.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <span className="pb-2 text-tx3">→</span>
          <Field label="Vers" htmlFor="lien-vers">
            <Select id="lien-vers" value={to} onChange={(e) => setTo(e.target.value)}>
              {architecture.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Nature" htmlFor="lien-nature" hint="REST /api, SQL, WebSocket, événements…">
          <Input
            id="lien-nature"
            size="md"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={!from || !to || from === to}
          onClick={() => onSave({ from, to, label: label.trim() })}
        >
          Ajouter
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function LayerDialog({
  service,
  layer,
  onClose,
  onSave,
  onRemove,
}: {
  service: ArchiService;
  layer: ArchiLayer | null;
  onClose: () => void;
  onSave: (l: ArchiLayer) => void;
  onRemove?: () => void;
}) {
  const [name, setName] = useState(layer?.name ?? "");
  const [path, setPath] = useState(layer?.path ?? "");
  const [role, setRole] = useState(layer?.role ?? "");
  const [uses, setUses] = useState<string[]>(layer?.uses ?? []);
  const others = service.layers.filter((l) => l.id !== layer?.id);
  const submit = () =>
    onSave({
      id:
        layer?.id ??
        archiId(
          name,
          service.layers.map((l) => l.id),
          "couche",
        ),
      name: name.trim(),
      path: path.trim(),
      role: role.trim(),
      uses,
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={580}>
      <DialogHeader
        title={layer ? `Couche « ${layer.name} »` : "Nouvelle couche"}
        meta={service.name}
        icon="layers"
      />
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <Field label="Nom" htmlFor="couche-nom" hint="Controller, Service, DTO…">
            <Input
              id="couche-nom"
              size="md"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Emplacement" htmlFor="couche-chemin" hint="src/**/controllers/">
            <Input
              id="couche-chemin"
              size="md"
              mono
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Rôle" htmlFor="couche-role">
          <Textarea
            id="couche-role"
            rows={2}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </Field>
        {others.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-small font-medium text-tx2">Peut utiliser</span>
            <div className="flex flex-wrap gap-1.5">
              {others.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() =>
                    setUses((u) => (u.includes(l.id) ? u.filter((x) => x !== l.id) : [...u, l.id]))
                  }
                  className={cn(
                    "rounded-badge border px-2 py-0.5 text-caption",
                    uses.includes(l.id)
                      ? "border-clay-line bg-clay-d text-clay"
                      : "border-line text-tx3 hover:text-tx2",
                  )}
                >
                  {l.name}
                </button>
              ))}
            </div>
            <span className="text-caption text-tx3">
              Les couches non cochées lui sont interdites.
            </span>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {onRemove && (
          <Button variant="quiet" size="md" onClick={onRemove}>
            Supprimer la couche
          </Button>
        )}
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="primary" size="md" disabled={!name.trim()} onClick={submit}>
          {layer ? "Valider" : "Ajouter"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function SaveDialog({
  repo,
  architecture,
  onClose,
  onSaved,
}: {
  repo: string;
  architecture: Architecture;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await cadence.call("architecture_save", { repo, architecture, message: message.trim() });
      onSaved();
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={520}>
      <DialogHeader title="Enregistrer l'architecture" icon="check" />
      <DialogBody className="flex flex-col gap-3">
        <Field
          label="Résumé de la modification"
          htmlFor="archi-message"
          hint="message de commit et titre de PR"
        >
          <Input
            id="archi-message"
            size="md"
            placeholder="ajout du worker d'exports"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            autoFocus
          />
        </Field>
        <p className="text-caption leading-[1.6] text-tx3">
          architecture/architecture.json et ARCHITECTURE.md sont commités sur une branche archi/… et
          une pull request est ouverte (ou complétée si une est déjà en cours).
        </p>
        {error && <Callout tone="danger">{error}</Callout>}
      </DialogBody>
      <DialogFooter>
        <div className="grow" />
        <Button variant="ghost" size="md" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="primary" size="md" disabled={busy} onClick={() => void save()}>
          {busy ? "Enregistrement…" : "Enregistrer"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
