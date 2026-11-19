// The legalReferral stage: opens a referral for someone else to pick up. The
// case doesn't wait for it.
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { vStageResult, type StageResult } from "../../case/schema";
import { stageArgs, workflow } from "../shared";

export const params = z.strictObject({ kind: z.string() });

export const chats = false;

export const run = workflow.define({
  args: stageArgs,
  returns: vStageResult,
  handler: async (step, args): Promise<StageResult> => {
    const { kind } = params.parse(args.params ?? {});
    const { caseId } = args;
    await step.runMutation(internal.easygov.stages.legalReferral.data.open, {
      caseId,
      kind,
    });
    return { outcome: "done" };
  },
});
