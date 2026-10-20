import { useEffect, useState } from "react";
import { cadence, isCadenceError, type Route } from "@cadence/plugin-sdk";
import { Callout, Spinner } from "@cadence/ui";
import { DocumentView } from "./views/DocumentView";
import { LibraryView } from "./views/LibraryView";
import { SetupFolderView } from "./views/SetupFolderView";
import { TrainingView } from "./views/TrainingView";

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
  switch (route.view) {
    case "bibliotheque":
      return <LibraryView />;
    case "entrainement":
      return <TrainingView params={route.params} />;
    case "document":
      return <DocumentView params={route.params} />;
    case "setup-dossier":
      return <SetupFolderView />;
    default:
      return (
        <div className="p-6">
          <Callout tone="warning">Vue inconnue : « {route.view} ».</Callout>
        </div>
      );
  }
}
