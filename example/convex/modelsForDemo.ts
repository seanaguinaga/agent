import { convexGateway } from "@convex-dev/ai-sdk-provider";
import { wrapEmbeddingModel } from "ai";

export const languageModel = convexGateway("openai/gpt-6-luna");

// Existing Agent and RAG indexes use the unqualified OpenAI model ID.
export const embeddingModel = wrapEmbeddingModel({
  model: convexGateway.embeddingModel("openai/text-embedding-3-small"),
  modelId: "text-embedding-3-small",
  middleware: { specificationVersion: "v4" },
});

export const imageModel = convexGateway.imageModel("openai/gpt-image-1-mini");
export const decisionModel = "typesafe/jev-1.13";
