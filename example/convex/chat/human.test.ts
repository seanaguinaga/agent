import { expect, test } from "vitest";
import { createThread, saveMessages } from "@convex-dev/agent";
import { api, components } from "../_generated/api";
import { initConvexTest } from "../setup.test";

async function setup() {
  const t = initConvexTest();
  const threadId = await t.mutation(api.threads.createNewThread, {
    title: "Support",
  });
  return { t, threadId };
}

test("human replies are separate assistant turns and blank replies are rejected", async () => {
  const { t, threadId } = await setup();
  await t.mutation(api.chat.human.sendMessageFromUser, {
    threadId,
    message: "Hello",
  });
  await t.mutation(api.chat.human.reply, {
    threadId,
    agentName: "Sam",
    message: "How can I help?",
  });
  const messages = await t.query(api.chat.basic.listThreadMessages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(messages.page.map((m) => m.message?.role)).toEqual([
    "assistant",
    "user",
  ]);
  expect(messages.page[0].agentName).toBe("Sam");
  await expect(
    t.mutation(api.chat.human.reply, {
      threadId,
      agentName: "Sam",
      message: " ",
    }),
  ).rejects.toThrow(/required/);
});

test("human tool responses resume once after all parallel requests and reject replays or foreign calls", async () => {
  const { t, threadId } = await setup();
  await t.run(async (ctx) => {
    await saveMessages(ctx, components.agent, {
      threadId,
      messages: [
        { role: "user", content: "Ask support" },
        {
          role: "assistant",
          content: ["a", "b"].map((toolCallId) => ({
            type: "tool-call",
            toolName: "askHuman",
            toolCallId,
            input: { question: "Help?" },
          })),
        },
      ],
    });
  });
  const respond = (toolCallId: string, id = threadId) =>
    t.mutation(api.chat.human.respondToTool, {
      threadId: id,
      humanName: "Sam",
      response: "Yes",
      toolCallId,
    });
  const scheduled = () =>
    t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  await expect(respond("missing")).rejects.toThrow(/missing/);
  const other = await t.run((ctx) => createThread(ctx, components.agent, {}));
  await expect(respond("a", other)).rejects.toThrow(/missing/);
  await respond("a");
  expect(await scheduled()).toHaveLength(0);
  await expect(respond("a")).rejects.toThrow(/already answered/);
  await respond("b");
  expect(await scheduled()).toHaveLength(1);
  await expect(respond("b")).rejects.toThrow(/already answered/);
  expect(await scheduled()).toHaveLength(1);
});
