import { PromptForm } from "./PromptForm";
import { ThreadProvider, useAskFollowUp, useTurns } from "./threadData";
import { hasOutfit } from "./turns";
import { TurnView } from "./Turn";
import { PendingTurn, Typing } from "./primitives";

export function WorkflowThread({
  threadId,
  pendingQuestion,
}: {
  threadId: string;
  /** Shown while the thread loads, so the question doesn't blink away. */
  pendingQuestion?: string;
}) {
  return (
    <ThreadProvider threadId={threadId}>
      <Turns pendingQuestion={pendingQuestion} />
    </ThreadProvider>
  );
}

function Turns({ pendingQuestion }: { pendingQuestion?: string }) {
  const { turns, status, loadMore } = useTurns();
  if (status === "LoadingFirstPage") {
    return pendingQuestion ? (
      <PendingTurn question={pendingQuestion} />
    ) : (
      <Typing label="Loading conversation…" />
    );
  }
  return (
    <section className="flex flex-col gap-6" aria-label="Workflow">
      {status === "CanLoadMore" && (
        <button
          className="self-center text-sm text-indigo-700"
          onClick={() => loadMore(20)}
        >
          Load earlier messages
        </button>
      )}
      {turns.map((turn, i) => (
        <TurnView
          key={turn.order}
          turn={turn}
          isLatest={i === turns.length - 1}
        />
      ))}
      {turns.some(hasOutfit) && <FollowUpForm />}
    </section>
  );
}

function FollowUpForm() {
  const askFollowUp = useAskFollowUp();
  return (
    <PromptForm
      id="followup"
      label="Follow-up question"
      placeholder="Ask the fashion agent a follow-up…"
      submitLabel="Send"
      onSubmit={askFollowUp}
    />
  );
}
