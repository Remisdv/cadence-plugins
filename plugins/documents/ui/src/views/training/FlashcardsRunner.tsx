/**
 * Réviser un paquet de flashcards : retourner chaque carte, la noter « Je savais » ou « À revoir »,
 * puis revoir les cartes manquées. Un tour complet du paquet est enregistré (`save_result`).
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card, Icon, Kbd, ProgressBar } from "@cadence/ui";
import {
  deckDone,
  deckMissed,
  deckReducer,
  flashcardItems,
  formatScore,
  percentOf,
  SCORE_BAR,
  scoreTone,
  shuffled,
  sourceLabel,
  startDeck,
  type Quiz,
} from "../../domain";

interface Props {
  quiz: Quiz;
  titles: Record<string, string>;
  onClose: () => void;
}

export function FlashcardsRunner({ quiz, titles, onClose }: Props) {
  const cards = flashcardItems(quiz.items);
  const all = () => cards.map((_, i) => i);
  const [deck, dispatch] = useReducer(deckReducer, null, () => startDeck(all()));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Le tour en cours couvre-t-il tout le paquet ? (seul un tour complet est enregistré)
  const fullPass = deck.order.length === cards.length;
  const savingRef = useRef(false);

  const done = deckDone(deck);
  const card = cards[deck.order[deck.position] ?? -1];
  const missed = deckMissed(deck);
  const known = deck.order.length - missed.length;

  useEffect(() => {
    if (!done || !fullPass || saved || savingRef.current || cards.length === 0) return;
    savingRef.current = true;
    const answers = deck.order.map((i) => ({ card: i, known: deck.marks[i] === true }));
    cadence
      .call("save_result", {
        quiz: quiz.id,
        score: known,
        total: cards.length,
        answers,
        feedback: `${known}/${cards.length} carte(s) sue(s).`,
      })
      .then(() => setSaved(true))
      .catch((e: unknown) => setError(isCadenceError(e) ? e.message : String(e)))
      .finally(() => {
        savingRef.current = false;
      });
  }, [done, fullPass, saved, deck, known, cards.length, quiz.id]);

  const restart = (order: number[]) => {
    setSaved(false);
    setError(null);
    dispatch({ type: "restart", order });
  };

  // Clavier : espace pour retourner, 1 « À revoir », 2 « Je savais ».
  useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        dispatch({ type: "flip" });
      } else if (deck.flipped && e.key === "1") dispatch({ type: "mark", known: false });
      else if (deck.flipped && e.key === "2") dispatch({ type: "mark", known: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done, deck.flipped]);

  if (cards.length === 0) {
    return <Callout tone="warning">Ce paquet ne contient aucune carte lisible.</Callout>;
  }

  if (done) {
    const percent = percentOf(known, deck.order.length);
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex items-center gap-4 p-[18px]">
          <div className="flex flex-col">
            <span className="font-display text-kpi">{formatScore(known, deck.order.length)}</span>
            <span className="text-caption text-tx3">carte(s) sue(s) {fullPass ? "" : "· tour de rattrapage"}</span>
          </div>
          <div className="flex grow flex-col gap-2">
            <ProgressBar value={percent ?? 0} tone={SCORE_BAR[scoreTone(percent)]} height={5} label="Cartes sues" />
            <span className="text-caption text-tx3">
              {fullPass ? (saved ? "Score enregistré dans l'historique." : "Enregistrement…") : "Les tours de rattrapage ne sont pas notés."}
            </span>
          </div>
        </Card>
        {error && <Callout tone="danger">{error}</Callout>}
        {missed.length > 0 && (
          <Card className="divide-y divide-line">
            {missed.map((i) => (
              <div key={i} className="flex items-center gap-3 px-3.5 py-2">
                <Icon name="clock" size={14} className="text-amber" />
                <span className="grow text-body">{cards[i]!.front}</span>
                <span className="text-body-sm text-tx3">{cards[i]!.back}</span>
              </div>
            ))}
          </Card>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Retour aux entraînements
          </Button>
          <Button variant="secondary" icon="refresh" onClick={() => restart(shuffled(cards.length))}>
            Tout revoir (mélangé)
          </Button>
          {missed.length > 0 && (
            <Button variant="primary" icon="play" onClick={() => restart(missed)}>
              Revoir les {missed.length} carte(s) manquée(s)
            </Button>
          )}
        </div>
      </div>
    );
  }

  const source = sourceLabel(card?.source, titles);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="mono text-caption text-tx3">
          Carte {deck.position + 1} / {deck.order.length}
        </span>
        <ProgressBar className="grow" value={(deck.position / deck.order.length) * 100} label="Cartes vues" />
        <Button size="xs" variant="ghost" icon="refresh" onClick={() => restart(shuffled(cards.length))}>
          Mélanger
        </Button>
      </div>

      {card && (
        <button
          type="button"
          onClick={() => dispatch({ type: "flip" })}
          aria-label={deck.flipped ? "Voir le recto" : "Retourner la carte"}
          className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-card border border-line bg-panel p-8 text-center hover:border-line2"
        >
          <span className="text-micro font-semibold tracking-[0.09em] text-tx3 uppercase">
            {deck.flipped ? "Verso" : "Recto"}
          </span>
          <span className={deck.flipped ? "text-body-lg leading-[1.6] text-tx" : "font-display text-title"}>
            {deck.flipped ? card.back : card.front}
          </span>
          {deck.flipped && source && (
            <Badge icon="file" mono>
              {source}
            </Badge>
          )}
        </button>
      )}

      <div className="flex items-center gap-2">
        <Button variant="ghost" icon="close" onClick={onClose}>
          Arrêter
        </Button>
        <div className="grow" />
        {deck.flipped ? (
          <>
            <Button variant="danger" onClick={() => dispatch({ type: "mark", known: false })}>
              À revoir <Kbd>1</Kbd>
            </Button>
            <Button variant="success" icon="check" onClick={() => dispatch({ type: "mark", known: true })}>
              Je savais <Kbd>2</Kbd>
            </Button>
          </>
        ) : (
          <Button variant="primary" icon="refresh" onClick={() => dispatch({ type: "flip" })}>
            Retourner <Kbd className="text-clay-ink">espace</Kbd>
          </Button>
        )}
      </div>
    </div>
  );
}
