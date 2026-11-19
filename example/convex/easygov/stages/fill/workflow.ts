// The fill stage: writes the artifact from the current answers. A stand-in
// for PDF filling. It doesn't wait for anyone.
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { vStageResult, type StageResult } from "../../case/schema";
import { stageArgs, workflow } from "../shared";

export const params = z.strictObject({});

export const chats = false;

export const run = workflow.define({
  args: stageArgs,
  returns: vStageResult,
  handler: async (step, args): Promise<StageResult> => {
    params.parse(args.params ?? {});
    const { caseId } = args;
    await step.runMutation(internal.easygov.stages.fill.data.write, { caseId });
    return { outcome: "done" };
  },
});
