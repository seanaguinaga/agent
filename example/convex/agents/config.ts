import { type Config } from "@convex-dev/agent";
import { languageModel, embeddingModel } from "../modelsForDemo";
import { rawRequestResponseHandler } from "../debugging/rawRequestResponseHandler";
import { usageHandler } from "../usage_tracking/usageHandler";

export const defaultConfig = {
  languageModel,
  rawRequestResponseHandler,
  usageHandler,
  // GPT-6 Chat Completions requires no reasoning when calling tools.
  providerOptions: {
    openai: { reasoningEffort: "none" },
    convexGateway: { reasoningEffort: "none" },
  },
  // If you want to use vector search, you need to set this.
  embeddingModel,
} satisfies Config;
