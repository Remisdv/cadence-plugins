/**
 * Sauvegarde automatique avec anti-rebond : chaque modification repousse l'enregistrement de
 * `delay` ms ; un seul enregistrement à la fois, la dernière valeur gagne. Sans DOM ni React,
 * pour être testée avec de faux minuteurs.
 */

export type SaveStatus = "saved" | "pending" | "saving" | "error";

export interface AutosaveState {
  status: SaveStatus;
  /** Message de la dernière erreur d'enregistrement. */
  error: string | null;
  /** Date (ms) du dernier enregistrement réussi. */
  savedAt: number | null;
}

export interface Autosaver<T> {
  /** Nouvelle valeur à enregistrer après le délai. */
  change(value: T): void;
  /** Enregistre tout de suite la valeur en attente (sortie de l'éditeur, Ctrl+S). */
  flush(): Promise<void>;
  /** Abandonne la valeur en attente (note rechargée depuis le serveur). */
  cancel(): void;
  readonly state: AutosaveState;
  subscribe(listener: (state: AutosaveState) => void): () => void;
  dispose(): void;
}

export function createAutosaver<T>(
  save: (value: T) => Promise<void>,
  { delay = 800, now = () => Date.now() }: { delay?: number; now?: () => number } = {},
): Autosaver<T> {
  let state: AutosaveState = { status: "saved", error: null, savedAt: null };
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  const listeners = new Set<(s: AutosaveState) => void>();

  const set = (next: Partial<AutosaveState>) => {
    state = { ...state, ...next };
    for (const l of listeners) l(state);
  };
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const run = async (): Promise<void> => {
    clear();
    if (running) {
      // Un enregistrement est en cours : la valeur en attente partira juste après.
      await running;
      return pending ? run() : undefined;
    }
    if (!pending) return;
    const { value } = pending;
    pending = null;
    set({ status: "saving" });
    running = save(value)
      .then(() => set({ status: pending ? "pending" : "saved", error: null, savedAt: now() }))
      .catch((e: unknown) => {
        // Valeur gardée pour un nouvel essai (prochaine frappe ou flush).
        pending ??= { value };
        set({ status: "error", error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        running = null;
      });
    await running;
    if (pending && state.status !== "error") return run();
  };

  return {
    change(value) {
      pending = { value };
      if (state.status !== "saving") set({ status: "pending" });
      clear();
      timer = setTimeout(() => void run(), delay);
    },
    flush: run,
    cancel() {
      clear();
      pending = null;
      if (state.status === "pending" || state.status === "error") set({ status: "saved", error: null });
    },
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      clear();
      listeners.clear();
    },
  };
}

/** Libellé de l'indicateur de sauvegarde. */
export function saveLabel(state: AutosaveState): string {
  switch (state.status) {
    case "pending":
      return "Modifications non enregistrées";
    case "saving":
      return "Enregistrement…";
    case "error":
      return "Échec de l'enregistrement";
    case "saved":
      return state.savedAt ? "Enregistré" : "À jour";
  }
}
