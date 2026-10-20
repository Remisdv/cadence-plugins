import { useCallback, useEffect, useState } from "react";
import { cadence, CadenceError, type ConversationInfo } from "@cadence/plugin-sdk";

export interface ConversationsState {
  /** Conversations du groupe, plus récentes d'abord ; `null` avant la première réponse. */
  conversations: ConversationInfo[] | null;
  error: CadenceError | null;
  reload: () => void;
}

/**
 * Conversations d'un groupe (`conversations.list({ group })`), relues à chaque événement
 * `conversations` de Cadence (création, changement d'état) et quand `key` change. `group` nul :
 * rien n'est lu.
 */
export function useConversations(group: string | null, key = ""): ConversationsState {
  const [conversations, setConversations] = useState<ConversationInfo[] | null>(null);
  const [error, setError] = useState<CadenceError | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Autre groupe (autre sprint) : la liste précédente n'est plus la bonne.
  useEffect(() => setConversations(null), [group]);

  useEffect(() => {
    if (!group) return;
    let alive = true;
    cadence.conversations
      .list({ group })
      .then((list) => {
        if (!alive) return;
        setConversations(list);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof CadenceError ? e : new CadenceError("internal", String(e)));
      });
    return () => {
      alive = false;
    };
  }, [group, tick, key]);

  useEffect(() => {
    if (!group) return;
    // Tout événement relit la liste (une conversation peut entrer dans le groupe) ; plusieurs
    // changements d'affilée (création puis « en cours ») ne font qu'une relecture.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = cadence.conversations.onChange(() => {
      clearTimeout(timer);
      timer = setTimeout(reload, 150);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [group, reload]);

  return { conversations: group ? conversations : [], error, reload };
}
