// Test helper: lets a scripted `doGenerate` mock also serve `streamText`.
// Lives outside convex/ so it isn't bundled into the deployment.
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";

/**
 * Builds a `doStream` that calls `doGenerate` and replays its result as
 * stream parts, so one script drives both `generateText` and `streamText`.
 */
export function streamFromGenerate(
  doGenerate: LanguageModelV4["doGenerate"],
): LanguageModelV4["doStream"] {
  return async (options) => {
    const result = await doGenerate(options);
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: result.warnings },
    ];
    result.content.forEach((part, i) => {
      if (part.type === "text") {
        const id = `text-${i}`;
        chunks.push(
          { type: "text-start", id },
          { type: "text-delta", id, delta: part.text },
          { type: "text-end", id },
        );
      } else if (part.type === "tool-call") {
        chunks.push(part);
      } else {
        throw new Error(`streamFromGenerate: unsupported part ${part.type}`);
      }
    });
    chunks.push({
      type: "finish",
      finishReason: result.finishReason,
      usage: result.usage,
    });
    // No delays, so it also works under fake timers.
    return {
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    };
  };
}
