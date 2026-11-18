import { v } from "convex/values";
import { stepCountIs } from "ai";
import { action } from "../_generated/server";
import { agent } from "../agents/simple";
import { authorizeThreadAccess } from "../threads";
import { searchMessages } from "./searchMessages";
import { updateThreadTitle } from "./updateThreadTitle";
import { getAuthUserId } from "../utils";

export const sendMessage = action({
  args: { threadId: v.string(), prompt: v.string() },
  handler: async (ctx, { threadId, prompt }) => {
    await authorizeThreadAccess(ctx, threadId);
    const result = await agent.generateText(
      ctx,
      { threadId, userId: await getAuthUserId(ctx) },
      {
        prompt,
        tools: { searchMessages, updateThreadTitle },
        stopWhen: stepCountIs(5),
      },
    );
    return result.text;
  },
});
