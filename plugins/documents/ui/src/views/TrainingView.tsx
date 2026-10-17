/**
 * Vue « Entraînement » : QCM, séries de questions ouvertes et paquets de flashcards enregistrés
 * par les skills, à passer ici (QCM corrigé par le serveur, cartes à retourner) ; historique des
 * scores. Les listes se rafraîchissent sur les événements du serveur (`quiz-saved`,
 * `result-saved`). Paramètre de route `quiz` : ouvre directement un entraînement.
 */
import { useEffect, useState } from "react";
import { cadence } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card, Icon, ProgressBar, SectionLabel, Spinner, cn } from "@cadence/ui";
import {
  formatDate,
  formatScore,
  percentOf,
  quizMeta,
  SCORE_BAR,
  scoreTone,
  type DocumentInfo,
  type HistoryEntry,
  type Quiz,
  type QuizKind,
  type QuizSummary,
} from "../domain";
import { useTool, type ToolState } from "../useTool";
import { FlashcardsRunner } from "./training/FlashcardsRunner";
import { OpenQuestionsPanel } from "./training/OpenQuestionsPanel";
import { QcmRunner } from "./training/QcmRunner";

const KINDS: (QuizKind | "tous")[] = ["tous", "qcm", "questions_ouvertes", "flashcards"];

export function TrainingView({ params }: { params: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(params.quiz ?? null);
  const [kind, setKind] = useState<QuizKind | "tous">("tous");
  const quizzes = useTool<{ quizzes: QuizSummary[] }>("list_quizzes");
  const history = useTool<{ results: HistoryEntry[] }>("list_results", { limit: 30 });
  const docs = useTool<{ documents: DocumentInfo[] }>("list_documents");
  const titles = Object.fromEntries((docs.data?.documents ?? []).map((d) => [d.id, d.title]));

  useEffect(() => setOpen(params.quiz ?? null), [params.quiz]);

  // Événements du serveur : QCM ou paquet généré en fond, score enregistré (ici ou dans le chat).
  const { reload: reloadQuizzes } = quizzes;
  const { reload: reloadHistory } = history;
  useEffect(() => {
    const offQuiz = cadence.on("quiz-saved", reloadQuizzes);
    const offResult = cadence.on("result-saved", () => {
      reloadQuizzes();
      reloadHistory();
    });
    return () => {
      offQuiz();
      offResult();
    };
  }, [reloadQuizzes, reloadHistory]);

  const close = () => {
    setOpen(null);
    reloadQuizzes();
    reloadHistory();
  };

  const visible = (quizzes.data?.quizzes ?? []).filter((q) => kind === "tous" || q.kind === kind);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="sparkle" size={17} className="text-clay" />
        <h1 className="font-display text-title">Entraînement</h1>
        <span className="text-caption text-tx3">
          {quizzes.data ? `${quizzes.data.quizzes.length} entraînement(s)` : ""}
        </span>
        <div className="grow" />
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          iconOnly
          aria-label="Rafraîchir"
          onClick={() => {
            reloadQuizzes();
            reloadHistory();
          }}
        />
      </header>

      <main className="flex min-h-0 grow flex-col gap-5 overflow-y-auto p-5">
        {open ? (
          <QuizSession id={open} titles={titles} onClose={close} />
        ) : (
          <>
            {quizzes.data && quizzes.data.quizzes.length === 0 && (
              <Card className="flex flex-col items-center gap-3 p-8 text-center">
                <Icon name="sparkle" size={19} className="text-tx3" />
                <p className="max-w-[460px] text-body-sm text-tx2">
                  Aucun entraînement pour l'instant. Depuis un chapitre de la bibliothèque, lancez « Générer un
                  QCM », « Flashcards » ou « Questions ouvertes » : ils apparaîtront ici.
                </p>
                <Button variant="secondary" icon="book" onClick={() => void cadence.navigate("bibliotheque")}>
                  Ouvrir la bibliothèque
                </Button>
              </Card>
            )}
            {quizzes.loading && !quizzes.data && (
              <div className="flex items-center gap-2 text-body-sm text-tx3">
                <Spinner /> Chargement…
              </div>
            )}
            {quizzes.error && <Callout tone="danger">{quizzes.error.message}</Callout>}

            {quizzes.data && quizzes.data.quizzes.length > 0 && (
              <section className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {KINDS.map((k) => (
                    <Button
                      key={k}
                      size="xs"
                      variant={kind === k ? "secondary" : "quiet"}
                      aria-pressed={kind === k}
                      onClick={() => setKind(k)}
                    >
                      {k === "tous" ? "Tous" : quizMeta[k].label}
                    </Button>
                  ))}
                </div>
                <Card className="divide-y divide-line">
                  {visible.map((q) => (
                    <QuizRow key={q.id} quiz={q} onOpen={() => setOpen(q.id)} />
                  ))}
                  {visible.length === 0 && (
                    <div className="px-3.5 py-3 text-body-sm text-tx3">Aucun entraînement de ce type.</div>
                  )}
                </Card>
              </section>
            )}

            <History state={history} />
          </>
        )}
      </main>
    </div>
  );
}

