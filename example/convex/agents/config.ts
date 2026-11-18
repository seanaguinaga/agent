import { type Config } from "@convex-dev/agent";
import { convexGateway } from "@convex-dev/ai-sdk-provider";
import { languageModel, embeddingModel } from "../modelsForDemo";
import { rawRequestResponseHandler } from "../debugging/rawRequestResponseHandler";
import { usageHandler } from "../usage_tracking/usageHandler";

export const defaultConfig = {
  languageModel,
  rawRequestResponseHandler,
  usageHandler,
  // GPT-6 Chat Completions requires no reasoning when calling tools.
  providerOptions: {
    convexGateway: { reasoningEffort: "none" },
  },
  // If you want to use vector search, you need to set this.
  embeddingModel,
} satisfies Config;

export const streamingReasoningConfig = {
  ...defaultConfig,
  languageModel: convexGateway("openai/gpt-oss-120b"),
  providerOptions: {
    convexGateway: { reasoningEffort: "medium" },
  },
} satisfies Config;
