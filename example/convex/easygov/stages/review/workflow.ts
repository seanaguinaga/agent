// The review stage: waits for the person to approve the artifact, or to
// change an answer (collect's `answers.set`, which review also takes).
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { vStageResult, type StageResult } from "../../case/schema";
import { stageArgs, waitFor, workflow } from "../shared";

/** `backTo`: the step to return to when an answer changes. */
export const params = z.strictObject({ backTo: z.string() });

export const chats = false;

export const run = workflow.define({
  args: stageArgs,
  returns: vStageResult,
  handler: async (step, args): Promise<StageResult> => {
    const { backTo } = params.parse(args.params ?? {});
    const { caseId } = args;
    return await waitFor(step, () =>
      step.runQuery(internal.easygov.stages.review.data.check, {
        caseId,
        backTo,
      }),
    );
  },
});
