import { useCallback, useEffect, useState } from "react";
import { cadence, CadenceError } from "@cadence/plugin-sdk";
import { mergeTaxonomies, type CategoryList, type DomainView } from "./categories";

export interface CategoriesState {
  /** Taxonomie des dépôts affichés (réunie en mode « Tous les dépôts ») ; `null` au chargement. */
  domains: DomainView[] | null;
  /** Réponse de `list_categories` par dépôt (personnalisation à modifier). */
  byRepo: Record<string, CategoryList>;
  error: CadenceError | null;
  reload: () => void;
}

/** Catégories des dépôts `repos` (`list_categories`), relues quand la liste ou `key` change. */
export function useCategories(repos: readonly string[], enabled = true): CategoriesState {
  const [byRepo, setByRepo] = useState<Record<string, CategoryList>>({});
  const [error, setError] = useState<CadenceError | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = repos.join(",");

  useEffect(() => {
    if (!enabled || !key) return;
    let alive = true;
    Promise.all(
      key.split(",").map((repo) => cadence.call<CategoryList>("list_categories", { repo })),
    )
      .then((lists) => {
        if (!alive) return;
        setByRepo(Object.fromEntries(lists.map((l) => [l.repo, l])));
        setError(null);
        setLoaded(key);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof CadenceError ? e : new CadenceError("internal", String(e)));
        setLoaded(key);
      });
    return () => {
      alive = false;
    };
  }, [key, tick, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const lists = key
    .split(",")
    .map((r) => byRepo[r]?.domains)
    .filter((d): d is DomainView[] => !!d);
  const domains = loaded === key && lists.length ? mergeTaxonomies(lists) : null;
  return { domains, byRepo, error, reload };
}
