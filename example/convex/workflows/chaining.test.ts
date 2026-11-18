import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { listMessages, saveMessage } from "@convex-dev/agent";
import { api, components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";
import { languageModel } from "../modelsForDemo";
import { tracerProvider } from "../debugging/telemetry";

const state = vi.hoisted(() => ({
  exporter: undefined as InMemorySpanExporter | undefined,
}));

vi.mock("../debugging/telemetry", async () => {
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
    await import("@opentelemetry/sdk-trace-base");
  state.exporter = new InMemorySpanExporter();
  return {
    tracerProvider: new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(state.exporter)],
    }),
  };
});

vi.mock("../modelsForDemo", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const { streamFromGenerate } = await import(
    "../../testing/streamFromGenerate"
  );
  const languageModel = new MockLanguageModelV4();
  languageModel.doGenerate = vi.fn();
  // getForecast streams: replay whatever doGenerate is scripted to return.
  languageModel.doStream = streamFromGenerate((options) =>
    languageModel.doGenerate(options),
  );
  return {
    languageModel,
    embeddingModel: undefined,
  };
});

const outfit = { hat: "cap", tops: "shirt", bottoms: "jeans", shoes: "boots" };
const response = {
  content: [{ type: "text" as const, text: JSON.stringify(outfit) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
  },
  warnings: [],
};

beforeEach(() => {
  state.exporter!.reset();
  vi.mocked(languageModel.doGenerate).mockReset().mockResolvedValue(response);
});
afterEach(() => vi.restoreAllMocks());

async function setup() {
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {});
  return { t, threadId };
}

test("the single action exports named agent and tool spans without message content", async () => {
  const { t, threadId } = await setup();
  const flush = vi.spyOn(tracerProvider, "forceFlush");
  vi.mocked(languageModel.doGenerate)
    .mockResolvedValueOnce(response)
    .mockResolvedValueOnce({
      ...response,
      content: [
        {
          type: "tool-call",
          toolCallId: "preferences",
          toolName: "getUserPreferences",
          input: JSON.stringify({ search: "style" }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
    });

  await t.action(api.workflows.chaining.getAdvice, {
    threadId,
    location: "Paris",
  });

  expect(flush).toHaveBeenCalledOnce();
  const spans = state.exporter!.getFinishedSpans();
  expect(spans.map((span) => span.name)).toEqual(
    expect.arrayContaining([
      "invoke_agent workflows/chaining/getAdvice/weather",
      "invoke_agent workflows/chaining/getAdvice/fashion",
      "execute_tool getUserPreferences",
    ]),
  );
  expect(
    spans.some((span) => span.attributes["gen_ai.usage.input_tokens"] === 3),
  ).toBe(true);
  for (const span of spans) {
    expect(span.attributes["convex.thread_id"]).toBe(threadId);
    for (const attribute of [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.tool.call.arguments",
      "gen_ai.tool.call.result",
    ]) {
      expect(Object.keys(span.attributes)).not.toContain(attribute);
    }
  }
});

test("durable actions flush separately and correlate traces with saved prompts", async () => {
  const { t, threadId } = await setup();
  const flush = vi.spyOn(tracerProvider, "forceFlush");
  const weatherQ = await t.run((ctx) =>
    saveMessage(ctx, components.agent, {
      threadId,
      prompt: "Weather?",
    }),
  );
  const forecast = await t.action(internal.workflows.chaining.getForecast, {
    threadId,
    promptMessageId: weatherQ.messageId,
  });
  expect(forecast.text).toBe(JSON.stringify(outfit));
  expect(forecast.savedMessageIds).toHaveLength(1);

  const fashionQ = await t.run((ctx) =>
    saveMessage(ctx, components.agent, {
      threadId,
      prompt: "What should I wear?",
    }),
  );
  const fashion = await t.action(internal.workflows.chaining.getFashionAdvice, {
    threadId,
    promptMessageId: fashionQ.messageId,
  });
  expect(fashion.object).toEqual(outfit);
  expect(fashion.savedMessageIds).toHaveLength(1);
  expect(flush).toHaveBeenCalledTimes(2);

  const roots = state
    .exporter!.getFinishedSpans()
    .filter((span) => span.name.startsWith("invoke_agent "));
  expect(
    roots.map((span) => [
      span.name,
      span.attributes["convex.prompt_message_id"],
    ]),
  ).toEqual([
    ["invoke_agent workflows/chaining/getForecast", weatherQ.messageId],
    ["invoke_agent workflows/chaining/getFashionAdvice", fashionQ.messageId],
  ]);
});

test("failed generation exports an error span and preserves the original error if flushing fails", async () => {
  const { t, threadId } = await setup();
  const question = await t.run((ctx) =>
    saveMessage(ctx, components.agent, {
      threadId,
      prompt: "Weather?",
    }),
  );
  vi.mocked(languageModel.doGenerate).mockRejectedValue(
    new Error("model failed"),
  );
  const flush = vi
    .spyOn(tracerProvider, "forceFlush")
    .mockRejectedValueOnce(new Error("export failed"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    t.action(internal.workflows.chaining.getForecast, {
      threadId,
      promptMessageId: question.messageId,
    }),
  ).rejects.toThrow("model failed");

  expect(flush).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(
    "Failed to flush chaining telemetry",
    expect.any(Error),
  );
  expect(
    state
      .exporter!.getFinishedSpans()
      .find(
        (span) => span.name === "invoke_agent workflows/chaining/getForecast",
      )?.status.code,
  ).toBe(2);
});

test("a failed forecast stream records the model's error, not a generic abort", async () => {
  const { t, threadId } = await setup();
  const question = await t.run((ctx) =>
    saveMessage(ctx, components.agent, { threadId, prompt: "Weather?" }),
  );
  vi.mocked(languageModel.doGenerate).mockRejectedValue(
    new Error("model failed"),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(
    t.action(internal.workflows.chaining.getForecast, {
      threadId,
      promptMessageId: question.messageId,
    }),
  ).rejects.toThrow("model failed");

  const { page } = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  );
  const failed = page.filter((m) => m.status === "failed");
  expect(failed.map((m) => m.error)).toEqual([
    expect.stringContaining("model failed"),
  ]);
});

test("a flush failure does not turn completed work into a retryable action failure", async () => {
  const { t, threadId } = await setup();
  vi.spyOn(tracerProvider, "forceFlush").mockRejectedValueOnce(
    new Error("export failed"),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    t.action(api.workflows.chaining.getAdvice, {
      threadId,
      location: "Paris",
    }),
  ).resolves.toBeNull();
  expect(languageModel.doGenerate).toHaveBeenCalledTimes(2);
});
