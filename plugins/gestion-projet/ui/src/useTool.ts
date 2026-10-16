import { useCallback, useEffect, useState } from "react";
import { cadence, CadenceError } from "@cadence/plugin-sdk";

export interface ToolState<T> {
  data: T | null;
  error: CadenceError | null;
  loading: boolean;
  reload: () => void;
}

/** Appelle un outil du serveur du plugin et garde son résultat (rechargé quand `key` change). */
export function useTool<T>(tool: string, args: Record<string, unknown> = {}, key = ""): ToolState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<CadenceError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const serialized = JSON.stringify(args);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    cadence
      .call<T>(tool, JSON.parse(serialized))
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof CadenceError ? e : new CadenceError("internal", String(e)));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tool, serialized, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
