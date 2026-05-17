import { saveMessage } from "@convex-dev/agent";
import { components } from "./_generated/api";
import { isUsingConfiguredLanguageModel } from "./modelsForDemo";

type SaveMessageCtx = Parameters<typeof saveMessage>[0];

export const missingApiKeyMessage =
  "This example needs an AI provider API key before it can generate a real response. Run one of these from the example directory:\n\n" +
  "- `npx convex env set GOOGLE_GENERATIVE_AI_API_KEY=<your-api-key>`\n" +
  "- `npx convex env set OPENAI_API_KEY=<your-api-key>`\n" +
  "- `npx convex env set GROQ_API_KEY=<your-api-key>`\n\n" +
  "After setting it, restart `npm run dev:backend` or wait for Convex to redeploy.";

export function assertConfiguredLanguageModel() {
  if (!isUsingConfiguredLanguageModel) {
    throw new Error(missingApiKeyMessage);
  }
}

export function errorToUserMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes("No object generated")) {
      return "The model response could not be parsed into the expected structured format. Please try again, or adjust the prompt to ask for a clearer answer.";
    }
    if (
      error.message.includes("API key") ||
      error.message.includes("api key") ||
      error.message.includes("authentication") ||
      error.message.includes("Unauthorized")
    ) {
      return error.message;
    }
    return `Something went wrong while generating the response: ${error.message}`;
  }
  return "Something went wrong while generating the response.";
}

export async function saveErrorMessage(
  ctx: SaveMessageCtx,
  threadId: string,
  error: unknown,
  agentName = "Agent",
) {
  const text = errorToUserMessage(error);
  console.error("[agent-example] generation failed", { threadId, text, error });
  await saveMessage(ctx, components.agent, {
    threadId,
    agentName,
    message: {
      role: "assistant",
      content: text,
    },
  });
  return text;
}
