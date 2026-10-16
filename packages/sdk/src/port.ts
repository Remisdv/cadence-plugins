/** Canal de transport des messages : `postMessage` en production, mémoire en test. */
export interface Port {
  post(message: unknown): void;
  /** Abonne un gestionnaire ; renvoie la fonction de désabonnement. */
  listen(handler: (message: unknown) => void): () => void;
}

/**
 * Canal vers la fenêtre parente (Cadence). L'iframe est isolée (origine opaque) : on poste avec
 * `"*"` mais on n'accepte que les messages venant de la fenêtre cible.
 */
export function windowPort(target: Window = window.parent, self: Window = window): Port {
  return {
    post(message) {
      target.postMessage(message, "*");
    },
    listen(handler) {
      const onMessage = (event: MessageEvent) => {
        if (event.source === target) handler(event.data);
      };
      self.addEventListener("message", onMessage);
      return () => self.removeEventListener("message", onMessage);
    },
  };
}

const clone: <T>(value: T) => T =
  typeof structuredClone === "function"
    ? (value) => structuredClone(value)
    : (value) => JSON.parse(JSON.stringify(value));

/**
 * Paire de ports reliés en mémoire, avec livraison asynchrone et copie des messages comme
 * `postMessage` : sert aux tests et à l'hôte simulé de développement.
 */
export function memoryChannel(): [Port, Port] {
  const handlers: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
  const make = (mine: 0 | 1): Port => ({
    post(message) {
      const copy = clone(message);
      const other = handlers[mine === 0 ? 1 : 0];
      queueMicrotask(() => other.forEach((h) => h(copy)));
    },
    listen(handler) {
      handlers[mine].add(handler);
      return () => {
        handlers[mine].delete(handler);
      };
    },
  });
  return [make(0), make(1)];
}
