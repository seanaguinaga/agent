import { afterEach, expect, test, vi } from "vitest";
import { listMessages, saveMessage } from "@convex-dev/agent";
import type { WorkId } from "@convex-dev/workpool";
import { api, components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";

vi.mock("../debugging/telemetry", async () => {
  const { BasicTracerProvider } = await import("@opentelemetry/sdk-trace-base");
  return { tracerProvider: new BasicTracerProvider() };
});

const script = vi.hoisted(() => ({
  reply: '{"suggestion":"a warm hat"}',
  // How many of the next model calls throw, like a provider outage.
  outages: 0,
}));

// Always answers with `script.reply`. The default is JSON with the wrong
// keys, like the gateway model without structured outputs, so the fashion
// step fails on every attempt.
vi.mock("../modelsForDemo", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const { streamFromGenerate } = await import(
    "../../testing/streamFromGenerate"
  );
  const languageModel = new MockLanguageModelV4({
    doGenerate: async () => {
      if (script.outages-- > 0) throw new Error("Provider is down");
      return {
        content: [{ type: "text", text: script.reply }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  languageModel.doStream = streamFromGenerate(languageModel.doGenerate);
  return { languageModel, embeddingModel: undefined };
});

afterEach(() => {
  vi.useRealTimers();
  script.reply = '{"suggestion":"a warm hat"}';
  script.outages = 0;
});

type T = ReturnType<typeof initConvexTest>;

async function runEverything(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

test("the page can tell a running workflow from a failed one, and retry it", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const { threadId } = await t.mutation(api.workflows.chaining.startWorkflow, {
    location: "Oslo",
  });
  expect(
    await t.query(api.workflows.weatherFashion.workflowStatus, { threadId }),
  ).toEqual({ type: "inProgress" });

  // The fashion step fails all five attempts, so the workflow gives up.
  await runEverything(t);
  expect(
    await t.query(api.workflows.weatherFashion.workflowStatus, { threadId }),
  ).toEqual({
    type: "failed",
    error: "Error: No object generated: response did not match schema.",
  });

  // Retry reruns only the failed step: the forecast isn't generated again.
  const forecastsBefore = await countReplies(t, threadId, 0);
  script.reply = JSON.stringify({
    hat: "beanie",
    tops: "parka",
    bottoms: "lined trousers",
    shoes: "boots",
  });
  await t.mutation(api.workflows.weatherFashion.retryWorkflow, { threadId });
  await runEverything(t);
  expect(
    await t.query(api.workflows.weatherFashion.workflowStatus, { threadId }),
  ).toEqual({ type: "completed" });
  expect(await countReplies(t, threadId, 0)).toBe(forecastsBefore);
});

test("only a failed workflow can be retried", async () => {
  const t = initConvexTest();
  const { threadId } = await t.mutation(api.workflows.chaining.startWorkflow, {
    location: "Oslo",
  });
  await expect(
    t.mutation(api.workflows.weatherFashion.retryWorkflow, { threadId }),
  ).rejects.toThrow("Only a failed workflow can be retried (inProgress)");
});

test("threads without a workflow have no status", async () => {
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {});
  expect(
    await t.query(api.workflows.weatherFashion.workflowStatus, { threadId }),
  ).toBeNull();
});

test("a follow-up is answered by the fashion agent, and can be asked again", async () => {
  vi.useFakeTimers();
  script.reply = "Bring gloves.";
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {});
  await t.mutation(api.workflows.weatherFashion.askFollowUp, {
    threadId,
    prompt: "What about gloves?",
  });
  await runEverything(t);
  const [prompt] = await messages(t, threadId, "user");
  expect(await messages(t, threadId, "assistant")).toMatchObject([
    { agentName: "Fashion Agent", status: "success", text: "Bring gloves." },
  ]);

  await t.mutation(api.workflows.weatherFashion.retryFollowUp, {
    threadId,
    promptMessageId: prompt!._id,
  });
  await runEverything(t);
  // Same question, answered again at the same order.
  expect(await messages(t, threadId, "user")).toHaveLength(1);
  expect(
    (await messages(t, threadId, "assistant")).map((m) => m.order),
  ).toEqual([prompt!.order, prompt!.order]);
});

test("a failed follow-up isn't retried automatically, but can be retried by hand", async () => {
  vi.useFakeTimers();
  script.reply = "Bring gloves.";
  script.outages = 1;
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {});
  await t.mutation(api.workflows.weatherFashion.askFollowUp, {
    threadId,
    prompt: "What about gloves?",
  });
  await runEverything(t);
  expect(
    (await messages(t, threadId, "assistant")).map((m) => m.status),
  ).toEqual(["failed"]);

  const [prompt] = await messages(t, threadId, "user");
  await t.mutation(api.workflows.weatherFashion.retryFollowUp, {
    threadId,
    promptMessageId: prompt!._id,
  });
  await runEverything(t);
  expect(
    (await messages(t, threadId, "assistant")).map((m) => m.status),
  ).toEqual(["failed", "success"]);
});

test("a follow-up that died without a reply is marked failed, with its error", async () => {
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {});
  const prompt = await savePrompt(t, threadId);
  await followUpDied(t, threadId, prompt._id);

  expect(await messages(t, threadId, "assistant")).toMatchObject([
    { order: prompt.order, status: "failed", error: "Action timed out" },
  ]);
  expect(
    await t.query(api.workflows.weatherFashion.replyError, {
      threadId,
      promptMessageId: prompt._id,
    }),
  ).toBe("Action timed out");
});

test("a follow-up that died mid-answer has its pending reply marked failed", async () => {
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {});
  const prompt = await savePrompt(t, threadId);
  await t.run((ctx) =>
    saveMessage(ctx, components.agent, {
      threadId,
      promptMessageId: prompt._id,
      message: { role: "assistant", content: "Wool" },
      metadata: { status: "pending" },
    }),
  );
  await followUpDied(t, threadId, prompt._id);

  expect(await messages(t, threadId, "assistant")).toMatchObject([
    { status: "failed", error: "Action timed out" },
  ]);
});

async function savePrompt(t: T, threadId: string) {
  const { message } = await t.run((ctx) =>
    saveMessage(ctx, components.agent, { threadId, prompt: "And gloves?" }),
  );
  return message;
}

/** What the workpool reports when the action dies without failing its reply. */
async function followUpDied(t: T, threadId: string, promptMessageId: string) {
  await t.mutation(internal.workflows.weatherFashion.followUpDone, {
    workId: "w" as WorkId,
    context: { threadId, promptMessageId },
    result: { kind: "failed", error: "Action timed out" },
  });
}

async function messages(t: T, threadId: string, role: "user" | "assistant") {
  const { page } = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    }),
  );
  return page.filter((m) => m.message?.role === role).reverse();
}

async function countReplies(t: T, threadId: string, order: number) {
  return (await messages(t, threadId, "assistant")).filter(
    (m) => m.order === order,
  ).length;
}
