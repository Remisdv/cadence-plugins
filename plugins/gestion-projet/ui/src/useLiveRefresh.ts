import { useEffect, useRef } from "react";
import { cadence, type RunStatus } from "@cadence/plugin-sdk";

/** Événement du serveur après une écriture sur un dépôt (`{ repo, tool }`). */
export const SYNC_EVENT = "sync.updated";

/** Intervalle du rafraîchissement de secours tant qu'une conversation du sprint tourne. */
export const POLL_MS = 20_000;

/** Retour sur la vue (focus, onglet visible) : pas de relecture si la dernière a moins de 15 s. */
const FOCUS_GAP_MS = 15_000;

/** L'événement `sync.updated` concerne-t-il l'un des dépôts affichés ? (casse ignorée) */
export function isSyncFor(data: unknown, repos: readonly string[]): boolean {
  const repo = (data as { repo?: unknown } | null)?.repo;
  return typeof repo === "string" && repos.some((r) => r.toLowerCase() === repo.toLowerCase());
}

/** Fin d'une exécution de fond (`onRun`). */
export function isFinished(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/**
 * Garde un écran à jour de GitHub sans « Rafraîchir » (N09) : `refresh` est appelé (regroupé sur
 * 600 ms) quand le serveur annonce une écriture sur un des dépôts (`sync.updated`, y compris celles
 * de l'IA), quand une conversation du plugin change d'état sans tourner (fin de tour, attente
 * d'accord, échec), au retour sur la vue (si la dernière relecture date de plus de 15 s), et toutes
 * les 20 s tant que `polling` est vrai (une conversation du sprint en cours : filet si un événement
 * se perd).
 */
export function useLiveRefresh(repos: readonly string[], refresh: () => void, polling = false) {
  // Dernières valeurs, sans réabonner à chaque rendu.
  const latest = useRef({ repos, refresh, at: Date.now() });
  latest.current = { ...latest.current, repos, refresh };
  const run = () => {
    latest.current.at = Date.now();
    latest.current.refresh();
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => runRef.current(), 600);
    };
    const offSync = cadence.on(SYNC_EVENT, (data) => {
      if (isSyncFor(data, latest.current.repos)) soon();
    });
    const offConversations = cadence.conversations.onChange((change) => {
      if (change.state !== "running") soon();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - latest.current.at > FOCUS_GAP_MS)
        soon();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearTimeout(timer);
      offSync();
      offConversations();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => runRef.current(), POLL_MS);
    return () => clearInterval(id);
  }, [polling]);
}

/** Suit une exécution lancée par `runAction` et appelle `onDone` à sa fin (succès ou non). */
export function refreshWhenDone(runId: string, onDone: () => void): void {
  const off = cadence.onRun(runId, (update) => {
    if (!isFinished(update.status)) return;
    // L'abonnement peut rejouer tout de suite la dernière mise à jour : on se désabonne ensuite.
    queueMicrotask(() => off());
    onDone();
  });
}
