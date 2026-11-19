// The collect stage: waits until the case has every answer its pack requires.
import { z } from "zod/v4";
import { internal } from "../../../_generated/api";
import { vStageResult, type StageResult } from "../../case/schema";
import { stageArgs, waitFor, workflow } from "../shared";

export const params = z.strictObject({});

export const chats = false;

export const run = workflow.define({
  args: stageArgs,
  returns: vStageResult,
  handler: async (step, args): Promise<StageResult> => {
    params.parse(args.params ?? {});
    const { caseId } = args;
    return await waitFor(step, () =>
      step.runQuery(internal.easygov.stages.collect.data.check, { caseId }),
    );
  },
});
