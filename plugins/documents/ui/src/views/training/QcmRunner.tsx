/** Passer un QCM : une question à la fois, puis correction par le serveur (`submit_qcm`). */
import { useEffect, useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card, Icon, Kbd, ProgressBar, RadioCard, RadioCardGroup, cn } from "@cadence/ui";
import {
  formatScore,
  percentOf,
  qcmItems,
  SCORE_BAR,
  scoreTone,
  sourceLabel,
  type QcmCorrection,
  type Quiz,
  type QuizResult,
} from "../../domain";

interface Props {
  quiz: Quiz;
  titles: Record<string, string>;
  onClose: () => void;
}

export function QcmRunner({ quiz, titles, onClose }: Props) {
  const items = qcmItems(quiz.items);
  const [answers, setAnswers] = useState<(number | null)[]>(() => items.map(() => null));
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graded, setGraded] = useState<{ result: QuizResult; corrections: QcmCorrection[] } | null>(null);

  const item = items[index];
  const answered = answers.filter((a) => a !== null).length;
  const last = index === items.length - 1;

  const choose = (choice: number) => setAnswers((a) => a.map((v, i) => (i === index ? choice : v)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setGraded(await cadence.call("submit_qcm", { quiz: quiz.id, answers }));
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setAnswers(items.map(() => null));
    setIndex(0);
    setGraded(null);
  };

  // Clavier : 1 à 9 pour répondre, flèches pour changer de question.
  useEffect(() => {
    if (graded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const n = Number(e.key);
      if (item && Number.isInteger(n) && n >= 1 && n <= item.choices.length) choose(n - 1);
      else if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, items.length - 1));
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (items.length === 0) {
    return <Callout tone="warning">Ce QCM ne contient aucune question lisible.</Callout>;
  }
  if (graded) {
    return <QcmCorrectionView graded={graded} titles={titles} onRestart={restart} onClose={onClose} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="mono text-caption text-tx3">
          Question {index + 1} / {items.length}
        </span>
        <ProgressBar className="grow" value={(answered / items.length) * 100} label="Questions répondues" />
        <span className="text-caption text-tx3">{answered} répondue(s)</span>
      </div>

      {item && (
        <Card className="flex flex-col gap-4 p-[18px]">
          <h2 className="text-title-sm leading-[1.5]">{item.question}</h2>
          <RadioCardGroup
            aria-label="Choix"
            value={answers[index] == null ? "" : String(answers[index])}
            onValueChange={(v) => choose(Number(v))}
          >
            {item.choices.map((choice, i) => (
              <RadioCard key={i} value={String(i)} title={choice} leading={<Kbd boxed>{i + 1}</Kbd>} />
            ))}
          </RadioCardGroup>
        </Card>
      )}

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="flex items-center gap-2">
        <Button variant="ghost" icon="close" onClick={onClose}>
          Abandonner
        </Button>
        <div className="grow" />
        {answered < items.length && last && (
          <span className="text-caption text-tx3">{items.length - answered} question(s) sans réponse</span>
        )}
        <Button variant="secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          Précédente
        </Button>
        {last ? (
          <Button variant="primary" icon="check" disabled={busy} onClick={() => void submit()}>
            {busy ? "Correction…" : "Corriger"}
          </Button>
        ) : (
          <Button variant="primary" iconRight="arrowRight" onClick={() => setIndex(index + 1)}>
            Suivante
          </Button>
        )}
      </div>
    </div>
  );
}

function QcmCorrectionView({
  graded,
  titles,
  onRestart,
  onClose,
}: {
  graded: { result: QuizResult; corrections: QcmCorrection[] };
  titles: Record<string, string>;
  onRestart: () => void;
  onClose: () => void;
}) {
  const { result, corrections } = graded;
  const percent = percentOf(result.score, result.total);
  const tone = scoreTone(percent);
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex items-center gap-4 p-[18px]">
        <div className="flex flex-col">
          <span className="font-display text-kpi">{formatScore(result.score, result.total)}</span>
          <span className="text-caption text-tx3">{percent ?? 0} % de bonnes réponses</span>
        </div>
        <div className="flex grow flex-col gap-2">
          <ProgressBar value={percent ?? 0} tone={SCORE_BAR[tone]} height={5} label="Score" />
          {result.feedback && <p className="text-body-sm text-tx2">{result.feedback}</p>}
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        {corrections.map((c, i) => (
          <Card key={i} className="flex gap-3 p-3.5">
            <span className={cn("mt-0.5 flex", c.correct ? "text-green" : "text-red")}>
              <Icon name={c.correct ? "check" : "close"} size={16} />
            </span>
            <div className="flex min-w-0 grow flex-col gap-1.5">
              <div className="text-body font-medium">
                {i + 1}. {c.question}
              </div>
              {!c.correct && (
                <div className="text-body-sm text-tx2">
                  Votre réponse :{" "}
                  <span className="text-red">{c.chosen == null ? "aucune" : c.choices[c.chosen]}</span>
                </div>
              )}
              <div className="text-body-sm text-tx2">
                Bonne réponse : <span className="text-green">{c.choices[c.answer]}</span>
              </div>
              {c.explanation && <p className="text-body-sm leading-[1.6] text-tx3">{c.explanation}</p>}
              {c.source && (
                <div>
                  <Badge icon="file" mono>
                    {sourceLabel(c.source, titles)}
                  </Badge>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Retour aux entraînements
        </Button>
        <Button variant="secondary" icon="refresh" onClick={onRestart}>
          Recommencer
        </Button>
      </div>
    </div>
  );
}
