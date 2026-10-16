/**
 * Vue « Entraînement » (minimale) : liste des QCM, séries de questions ouvertes et paquets de
 * flashcards enregistrés. TODO : passer un QCM, retourner les cartes, historique des scores.
 */
import { Badge, Callout, Card, Icon, Spinner } from "@cadence/ui";
import { quizMeta, type QuizSummary } from "../domain";
import { useTool } from "../useTool";

export function TrainingView() {
  const { data, error, loading } = useTool<{ quizzes: QuizSummary[] }>("list_quizzes");
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="sparkle" size={17} className="text-clay" />
        <h1 className="font-display text-title">Entraînement</h1>
      </header>
      <main className="flex min-h-0 grow flex-col gap-4 overflow-y-auto p-5">
        <Callout tone="info" icon="clock">
          Lancez « Générer un QCM », « Questions ouvertes » ou « Flashcards » depuis un chapitre de la
          bibliothèque. Les exercices interactifs arrivent dans une prochaine version.
        </Callout>
        {loading && !data && <Spinner />}
        {error && <Callout tone="danger">{error.message}</Callout>}
        {data && data.quizzes.length > 0 && (
          <Card className="divide-y divide-line">
            {data.quizzes.map((q) => (
              <div key={q.id} className="flex min-h-[42px] items-center gap-3 px-3.5 py-2">
                <Badge tone="clay">{quizMeta[q.kind].label}</Badge>
                <span className="grow truncate text-body">{q.title}</span>
                <span className="text-caption text-tx3">{q.items} élément(s)</span>
                {q.last_result?.score != null && (
                  <Badge mono tone="green">
                    {q.last_result.score}/{q.last_result.total ?? "?"}
                  </Badge>
                )}
              </div>
            ))}
          </Card>
        )}
      </main>
    </div>
  );
}
