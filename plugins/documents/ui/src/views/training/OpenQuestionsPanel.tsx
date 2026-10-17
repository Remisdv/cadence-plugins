/**
 * Série de questions ouvertes : la correction est faite par l'IA dans le chat (skill
 * `questions-ouvertes`), qui enregistre ensuite le score. L'écran montre les questions sans le
 * barème et lance la séance.
 */
import { useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card } from "@cadence/ui";
import { openQuestionItems, quizMeta, sourceLabel, type Quiz } from "../../domain";

interface Props {
  quiz: Quiz;
  titles: Record<string, string>;
  onClose: () => void;
}

export function OpenQuestionsPanel({ quiz, titles, onClose }: Props) {
  const questions = openQuestionItems(quiz.items);
  const [error, setError] = useState<string | null>(null);
  const total = questions.reduce((sum, q) => sum + (q.points ?? 0), 0);

  const start = async () => {
    setError(null);
    try {
      await cadence.runAction(quizMeta.questions_ouvertes.action, {
        subject: quiz.subject,
        chapter: quiz.chapter,
        quiz: quiz.id,
      });
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="info" icon="sparkle">
        L'IA vous pose ces questions une par une dans le chat, corrige chaque réponse en citant le cours
        (document et page) puis enregistre votre score dans l'historique.
      </Callout>
      <Card className="divide-y divide-line">
        {questions.map((q, i) => (
          <div key={i} className="flex items-start gap-3 px-3.5 py-2.5">
            <span className="mono w-5 shrink-0 text-caption text-tx3">{i + 1}.</span>
            <span className="grow text-body leading-[1.55]">{q.question}</span>
            {q.source && (
              <Badge icon="file" mono>
                {sourceLabel(q.source, titles)}
              </Badge>
            )}
            {q.points != null && <Badge mono>{q.points} pt</Badge>}
          </div>
        ))}
      </Card>
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="flex items-center justify-end gap-2">
        {total > 0 && <span className="mr-auto text-caption text-tx3">Barème : {total} points</span>}
        <Button variant="ghost" onClick={onClose}>
          Retour aux entraînements
        </Button>
        <Button variant="primary" icon="sparkle" disabled={questions.length === 0} onClick={() => void start()}>
          Répondre dans le chat
        </Button>
      </div>
    </div>
  );
}
