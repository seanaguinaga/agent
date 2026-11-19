// The intake agent: answers one chat message, and says the goal once it's
// clear.
import { Agent } from "@convex-dev/agent";
import { v } from "convex/values";
import { z } from "zod/v4";
import { components, internal } from "../../../_generated/api";
import { internalAction } from "../../../_generated/server";
import { defaultConfig } from "../../../agents/config";

export const intakeAgent = new Agent(components.agent, {
  name: "Intake",
  instructions:
    "You help people say what legal or government task they need done. " +
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
      internal.easygov.stages.intake.data.threadOf,
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
