// The selectProcessPack stage: proposes a process pack for the case's goal,
// then waits for the person to confirm or reject it.
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { vStageResult, type StageResult } from "../../case/schema";
import { stageArgs, waitFor, workflow } from "../shared";

/** `backTo`: the step to return to when the person rejects the proposal. */
export const params = z.strictObject({ backTo: z.string() });

export const chats = false;

export const run = workflow.define({
  args: stageArgs,
  returns: vStageResult,
  handler: async (step, args): Promise<StageResult> => {
    const { backTo } = params.parse(args.params ?? {});
    const { caseId } = args;
    const { agent, data } = internal.easygov.stages.selectProcessPack;
    if (await step.runQuery(data.needsProposal, { caseId })) {
      const proposal = await step.runAction(
        agent.propose,
        { caseId },
        { retry: true },
      );
      const proposed = await step.runMutation(data.record, {
        caseId,
        ...proposal,
      });
      if (!proposed)
        return { outcome: "stop", reason: "No supported process fits yet" };
    }
    return await waitFor(step, () =>
      step.runQuery(data.check, { caseId, backTo }),
    );
  },
});
