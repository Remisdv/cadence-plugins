import { useEffect, useState } from "react";
import { cadence, CadenceError, type RepoInfo, type RepoSelection } from "@cadence/plugin-sdk";

export interface ReposState {
  /** Dépôts suivis ; `null` tant que Cadence n'a pas répondu. */
  repos: RepoInfo[] | null;
  /** Sélecteur de la barre du plugin : un dépôt ou « Tous les dépôts ». */
  selection: RepoSelection | null;
  error: CadenceError | null;
}

/** Dépôts suivis et sélection courante du service `repos`, à jour des changements. */
export function useRepos(): ReposState {
  const [state, setState] = useState<ReposState>({ repos: null, selection: null, error: null });

  useEffect(() => {
    let alive = true;
    const off = cadence.repos.onChange(({ repos, selection }) => setState({ repos, selection, error: null }));
    Promise.all([cadence.repos.list(), cadence.repos.selection()])
      .then(([repos, selection]) => alive && setState({ repos, selection, error: null }))
      .catch((e: unknown) => {
        if (!alive) return;
        const error = e instanceof CadenceError ? e : new CadenceError("internal", String(e));
        setState((s) => ({ ...s, error }));
      });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return state;
}
