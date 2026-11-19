// A case, from start to finish, as one durable workflow. See
// https://docs.convex.dev/agents/workflows
//
// 1. Agree on what to do: chat until there's a goal, propose a process pack,
//    and wait for the person to confirm it (or reject it and try again).
// 2. Collect the pack's answers and files, build the document, and wait for
//    approval. Editing an answer in review goes around again.
// 3. Finish: ask before sharing the case with a lawyer, if a referral is
//    offered, and prepare delivery if the pack says so.
//
// The case in the table is the truth. Each wait reads it and nothing else,
// and a person's event only says "look again". So a retry restarts this
// workflow from the top, and it picks up wherever the case is.
import {
  defineEvent,
  WorkflowManager,
  type WorkflowCtx,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { Case } from "./state";

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    // Actions must be safe to repeat: they're retried unless they opt out.
    retryActionsByDefault: true,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 500, base: 2 },
  },
});

/** Goals the person may try before the case stops. */
const MAX_GOALS = 5;
/** Intake replies per goal before the case stops. */
const MAX_TURNS = 12;
/** Times around collect → fill → review before the case stops. */
const MAX_REVIEWS = 20;

export const run = workflow.define({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (step, { caseId }): Promise<null> => {
    const data = internal.easygov.case.data;
    const agents = internal.easygov.case.agents;
    const stop = async (reason: string) => {
      await step.runMutation(data.stop, { caseId, reason });
      return null;
    };

    // 1. Agree on what to do.
    for (let goals = 0; ; goals++) {
      if (goals === MAX_GOALS)
        return stop(`No process agreed in ${MAX_GOALS} goals`);
      if (!(await chatUntilGoal(step, caseId))) {
        return stop(`Intake didn't find a goal in ${MAX_TURNS} turns`);
      }
      if (await step.runQuery(data.needsProposal, { caseId })) {
        const proposal = await step.runAction(
          agents.propose,
          { caseId },
          { retry: true },
        );
        if (
          !(await step.runMutation(data.recordProposal, {
            caseId,
            ...proposal,
          }))
        ) {
          return stop("No supported process fits yet");
        }
      }
      // Rejected, or a clarifying question: back to intake for a new goal.
      const decision = await waitFor(step, () =>
        step.runQuery(data.packDecision, { caseId }),
      );
      if (decision === "confirmed") break;
    }

    // What the person already said may answer some of the pack's questions:
    // those are offered back for them to accept, so they aren't asked twice.
    if (await step.runQuery(data.needsPrefill, { caseId })) {
      const found = await step.runAction(
        agents.prefill,
        { caseId },
        { retry: true },
      );
      await step.runMutation(data.recordPrefill, { caseId, ...found });
    }

    // 2. Answers, the document, and review. Legal advice has no pack, so
    // there's nothing to collect.
    if (
      !(await step.runQuery(data.isReferral, { caseId })) &&
      !(await reviewUntilApproved(step, caseId))
    ) {
      return stop(`Reviewed ${MAX_REVIEWS} times without approval`);
    }

    // 3. Finish, once the person has said whether to share an offered
    // referral.
    await waitFor(step, () => step.runQuery(data.referralSettled, { caseId }));
    await step.runMutation(data.finish, { caseId });
    return null;
  },
});

/** Collects, builds and reviews until approved. False if it ran out of tries. */
async function reviewUntilApproved(
  step: WorkflowCtx,
  caseId: Id<"cases">,
): Promise<boolean> {
  const data = internal.easygov.case.data;
  for (let reviews = 0; reviews < MAX_REVIEWS; reviews++) {
    await waitFor(step, () => step.runQuery(data.answersComplete, { caseId }));
    // A checklist that covers every route is cut to the person's own.
    const tailored = (await step.runQuery(data.needsTailoring, { caseId }))
      ? await step.runAction(
          internal.easygov.case.agents.tailor,
          { caseId },
          { retry: true },
        )
      : undefined;
    // A pack for an official form gets that form, filled in and checked.
    const form = await step.runQuery(
      internal.easygov.forms.data.editionOfCase,
      { caseId },
    );
    const document = form
      ? await step.runAction(
          internal.easygov.forms.actions.fillForCase,
          { caseId },
          { retry: true },
        )
      : null;
    await step.runMutation(data.fill, {
      caseId,
      ...(tailored && { tailored }),
      ...(document && { document }),
    });
    const outcome = await waitFor(step, () =>
      step.runQuery(data.reviewResult, { caseId }),
    );
    if (outcome === "approved") return true;
  }
  return false;
}

/** Answers chat messages until there's a goal. False if it ran out of turns. */
async function chatUntilGoal(
  step: WorkflowCtx,
  caseId: Id<"cases">,
): Promise<boolean> {
  const data = internal.easygov.case.data;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const next = await waitFor(step, () =>
      step.runQuery(data.intakeNext, { caseId }),
    );
    if (next.kind === "done") return true;
    const { promptMessageId } = next;
    const { reply, goal } = await step.runAction(
      internal.easygov.case.agents.intakeTurn,
      { caseId, promptMessageId },
      { retry: true },
    );
    await step.runMutation(data.recordTurn, {
      caseId,
      promptMessageId,
      reply,
      goal,
    });
  }
  return false;
}

// --- Waiting for a person ---------------------------------------------------

/**
 * Sent to the case's workflow when something changed. It only means "look
 * again": it carries nothing, because the truth is in the table.
 */
const nudge = defineEvent({ name: "nudge", validator: v.null() });

/** Tells the case's workflow to look again, if one is running. */
export async function nudgeCase(ctx: MutationCtx, c: Case): Promise<void> {
  if (!c.workflowId) return;
  await workflow.sendEvent(ctx, {
    ...nudge,
    workflowId: c.workflowId,
    value: null,
  });
}

const MAX_WAKES = 100;

/**
 * Waits until `check` (a `step.runQuery` that reads the case) returns
 * something. Each nudge is a reason to check again; nudges sent before the
 * wait began are kept, so none are missed.
 */
async function waitFor<T>(
  step: WorkflowCtx,
  check: () => Promise<T | null>,
): Promise<T> {
  for (let wakes = 0; wakes <= MAX_WAKES; wakes++) {
    const found = await check();
    if (found !== null) return found;
    await step.awaitEvent(nudge);
  }
  throw new Error(`Still waiting after ${MAX_WAKES} nudges`);
}
