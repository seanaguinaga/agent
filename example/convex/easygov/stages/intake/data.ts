// What the intake workflow reads and writes.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../../../_generated/server";
import { markAnswered, writeCase, type Case } from "../../case/data";
import { intakeAgent } from "./agent";

/**
 * A newly stated goal. The version goes up even when the words are the same,
 * so a process pack selected (or rejected) for the goal before it is out of
 * date without intake touching it.
 */
export function newGoal(found: Case, goal: string): Case["intake"] {
  return { goal, version: (found.intake?.version ?? 0) + 1 };
}

/** The goal, unless the selection made for it was rejected. */
function standingGoal(found: Case): string | undefined {
  const { intake, processPack } = found;
  const rejected =
    processPack?.status === "rejected" &&
    processPack.goalVersion === intake?.version;
  return rejected ? undefined : intake?.goal;
}

/** What intake does next: finish, answer a message, or keep waiting (null). */
export const check = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(
    v.object({ kind: v.literal("done") }),
    v.object({ kind: v.literal("message"), promptMessageId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (found && standingGoal(found)) return { kind: "done" as const };
    if (found?.pendingMessageId) {
      return {
        kind: "message" as const,
        promptMessageId: found.pendingMessageId,
      };
    }
    return null;
  },
});

export const threadOf = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.object({ threadId: v.string() }),
  handler: async (ctx, { caseId }) => {
    const caseDoc = await ctx.db.get("cases", caseId);
    if (!caseDoc) throw new Error("Case not found");
    return { threadId: caseDoc.threadId };
  },
});

/** Keeps the agent's turn: posts its reply, and records the goal if it found one. */
export const record = internalMutation({
  args: {
    caseId: v.id("cases"),
    promptMessageId: v.string(),
    reply: v.string(),
    goal: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, promptMessageId, reply, goal }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return null;
    await intakeAgent.saveMessage(ctx, {
      threadId: found.threadId,
      promptMessageId,
      message: { role: "assistant", content: reply },
      skipEmbeddings: true,
    });
    await markAnswered(ctx, found, promptMessageId);
    const goalText = goal?.trim();
    if (goalText) {
      await writeCase(ctx, "intake", caseId, {
        intake: newGoal(found, goalText),
      });
    }
    return null;
  },
});
