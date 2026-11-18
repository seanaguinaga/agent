import { expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { initConvexTest } from "../setup.test";
import { languageModel } from "../modelsForDemo";

vi.mock("../modelsForDemo", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const languageModel = new MockLanguageModelV4();
  languageModel.doGenerate = vi.fn();
  return { languageModel, embeddingModel: undefined };
});

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

test("the support agent waits for a real reply and resumes with the same inbox instructions and human answer", async () => {
  const generate = vi.mocked(languageModel.doGenerate);
  generate.mockResolvedValueOnce({
    content: [
      {
        type: "tool-call",
        toolCallId: "support",
        toolName: "askHuman",
        input: JSON.stringify({ question: "Can this customer get a refund?" }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  });
  generate.mockResolvedValueOnce({
    content: [
      {
        type: "text",
        text: "Support needs your purchase date to check eligibility.",
      },
    ],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  });
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {
    title: "Support test",
  });
  await t.action(api.chat.human.ask, {
    threadId,
    question: "Please ask a human about a refund",
  });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(
    await t.query(api.chat.human.listPendingRequests, { threadId }),
  ).toHaveLength(1);
  await t.mutation(api.chat.human.respondToTool, {
    threadId,
    toolCallId: "support",
    humanName: "Sam",
    response: "Ask the customer for their purchase date.",
  });
  await t.finishAllScheduledFunctions(() => {});
  expect(generate).toHaveBeenCalledTimes(2);
  for (const [options] of generate.mock.calls) {
    expect(
      options.prompt.find((message) => message.role === "system")?.content,
    ).toContain("working human-support inbox");
    expect(
      options.tools?.some(
        (tool) => tool.type === "function" && tool.name === "askHuman",
      ),
    ).toBe(true);
  }
  expect(JSON.stringify(generate.mock.calls[1][0].prompt)).toContain(
    "Ask the customer for their purchase date.",
  );
  const messages = await t.query(api.chat.basic.listThreadMessages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(messages.page[0].text).toBe(
    "Support needs your purchase date to check eligibility.",
  );
  expect(
    await t.query(api.chat.human.listPendingRequests, { threadId }),
  ).toEqual([]);
});
