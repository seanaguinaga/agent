import { expect, test, vi } from "vitest";
import { saveMessage } from "@convex-dev/agent";
import { api, components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";
// What useUIMessages applies to query results. Not a public export.
import { mergeUIMessages } from "../../../src/vercel/react/useUIMessages";

vi.mock("../debugging/telemetry", async () => {
  const { BasicTracerProvider } = await import("@opentelemetry/sdk-trace-base");
  return { tracerProvider: new BasicTracerProvider() };
});

// Returns JSON with the wrong keys, like the gateway model without
// structured outputs.
vi.mock("../modelsForDemo", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  return {
    embeddingModel: undefined,
    languageModel: new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: '{"suggestion":"a warm hat"}' }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    }),
  };
});

test("failed attempts survive the useUIMessages merge, including during a live retry", async () => {
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {});
  const question = await t.run((ctx) =>
    saveMessage(ctx, components.agent, {
      threadId,
      prompt: "What should I wear based on the weather?",
    }),
  );
  // Two attempts at the same prompt, like a workflow retrying the step.
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      t.action(internal.workflows.chaining.getFashionAdvice, {
        threadId,
        promptMessageId: question.messageId,
      }),
    ).rejects.toThrow("did not match schema");
  }

  const { page } = await t.query(api.workflows.weatherFashion.listMessages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 10 },
  });
  const failed = page.filter((m) => m.status === "failed");
  expect(failed).toHaveLength(2);
  expect(page.every((message) => message.metadata === undefined)).toBe(true);

  const merged = mergeUIMessages(page, []);
  expect(merged).toHaveLength(2);
  expect(merged[1]?.status).toBe("failed");
  expect(
    merged[1]?.parts.filter((part) => part.type === "data-failedAttempt"),
  ).toHaveLength(2);

  const liveRetry = mergeUIMessages(page, [
    {
      ...failed[1]!,
      id: "live-retry",
      stepOrder: Math.max(...failed.map((message) => message.stepOrder)) + 1,
      status: "streaming",
      parts: [{ type: "text", text: "Try a warm" }],
    },
  ]);
  expect(liveRetry[1]?.status).toBe("streaming");
  expect(liveRetry[1]?.text).toContain("Try a warm");
  expect(
    liveRetry[1]?.parts.filter((part) => part.type === "data-failedAttempt"),
  ).toHaveLength(2);
});
