// See the docs at https://docs.convex.dev/agents/context
import { components } from "../_generated/api";
import { createTool, fetchContextMessages } from "@convex-dev/agent";
import z from "zod/v3";
import { embed } from "ai";
import { embeddingModel, queryEmbeddingModel } from "../modelsForDemo";

/**
 * Manual search
 */

export const searchMessages = createTool({
  description: "Search for messages in the thread",
  inputSchema: z.object({
    query: z.string().describe("The query to search for"),
  }),
  execute: async (ctx, { query }) => {
    return fetchContextMessages(ctx, components.agent, {
      userId: ctx.userId,
      threadId: ctx.threadId,
      searchText: query,
      contextOptions: {
        searchOtherThreads: !!ctx.userId, // search other threads if the user is logged in
        recentMessages: 0, // only search older messages
        searchOptions: {
          textSearch: true,
          vectorSearch: true,
          messageRange: { before: 0, after: 0 },
          limit: 10,
        },
      },
      getEmbedding: async (text) => {
        const model = queryEmbeddingModel ?? embeddingModel;
        if (!model) {
          throw new Error(
            "Set GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY to use vector message search.",
          );
        }
        const e = await embed({ model, value: text });
        return {
          embedding: e.embedding,
          embeddingModel: model,
        };
      },
    });
  },
});
