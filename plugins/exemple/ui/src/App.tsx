/**
 * Routeur de l'écran. Cadence charge `ui/index.html` une fois et indique la vue à afficher : à la
 * poignée de main (`cadence.ready()`), puis à chaque changement (`cadence.onRoute`), quand
 * l'utilisateur choisit une entrée de la barre du plugin ou quand l'écran appelle `navigate`.
 */
import { useEffect, useState } from "react";
import { cadence, isCadenceError, type Route } from "@cadence/plugin-sdk";
import { Callout, Spinner } from "@cadence/ui";
import { VIEWS } from "./domain";
import { AccueilView } from "./views/AccueilView";
import { SetupPrenomView } from "./views/SetupPrenomView";

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
    case VIEWS.accueil:
      return <AccueilView />;
    case VIEWS.prenom:
      return <SetupPrenomView />;
    default:
      return (
        <div className="p-6">
          <Callout tone="warning">Vue inconnue : « {route.view} ».</Callout>
        </div>
      );
  }
}
