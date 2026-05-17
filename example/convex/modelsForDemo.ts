import {
  defaultEmbeddingSettingsMiddleware,
  type EmbeddingModel,
  embed,
  wrapEmbeddingModel,
} from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { anthropic } from "@ai-sdk/anthropic";
import { google, type GoogleEmbeddingModelOptions } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { mockModel } from "@convex-dev/agent";

export const GOOGLE_EMBEDDING_MODEL_ID = "gemini-embedding-2-preview";
export const GOOGLE_EMBEDDING_DIMENSIONS = 1536;
const GOOGLE_DOCUMENT_EMBEDDING_TASK_TYPE = "RETRIEVAL_DOCUMENT";
const GOOGLE_QUERY_EMBEDDING_TASK_TYPE = "RETRIEVAL_QUERY";
const GOOGLE_ANSWER_MODEL_ID =
  process.env.GOOGLE_ANSWER_MODEL_ID ?? "gemini-2.5-flash";

const googleDocumentEmbeddingProviderOptions = {
  google: {
    outputDimensionality: GOOGLE_EMBEDDING_DIMENSIONS,
    taskType: GOOGLE_DOCUMENT_EMBEDDING_TASK_TYPE,
  } satisfies GoogleEmbeddingModelOptions,
};

const googleQueryEmbeddingProviderOptions = {
  google: {
    outputDimensionality: GOOGLE_EMBEDDING_DIMENSIONS,
    taskType: GOOGLE_QUERY_EMBEDDING_TASK_TYPE,
  } satisfies GoogleEmbeddingModelOptions,
};

function googleEmbeddingModel(providerOptions: {
  google: GoogleEmbeddingModelOptions;
}) {
  return wrapEmbeddingModel({
    middleware: defaultEmbeddingSettingsMiddleware({
      settings: { providerOptions },
    }),
    model: google.embeddingModel(GOOGLE_EMBEDDING_MODEL_ID),
  });
}

let languageModel: LanguageModelV3;
let embeddingModel: EmbeddingModel | undefined;
let queryEmbeddingModel: EmbeddingModel | undefined;

if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  languageModel = google.chat(GOOGLE_ANSWER_MODEL_ID);
  embeddingModel = googleEmbeddingModel(googleDocumentEmbeddingProviderOptions);
  queryEmbeddingModel = googleEmbeddingModel(googleQueryEmbeddingProviderOptions);
} else if (process.env.ANTHROPIC_API_KEY) {
  languageModel = anthropic.chat("claude-opus-4-20250514");
} else if (process.env.OPENAI_API_KEY) {
  languageModel = openai.chat("gpt-4o-mini");
  embeddingModel = openai.embedding("text-embedding-3-small");
  queryEmbeddingModel = embeddingModel;
} else if (process.env.GROQ_API_KEY) {
  languageModel = groq.languageModel(
    "meta-llama/llama-4-scout-17b-16e-instruct",
  );
} else {
  languageModel = mockModel({});
  console.warn(
    "Run `npx convex env set GROQ_API_KEY=<your-api-key>` or `npx convex env set OPENAI_API_KEY=<your-api-key>` from the example directory to set the API key.",
  );
}

// Backwards-compatible alias for APIs that still call this textEmbeddingModel.
const textEmbeddingModel = embeddingModel as EmbeddingModel;

export async function queryForSearch(query: string) {
  if (!queryEmbeddingModel) {
    return query;
  }
  const result = await embed({ model: queryEmbeddingModel, value: query });
  return result.embedding;
}

// If you want to use different models for examples, you can change them here.
export { embeddingModel, languageModel, queryEmbeddingModel, textEmbeddingModel };
