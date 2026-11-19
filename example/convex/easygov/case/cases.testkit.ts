// Shared by the easygov tests: start a case, send it things, and a mock model
// for the agents. The extra dot keeps Convex from deploying this file.
//
// Every test file that runs a case must mock the model itself, because
// `vi.mock` only works from a test file:
//
//   vi.mock("../../modelsForDemo", async () =>
//     (await import("./cases.testkit")).mockModels(),
//   );
import { listMessages } from "@convex-dev/agent";
import { vi } from "vitest";
import { api, components } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { initConvexTest } from "../../setup.test";
import { seedPacks } from "../packs/packs.testkit";
import type { CaseEvent } from "./schema";

export type T = ReturnType<typeof initConvexTest>;

/**
 * The agents call a mock model. Each call answers with the next queued JSON
 * reply. With the queue empty it answers as if every request were the IRS 8822
 * one: the request (federal, form IRS-8822) and, when comparing candidates,
 * the first. `start` seeds that pack, so selection proposes it.
 */
export const model = { replies: [] as string[] };
const IRS_8822_PROPOSAL = JSON.stringify({
  kind: "process",
  message: "This looks like an IRS change of address.",
  jurisdiction: "us",
  authority: "Internal Revenue Service",
  forms: ["IRS-8822"],
  searchTerms: "change of address",
  choice: 1,
});

/** The stand-in for `modelsForDemo`. */
export async function mockModels() {
  const { MockLanguageModelV4 } = await import("ai/test");
  const languageModel = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        { type: "text", text: model.replies.shift() ?? IRS_8822_PROPOSAL },
      ],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  return { languageModel, embeddingModel: undefined };
}

/** Call from `afterEach`. */
export function resetCases() {
  vi.useRealTimers();
  model.replies = [];
}

export async function start() {
  vi.useFakeTimers();
  const t = initConvexTest();
  await seedPacks(t);
  const caseId = await t.mutation(api.easygov.case.public.startCase, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, caseId };
}

export const read = (t: T, caseId: Id<"cases">) =>
  t.query(api.easygov.case.public.getCase, { caseId });

/** Sends an event with the current seq, then lets the workflows settle. */
export async function send(t: T, caseId: Id<"cases">, event: CaseEvent) {
  const { seq } = await read(t, caseId);
  await t.mutation(api.easygov.case.public.send, {
    caseId,
    event,
    expectedSeq: seq,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return await read(t, caseId);
}

export async function answer(t: T, caseId: Id<"cases">, answers: object) {
  for (const [key, value] of Object.entries(answers)) {
    await send(t, caseId, { type: "answers.set", key, value });
  }
  return await read(t, caseId);
}

let messageKeys = 0;

/** Sends a chat message, then lets the workflows settle. */
export async function chat(t: T, caseId: Id<"cases">, text: string) {
  const messageKey = `message-${++messageKeys}`;
  await t.mutation(api.easygov.case.public.sendMessage, {
    caseId,
    text,
    messageKey,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return await read(t, caseId);
}

/** The case's thread, oldest first, as `[role, text]` pairs. */
export async function texts(t: T, caseId: Id<"cases">) {
  const { threadId } = await read(t, caseId);
  const { page } = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    }),
  );
  return page.reverse().map((m) => [m.message?.role, m.text]);
}
