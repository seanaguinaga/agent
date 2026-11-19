// The route stage: asks the route agent for a process, then waits for the
// person to confirm it. Top to bottom: the agent, the events a person can
// send, the workflow, then the queries and the mutation the workflow calls.
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
import { getPack, listPacks } from "../../packs";
import { defineStage, waitFor, type StageEvents } from "../../stage";
import { vStageResult, type StageResult } from "../../validators";

/** `backTo`: the step to return to when the person rejects the proposal. */
export const routeParams = z.strictObject({ backTo: z.string() });

// --- The agent --------------------------------------------------------------

export const routeAgent = new Agent(components.agent, {
  name: "Route",
  instructions:
    "You match a person's goal to one of the processes listed. " +
    "Pick the best fit, or 'none' if nothing fits. " +
    "Write one short sentence to the person naming the process, " +
    "or saying it isn't supported yet.",
  ...defaultConfig,
});

/**
 * Proposes a process for the case's goal. The person still has to confirm
 * it; this only suggests one.
 */
export const propose = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.object({ processKey: v.string(), message: v.string() }),
  handler: async (
    ctx,
    { caseId },
  ): Promise<{ processKey: string; message: string }> => {
    const { goal, threadId }: { goal: string; threadId: string } =
      await ctx.runQuery(internal.easygov.stages.route.route.goalOf, {
        caseId,
      });
    const packs = listPacks();
    const keys = packs.map((pack) => pack.key);
    const { object } = await routeAgent.generateObject(
      ctx,
      { threadId },
      {
        prompt: [
          `Goal: ${goal}`,
          "Processes:",
          ...packs.map((pack) => `- ${pack.key}: ${pack.title}`),
        ].join("\n"),
        schema: z.object({
          processKey: z.enum(["none", ...keys]),
          message: z.string(),
        }),
      },
      { storageOptions: { saveMessages: "none" } },
    );
    return object;
  },
});

// --- What a person can send: yes or no to a process --------------------------

export const routeEvents = {
  "route.confirm": (_found, { processKey }) => {
    if (!getPack(processKey)) {
      throw new ConvexError(`Unknown process "${processKey}".`);
    }
    return { route: { status: "confirmed", processKey } };
  },
  // Clearing the goal makes intake wait for a new one.
  "route.reject": () => ({ route: { status: "rejected" }, intake: undefined }),
} satisfies StageEvents;

// --- The workflow -----------------------------------------------------------

export const run = defineStage(
  async (step, { caseId, params }): Promise<StageResult> => {
    const { backTo } = routeParams.parse(params ?? {});
    const needsProposal = await step.runQuery(
      internal.easygov.stages.route.route.needsProposal,
      { caseId },
    );
    if (needsProposal) {
      const proposal = await step.runAction(
        internal.easygov.stages.route.route.propose,
        { caseId },
        { retry: true },
      );
      const proposed = await step.runMutation(
        internal.easygov.stages.route.route.recordProposal,
        { caseId, ...proposal },
      );
      if (!proposed) {
        return { outcome: "stop", reason: "No supported process fits yet" };
      }
    }
    return waitFor(step, () =>
      step.runQuery(internal.easygov.stages.route.route.check, {
        caseId,
        backTo,
      }),
    );
  },
);

// --- What the workflow reads and writes -------------------------------------

export const check = internalQuery({
  args: { caseId: v.id("cases"), backTo: v.string() },
  returns: v.union(vStageResult, v.null()),
  handler: async (ctx, { caseId, backTo }): Promise<StageResult | null> => {
    const route = (await ctx.db.get("cases", caseId))?.route;
    if (route?.status === "rejected") return { outcome: "back", backTo };
    if (route?.status === "confirmed" && getPack(route.processKey)) {
      // `advance` splices the confirmed pack's plan in after this step.
      return { outcome: "done" };
    }
    return null;
  },
});

export const goalOf = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.object({ goal: v.string(), threadId: v.string() }),
  handler: async (ctx, { caseId }) => {
    const found = await ctx.db.get("cases", caseId);
    const goal = found?.intake?.goal;
    if (!goal) throw new Error("The case has no goal yet");
    return { goal, threadId: found.threadId };
  },
});

/** True until a process has been proposed or chosen on this visit. */
export const needsProposal = internalQuery({
  args: { caseId: v.id("cases") },
  returns: v.boolean(),
  handler: async (ctx, { caseId }) =>
    !(await ctx.db.get("cases", caseId))?.route,
});

/**
 * Keeps the agent's proposal and tells the person. Returns false when no
 * known process fits. A choice the person already made is left alone.
 */
export const recordProposal = internalMutation({
  args: { caseId: v.id("cases"), processKey: v.string(), message: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { caseId, processKey, message }) => {
    const found = await ctx.db.get("cases", caseId);
    if (!found || found.status !== "active") return false;
    if (found.route) return true;
    await routeAgent.saveMessage(ctx, {
      threadId: found.threadId,
      message: { role: "assistant", content: message },
      skipEmbeddings: true,
    });
    if (!getPack(processKey)) return false;
    await ctx.db.patch("cases", caseId, {
      route: { status: "proposed", processKey },
    });
    return true;
  },
});
