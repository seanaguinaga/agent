/// <reference types="vite/client" />
import { expect, test, vi } from "vitest";
import { api } from "../_generated/api.js";
import { languageModel } from "../modelsForDemo";
import { initConvexTest } from "../setup.test.js";

vi.mock("../modelsForDemo", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  const languageModel = new MockLanguageModelV4();
  languageModel.doGenerate = vi.fn();
  return { languageModel, embeddingModel: undefined };
});

const reply = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
  },
  warnings: [],
});

test("orchestration preserves the planned agent handoff", async () => {
  vi.mocked(languageModel.doGenerate)
    .mockResolvedValueOnce(reply("plan"))
    .mockResolvedValueOnce(reply("analysis"))
    .mockResolvedValueOnce(reply("critique"))
    .mockResolvedValueOnce(reply("answer"));

  const result = await initConvexTest().action(
    api.workflows.coordination.orchestrate,
    { prompt: "Plan a small release" },
  );

  expect(result.steps).toEqual([
    { agent: "coordinator", output: "plan" },
    { agent: "analyst", output: "analysis" },
    { agent: "critic", output: "critique" },
    { agent: "coordinator", output: "answer" },
  ]);
});
