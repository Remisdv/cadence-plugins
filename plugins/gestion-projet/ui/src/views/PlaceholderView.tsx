/** Vues pas encore écrites (TODO) : sprint, roadmap, versions, pull requests. */
import { Callout, Icon } from "@cadence/ui";
import type { ViewMeta } from "../domain";

const todo: Record<string, string> = {
  sprint: "Tableau du sprint en cours (kanban par état), burndown et retard. Outil serveur : sprint_summary (TODO).",
  roadmap: "Paliers de la roadmap et leurs thèmes, avec le bouton « Proposer des issues ».",
  versions: "Versions (milestones) : avancement, clôture et bouton « Préparer la release ».",
  "pull-requests": "Pull requests ouvertes, checks et revues. Outils serveur : list_pull_requests, get_pull_request (TODO).",
};

export function PlaceholderView({ id, meta }: { id: string; meta: ViewMeta }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name={meta.icon} size={17} className="text-clay" />
        <h1 className="font-display text-title">{meta.title}</h1>
      </header>
      <main className="p-5">
        <Callout tone="info" icon="clock">
          Écran à venir. {todo[id] ?? ""}
        </Callout>
      </main>
    </div>
  );
}
