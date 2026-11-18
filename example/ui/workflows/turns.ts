import type { UIMessage } from "@convex-dev/agent/react";
import { outfitSchema, type Outfit } from "../../convex/workflows/outfit";

/** One question and everything the agents did to answer it. */
export type Turn = {
  order: number;
  prompt?: UIMessage;
  /** Replies to show: every successful one, plus the latest even if it failed. */
  replies: UIMessage[];
  /** Failed attempts before the current reply. */
  earlierFailures: number;
};

/** Groups a prompt and its replies by their shared order. */
export function groupTurns(messages: UIMessage[]): Turn[] {
  const byOrder = new Map<number, { prompt?: UIMessage; all: UIMessage[] }>();
  for (const message of messages) {
    const turn = byOrder.get(message.order) ?? { all: [] };
    byOrder.set(message.order, turn);
    if (message.role === "user") turn.prompt ??= message;
    else if (message.role === "assistant") turn.all.push(message);
  }
  return [...byOrder.entries()]
    .sort(([a], [b]) => a - b)
    .map(([order, { prompt, all }]) => {
      const last = all.length - 1;
      const failures = all
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "data-failedAttempt").length;
      const latestFailed = all[last]?.status === "failed";
      return {
        order,
        prompt,
        replies: all.filter((m, i) => i === last || m.status !== "failed"),
        earlierFailures: Math.max(0, failures - Number(latestFailed)),
      };
    });
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
