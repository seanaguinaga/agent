// Data for one workflow thread. Components below <ThreadProvider> read and
// write through these hooks instead of passing `threadId` around.
import {
  optimisticallySendMessage,
  useUIMessages,
} from "@convex-dev/agent/react";
import { useMutation, useQuery } from "convex/react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "../../../convex/_generated/api";
import { groupTurns, type Turn } from "./turns";

const ThreadContext = createContext<string | null>(null);

export function ThreadProvider({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  return <ThreadContext value={threadId}>{children}</ThreadContext>;
}

export function useThreadId() {
  const threadId = useContext(ThreadContext);
  if (!threadId) throw new Error("useThreadId must be inside <ThreadProvider>");
  return threadId;
}

/** The thread's messages, paired into question/answer turns. */
export function useTurns() {
  const threadId = useThreadId();
  // The shared streaming query from chat/streaming.ts.
  const { results, status, loadMore } = useUIMessages(
    api.chat.streaming.listThreadMessages,
    { threadId },
    { initialNumItems: 20, stream: true },
  );
  return { turns: groupTurns(results), status, loadMore };
}

/**
 * Convex shares one subscription between identical queries, so any
 * component can call this without a second round trip.
 */
export function useWorkflowStatus() {
  const threadId = useThreadId();
  const workflow = useQuery(api.workflows.weatherFashion.workflowStatus, {
    threadId,
  });
  return {
    // Still loading counts as running, so a retry never flashes an error.
    running: workflow === undefined || workflow?.type === "inProgress",
    error: workflow?.type === "failed" ? workflow.error : null,
  };
}

/** Whether this turn's follow-up is waiting for a free workpool slot. */
export function useFollowUpQueued(turn: Turn, enabled: boolean) {
  const threadId = useThreadId();
  return !!useQuery(
    api.workflows.weatherFashion.followUpQueued,
    enabled && turn.prompt
      ? { threadId, promptMessageId: turn.prompt.id }
      : "skip",
  );
}

export function useAskFollowUp() {
  const threadId = useThreadId();
  const askFollowUp = useMutation(
    api.workflows.weatherFashion.askFollowUp,
  ).withOptimisticUpdate(
    optimisticallySendMessage(api.chat.streaming.listThreadMessages),
  );
  return (prompt: string) => askFollowUp({ threadId, prompt });
}

export function useAbortStream() {
  const threadId = useThreadId();
  const abortStreamByOrder = useMutation(
    api.chat.streamAbort.abortStreamByOrder,
  );
  return (order: number) => abortStreamByOrder({ threadId, order });
}

/**
 * Retries a failed turn: the whole workflow if that's what failed,
 * otherwise the turn's follow-up. `retry` is undefined when neither applies.
 */
export function useRetryTurn(turn: Turn, workflowFailed: boolean) {
  const threadId = useThreadId();
  const retryWorkflow = useMutation(api.workflows.weatherFashion.retryWorkflow);
  const retryFollowUp = useMutation(api.workflows.weatherFashion.retryFollowUp);
  const [retrying, setRetrying] = useState(false);
  const promptMessageId = turn.prompt?.id;
  const request = workflowFailed
    ? () => retryWorkflow({ threadId })
    : promptMessageId
      ? () => retryFollowUp({ threadId, promptMessageId })
      : undefined;
  const retry =
    request &&
    (() => {
      setRetrying(true);
      request()
        .catch(console.error)
        .finally(() => setRetrying(false));
    });
  return { retry, retrying };
}
