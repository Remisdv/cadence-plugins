import { useEffect, useState } from "react";
import { cadence, isCadenceError, type Route } from "@cadence/plugin-sdk";
import { Callout, Spinner } from "@cadence/ui";
import { isViewId, views } from "./domain";
import { IssuesView } from "./views/IssuesView";
import { PlaceholderView } from "./views/PlaceholderView";
import { SetupReposView } from "./views/SetupReposView";

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
  if (id === "issues") return <IssuesView />;
  if (id === "setup-depots") return <SetupReposView />;
  if (id === "sprint" || id === "roadmap" || id === "versions" || id === "pull-requests") {
    return <PlaceholderView id={id} meta={views[id]} />;
  }
  return (
    <div className="p-6">
      <Callout tone="warning">
        Vue inconnue : « {id} »{isViewId(id) ? "" : " (absente du plugin)"}.
      </Callout>
    </div>
  );
}
