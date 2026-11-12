import { useEffect, useState } from "react";
import { cadence, CadenceError, type RepoInfo, type RepoSelection } from "@cadence/plugin-sdk";

export interface ReposState {
  /** Dépôts suivis (le dépôt actif et les récents) ; `null` tant que Cadence n'a pas répondu. */
  repos: RepoInfo[] | null;
  /**
   * Dépôt actif du sélecteur de la barre du plugin. Gestion de projet travaille dans un seul
   * dépôt à la fois (issues, catégories, roadmap… y sont enregistrées) : `all` ne reste que
   * quand aucun dépôt n'est suivi.
   */
  selection: RepoSelection | null;
  error: CadenceError | null;
}

/** Un seul dépôt actif : « Tous les dépôts » (anciennes versions de Cadence) devient le premier. */
export function activeSelection(repos: RepoInfo[], selection: RepoSelection): RepoSelection {
  if (selection.kind === "one" && repos.some((r) => r.fullName === selection.repo)) return selection;
  return repos[0] ? { kind: "one", repo: repos[0].fullName } : { kind: "all" };
}

/** Dépôts suivis et dépôt actif du service `repos`, à jour des changements. */
export function useRepos(): ReposState {
  const [state, setState] = useState<ReposState>({ repos: null, selection: null, error: null });

  useEffect(() => {
    let alive = true;
    const off = cadence.repos.onChange(({ repos, selection }) =>
      setState({ repos, selection: activeSelection(repos, selection), error: null }),
    );
    Promise.all([cadence.repos.list(), cadence.repos.selection()])
      .then(
        ([repos, selection]) =>
          alive && setState({ repos, selection: activeSelection(repos, selection), error: null }),
      )
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

export interface Selection extends ReposState {
  /** Dépôt actif ; `null` tant qu'aucun dépôt n'est choisi. */
  repo: string | null;
  /** Dépôts à afficher : le dépôt actif seul (vide sans dépôt). */
  shown: string[];
  /** Sélection connue et au moins un dépôt suivi : les outils peuvent être appelés. */
  ready: boolean;
}

/** Sélection courante prête à l'emploi pour une vue. */
export function useSelection(): Selection {
  const state = useRepos();
  const repo = state.selection?.kind === "one" ? state.selection.repo : null;
  const ready = state.selection !== null && repo !== null;
  return { ...state, repo, shown: ready && repo ? [repo] : [], ready };
}
