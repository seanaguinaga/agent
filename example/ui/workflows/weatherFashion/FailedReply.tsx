import type { UIMessage } from "@convex-dev/agent/react";
import { useRetryTurn, useWorkflowStatus } from "./threadData";
import type { Turn } from "./turns";
import { Card, Markdown } from "./primitives";

export function FailedReply({
  turn,
  partial,
  isLatest,
}: {
  turn: Turn;
  /** Any partial answer worth keeping on screen. */
  partial?: UIMessage;
  isLatest: boolean;
}) {
  const workflow = useWorkflowStatus();
  // The workflow's failure belongs to whatever turn it stopped on.
  const workflowError = isLatest ? workflow.error : null;
  return (
    <Card>
      {partial?.text && <Markdown className="mb-3">{partial.text}</Markdown>}
      <p role="alert" className="text-gray-700">
        {partial?.text
          ? "This answer didn't finish."
          : "Couldn't finish this answer."}
      </p>
      <div className="mt-3 flex items-center gap-4">
        <RetryButton turn={turn} workflowFailed={!!workflowError} />
        {workflowError && <ErrorDetails error={workflowError} />}
      </div>
    </Card>
  );
}

function RetryButton({
  turn,
  workflowFailed,
}: {
  turn: Turn;
  workflowFailed: boolean;
}) {
  const { retry, retrying } = useRetryTurn(turn, workflowFailed);
  if (!retry) return null;
  return (
    <button
      className="px-3 py-1.5 rounded-lg border border-indigo-200 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
      onClick={retry}
      disabled={retrying}
    >
      Retry
    </button>
  );
}

function ErrorDetails({ error }: { error: string }) {
  return (
    <details className="text-sm text-gray-500">
      <summary className="cursor-pointer">Details</summary>
      <p className="mt-1">{error}</p>
    </details>
  );
}
