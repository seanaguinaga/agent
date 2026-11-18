import type { UIMessage } from "@convex-dev/agent/react";
import { outfitSchema, type Outfit } from "../../../convex/workflows/outfit";

/** One question and its answer. */
export type Turn = {
  order: number;
  prompt?: UIMessage;
  reply?: UIMessage;
};

/**
 * Pairs each prompt with its reply by their shared `order`.
 *
 * `useUIMessages` already merges a turn's assistant messages (retries
 * included) into one. If several still arrive, the latest is the reply.
 */
export function groupTurns(messages: UIMessage[]): Turn[] {
  const byOrder = new Map<number, Turn>();
  for (const message of messages) {
    const turn = byOrder.get(message.order) ?? { order: message.order };
    byOrder.set(message.order, turn);
    if (message.role === "user") turn.prompt ??= message;
    else if (message.role === "assistant") turn.reply = message;
  }
  return [...byOrder.values()].sort((a, b) => a.order - b.order);
}

/** What to show for a turn's answer, the way chat apps do it. */
export type ReplyView =
  /** Nothing yet, or a failed attempt the workflow will retry: keep quiet. */
  | { kind: "working" }
  /** An answer, in progress or done. */
  | { kind: "answer"; message: UIMessage }
  /** Gave up. `message` holds any partial answer worth keeping on screen. */
  | { kind: "failed"; message?: UIMessage };

export function replyView(
  turn: Turn,
  { isLatest, workflowRunning }: { isLatest: boolean; workflowRunning: boolean },
): ReplyView {
  const { reply } = turn;
  if (!reply) return isLatest ? { kind: "working" } : { kind: "failed" };
  if (reply.status !== "failed") return { kind: "answer", message: reply };
  // A failed attempt isn't final while the workflow can still retry it.
  if (isLatest && workflowRunning) return { kind: "working" };
  return { kind: "failed", message: reply.text ? reply : undefined };
}

/** The fashion step's structured outfit, if this text is one. */
export function parseOutfit(text: string): Outfit | undefined {
  try {
    const result = outfitSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether this turn ended with an outfit, which opens up follow-ups. */
export function hasOutfit(turn: Turn): boolean {
  return turn.reply?.status === "success" && !!parseOutfit(turn.reply.text);
}
