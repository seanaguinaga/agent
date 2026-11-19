// The deliver stage: marks the approved artifact as ready to send. Nothing is
// sent yet. It doesn't wait for anyone.
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { vStageResult, type StageResult } from "../../case/schema";
import { stageArgs, workflow } from "../shared";

export const params = z.strictObject({ channel: z.enum(["mail", "online"]) });

export const chats = false;

export const run = workflow.define({
  args: stageArgs,
  returns: vStageResult,
  handler: async (step, args): Promise<StageResult> => {
    const { channel } = params.parse(args.params ?? {});
    const { caseId } = args;
    await step.runMutation(internal.easygov.stages.deliver.data.prepare, {
      caseId,
      channel,
    });
    return { outcome: "done" };
  },
});
