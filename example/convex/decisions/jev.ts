import { getServiceToken } from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod/v4";
import { action } from "../_generated/server";

const probability = z.number().min(0).max(1);
const decisionResponse = z.object({
  id: z.string(),
  model: z.string(),
  answers: z.object({
    priority: z.object({
      type: z.literal("choice"),
      choice: z.enum(["urgent", "normal", "low"]),
      confidence: probability.optional(),
      probabilities: z.record(z.string(), probability).optional(),
    }),
    needsHuman: z.object({ type: z.literal("noul"), noul: probability }),
  }),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

// https://docs.convex.dev/ai-gateway/api#post-alphadecisions
export const triage = action({
  args: { ticket: v.string() },
  handler: async (_ctx, { ticket }) => {
    ticket = ticket.trim();
    if (!ticket || ticket.length > 8000) {
      throw new ConvexError("Enter a ticket between 1 and 8,000 characters.");
    }
    const token = await getServiceToken("ai-gateway");
    // Demonstrate the Gateway's Decisions HTTP API.
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
          model: "typesafe/jev-1.13",
          state: { ticket },
          questions: {
            priority: {
              type: "choice",
              instructions:
                "Choose the support ticket's priority based on its impact.",
              criteria: {
                urgent:
                  "An outage, security incident, or data loss blocks users and needs immediate attention.",
                normal:
                  "A bug affects users but has a workaround or limited impact.",
                low: "A feature request, cosmetic issue, or general question with no blocked work.",
              },
            },
            needsHuman: {
              type: "noul",
              instructions:
                "Does this ticket require human investigation or an account-specific decision rather than a self-service documentation answer?",
            },
          },
        }),
      },
    );
    if (!response.ok) {
      throw new ConvexError(
        `Jev request failed (HTTP ${response.status}). Check gateway access and try again.`,
      );
    }
    const parsed = decisionResponse.safeParse(await response.json());
    if (!parsed.success)
      throw new ConvexError("Jev returned an unexpected decision response.");
    return parsed.data;
  },
});
