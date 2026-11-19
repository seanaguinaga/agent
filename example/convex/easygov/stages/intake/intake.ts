// The intake stage: chats with the person, one agent turn per message, until
// the goal is clear. Top to bottom: the agent, the events a person can send,
// the workflow, then the queries and the mutation the workflow calls.
import { Agent } from "@convex-dev/agent";
import { ConvexError, v } from "convex/values";
import { z } from "zod/v4";
import { components, internal } from "../../../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../../../_generated/server";
import { defaultConfig } from "../../../agents/config";
import { defineStage, waitFor, type StageEvents } from "../../stage";
import type { StageResult } from "../../validators";

const MAX_TURNS = 12;

export const intakeParams = z.strictObject({});

// --- The agent --------------------------------------------------------------

export const intakeAgent = new Agent(components.agent, {
  name: "Intake",
  instructions:
    "You help people say what government task they need done. " +
    "Reply briefly and ask at most one question. " +
    "Once you know the task, set `goal` to one plain sentence describing it; " +
    "until then, set `goal` to null.",
  ...defaultConfig,
});

const turnSchema = z.object({
  reply: z.string().describe("What to say to the person."),
  goal: z.string().nullable().describe("The task, once it's clear."),
});

/**
 * Answers one user message. Saves nothing: the stage's next mutation decides
 * what to keep, so a retried turn can't leave a duplicate reply.
 */
export const turn = internalAction({
  args: { caseId: v.id("cases"), promptMessageId: v.string() },
  returns: v.object({ reply: v.string(), goal: v.union(v.string(), v.null()) }),
  handler: async (
    ctx,
    { caseId, promptMessageId },
  ): Promise<{ reply: string; goal: string | null }> => {
    const { threadId }: { threadId: string } = await ctx.runQuery(
      internal.easygov.stages.intake.intake.threadOf,
      { caseId },
    );
    const { object } = await intakeAgent.generateObject(
      ctx,
      { threadId },
      { promptMessageId, schema: turnSchema },
      { storageOptions: { saveMessages: "none" } },
    );
    return object;
  },
});

// --- What a person can send -------------------------------------------------

export const intakeEvents = {
  // Lets the person (or a test) state the goal without chatting.
  "intake.submit": (_found, { goal }) => {
    const text = goal.trim();
    if (!text) throw new ConvexError("Say what you want to get done.");
    // A new goal needs a new route.
    return { intake: { goal: text }, route: undefined };
  },
} satisfies StageEvents;

// --- The workflow -----------------------------------------------------------

export const run = defineStage(
  async (step, { caseId }): Promise<StageResult> => {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const next = await waitFor(step, () =>
        step.runQuery(internal.easygov.stages.intake.intake.next, { caseId }),
      );
      if (next.kind === "done") return { outcome: "done" };
      const { promptMessageId } = next;
      const { reply, goal } = await step.runAction(
        internal.easygov.stages.intake.intake.turn,
        { caseId, promptMessageId },
        { retry: true },
      );
      await step.runMutation(internal.easygov.stages.intake.intake.record, {
        caseId,
        promptMessageId,
        reply,
        goal,
      });
      if (goal?.trim()) return { outcome: "done" };
    }
    return {
      outcome: "stop",
      reason: `Intake didn't find a goal in ${MAX_TURNS} turns`,
    };
  },
);

// --- What the workflow reads and writes -------------------------------------

/** What intake does next: finish, answer a message, or keep waiting (null). */
export const next = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.union(
    v.object({ kind: v.literal("done") }),
    v.object({ kind: v.literal("message"), promptMessageId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    if (found?.intake?.goal) return { kind: "done" as const };
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
    const found = await ctx.db.get("cases", caseId);
    if (!found) throw new Error("Case not found");
    return { threadId: found.threadId };
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
    const goalText = goal?.trim();
    await ctx.db.patch("cases", caseId, {
      // A newer message stays pending for the next turn.
      ...(found.pendingMessageId === promptMessageId
        ? { pendingMessageId: undefined }
        : {}),
      ...(goalText ? { intake: { goal: goalText }, route: undefined } : {}),
    });
    return null;
  },
});
