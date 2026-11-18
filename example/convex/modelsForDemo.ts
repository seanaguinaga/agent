import { type EmbeddingModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { convexGateway } from "@convex-dev/ai-sdk-provider";

let languageModel: LanguageModelV4;
// Note: This is only defined when OPENAI_API_KEY is set. Consumers should
// handle the undefined case at runtime when using non-OpenAI providers.
let embeddingModel: EmbeddingModel;

if (process.env.ANTHROPIC_API_KEY) {
  languageModel = anthropic.chat("claude-haiku-5-5");
} else if (process.env.OPENAI_API_KEY) {
  languageModel = openai.chat("gpt-6-luna");
  embeddingModel = openai.embedding("text-embedding-3-small");
} else if (process.env.GROQ_API_KEY) {
  languageModel = groq.languageModel("openai/gpt-oss-20b");
} else {
  languageModel = convexGateway("openai/gpt-6-luna");
}

// If you want to use different models for examples, you can change them here.
export { languageModel, embeddingModel };
