import { useEffect, useState } from "react";
import { cadence, isCadenceError, type Route } from "@cadence/plugin-sdk";
import { Callout, Spinner } from "@cadence/ui";
import { isViewId } from "./domain";
import { DesignsView } from "./views/DesignsView";
import { IssuesView } from "./views/IssuesView";
import { PlanningView } from "./views/PlanningView";
import { PullRequestsView } from "./views/PullRequestsView";
import { RoadmapView } from "./views/RoadmapView";
import { SetupReposView } from "./views/SetupReposView";
import { SprintView } from "./views/SprintView";
import { VersionsView } from "./views/VersionsView";

/** Route affichée : fournie par Cadence à la poignée de main, puis suivie (barre du plugin). */
export function App() {
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cadence
      .ready()
      .then((hello) => setRoute(hello.route))
      .catch((e: unknown) => setError(isCadenceError(e) ? e.message : String(e)));
    return cadence.onRoute(setRoute);
  }, []);

  if (error) {
    return (
      <div className="p-6">
        <Callout tone="danger">{error}</Callout>
      </div>
    );
  }
  if (!route) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }

  const id = route.view;
  switch (id) {
    case "sprint":
      return <SprintView />;
    case "issues":
      return <IssuesView />;
    case "roadmap":
      return <RoadmapView />;
    case "versions":
      return <VersionsView params={route.params ?? {}} />;
    case "planning":
      return <PlanningView />;
    case "designs":
      return <DesignsView />;
    case "pull-requests":
      return <PullRequestsView />;
    case "setup-depots":
      return <SetupReposView />;
  }
  return (
    <div className="p-6">
      <Callout tone="warning">
        Vue inconnue : « {id} »{isViewId(id) ? "" : " (absente du plugin)"}.
      </Callout>
    </div>
  );
}
