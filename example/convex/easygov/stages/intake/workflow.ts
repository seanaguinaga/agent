// The intake stage: chats with the person, one agent turn per message, until
// the goal is clear.
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { vStageResult, type StageResult } from "../../case/schema";
import { stageArgs, waitFor, workflow } from "../shared";

const MAX_TURNS = 12;

export const params = z.strictObject({});

// `sendMessage` nudges this stage when a chat message arrives.
export const chats = true;

export const run = workflow.define({
  args: stageArgs,
  returns: vStageResult,
  handler: async (step, args): Promise<StageResult> => {
    params.parse(args.params ?? {});
    const { caseId } = args;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const next = await waitFor(step, () =>
        step.runQuery(internal.easygov.stages.intake.data.check, { caseId }),
      );
      if (next.kind === "done") return { outcome: "done" };
      const { promptMessageId } = next;
      const { reply, goal } = await step.runAction(
        internal.easygov.stages.intake.agent.turn,
        { caseId, promptMessageId },
        { retry: true },
      );
      await step.runMutation(internal.easygov.stages.intake.data.record, {
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
});
