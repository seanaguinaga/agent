// One question with a fixed set of answers, put to the decision model.
//
// An ordinary model answers a choice with a bare word. The decision model
// answers with how sure it is, so the caller can act on a confident answer
// and set aside a guess. It is asked through the AI Gateway's Decisions API:
// https://docs.convex.dev/ai-gateway/api#post-alphadecisions
import { getServiceToken } from "convex/server";
import { z } from "zod/v4";
import type { ActionCtx } from "../_generated/server";
import { decisionModel } from "../modelsForDemo";
import { chargeUsage } from "./limits";

const zAnswer = z.object({
  answers: z.object({
    answer: z.object({
      choice: z.string(),
      confidence: z.number().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
  }),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export type Decision<K extends string> = {
  choice: K;
  /** From 0 to 1, where the model says. */
  confidence?: number;
};

/**
 * The answer the decision model chooses, and how sure it is. `criteria` says
 * what each answer means. Undefined if the model can't be reached or answers
 * something that wasn't offered: the caller then decides some other way.
 */
export async function decide<K extends string>(
  ctx: ActionCtx,
  question: {
    state: Record<string, string>;
    instructions: string;
    criteria: Record<K, string>;
  },
): Promise<Decision<K> | undefined> {
  try {
    const token = await getServiceToken("ai-gateway");
    const response = await fetch(
      "https://ai-gateway.convex.dev/alpha/decisions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: decisionModel,
          state: question.state,
          questions: {
            answer: {
              type: "choice",
              instructions: question.instructions,
              criteria: question.criteria,
            },
          },
        }),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { answers, usage } = zAnswer.parse(await response.json());
    await chargeUsage(
      ctx,
      undefined,
      (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    );
    const { choice, confidence, probabilities } = answers.answer;
    if (!Object.hasOwn(question.criteria, choice)) return undefined;
    return {
      choice: choice as K,
      confidence: confidence ?? probabilities?.[choice],
    };
  } catch (error) {
    console.error("Decision model unavailable", error);
    return undefined;
  }
}