function QuizRow({ quiz, onOpen }: { quiz: QuizSummary; onOpen: () => void }) {
  const meta = quizMeta[quiz.kind];
  const last = quiz.last_result;
  const percent = last ? percentOf(last.score, last.total) : null;
  return (
    <div className="flex min-h-[48px] items-center gap-3 px-3.5 py-2">
      <Badge tone={meta.tone}>{meta.label}</Badge>
      <div className="min-w-0 grow">
        <div className="truncate text-body">{quiz.title}</div>
        <div className="truncate text-caption text-tx3">
          {[quiz.subject, quiz.chapter].filter(Boolean).join(" · ") || "Sans chapitre"} · {quiz.items}{" "}
          {quiz.kind === "flashcards" ? "carte(s)" : "question(s)"}
        </div>
      </div>
      {last?.score != null && (
        <Badge mono tone={scoreTone(percent)} title={`Dernier score, ${formatDate(last.at)}`}>
          {formatScore(last.score, last.total)}
        </Badge>
      )}
      <Button size="sm" variant={quiz.kind === "questions_ouvertes" ? "ghost" : "secondary"} onClick={onOpen}>
        {meta.start}
      </Button>
    </div>
  );
}

/** Charge l'entraînement et ouvre l'exercice correspondant à son type. */
function QuizSession({ id, titles, onClose }: { id: string; titles: Record<string, string>; onClose: () => void }) {
  const { data, error, loading } = useTool<{ quiz: Quiz }>("get_quiz", { id });
  if (loading && !data) return <Spinner />;
  if (error || !data) {
    return (
      <div className="flex flex-col gap-3">
        <Callout tone="danger">{error?.message ?? "Entraînement introuvable."}</Callout>
        <div>
          <Button variant="ghost" onClick={onClose}>
            Retour aux entraînements
          </Button>
        </div>
      </div>
    );
  }
  const quiz = data.quiz;
  const meta = quizMeta[quiz.kind];
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <h2 className="min-w-0 grow truncate font-display text-title">{quiz.title}</h2>
        <span className="text-caption text-tx3">{[quiz.subject, quiz.chapter].filter(Boolean).join(" · ")}</span>
      </div>
      {quiz.kind === "qcm" && <QcmRunner key={quiz.id} quiz={quiz} titles={titles} onClose={onClose} />}
      {quiz.kind === "flashcards" && <FlashcardsRunner key={quiz.id} quiz={quiz} titles={titles} onClose={onClose} />}
      {quiz.kind === "questions_ouvertes" && <OpenQuestionsPanel quiz={quiz} titles={titles} onClose={onClose} />}
    </div>
  );
}

function History({ state }: { state: ToolState<{ results: HistoryEntry[] }> }) {
  const results = state.data?.results ?? [];
  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Historique des scores</SectionLabel>
      {state.error && <Callout tone="danger">{state.error.message}</Callout>}
      {state.data && results.length === 0 && (
        <p className="text-body-sm text-tx3">
          Les scores de vos QCM, flashcards et questions ouvertes s'afficheront ici.
        </p>
      )}
      {results.length > 0 && (
        <Card className="divide-y divide-line">
          {results.map((r) => {
            const tone = scoreTone(r.percent);
            return (
              <div key={r.id} className="flex min-h-[42px] items-center gap-3 px-3.5 py-2">
                <span className="mono w-[150px] shrink-0 text-caption text-tx3">{formatDate(r.created_at)}</span>
                {r.kind && <Badge tone={quizMeta[r.kind].tone}>{quizMeta[r.kind].label}</Badge>}
                <span className={cn("min-w-0 grow truncate text-body", !r.title && "text-tx3")}>
                  {r.title ?? "Entraînement supprimé"}
                </span>
                <ProgressBar
                  className="w-[90px] shrink-0"
                  value={r.percent ?? 0}
                  tone={SCORE_BAR[tone]}
                  label={`Score de ${r.title ?? r.quiz}`}
                />
                <Badge mono tone={tone}>
                  {formatScore(r.score, r.total)}
                </Badge>
              </div>
            );
          })}
        </Card>
      )}
    </section>
  );
}
