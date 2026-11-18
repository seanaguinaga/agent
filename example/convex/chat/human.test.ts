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
  await expect(respond("a", other)).rejects.toThrow(/Unauthorized/);
  await respond("a");
  expect(await scheduled()).toHaveLength(0);
  await expect(respond("a")).rejects.toThrow(/already answered/);
  await respond("b");
  expect(await scheduled()).toHaveLength(1);
  await expect(respond("b")).rejects.toThrow(/already answered/);
  expect(await scheduled()).toHaveLength(1);
});

test("the inbox includes existing calls across owned conversations and removes only answered requests", async () => {
  const { t, threadId } = await setup();
  const second = await t.mutation(api.threads.createNewThread, {
    title: "Other conversation",
  });
  const foreign = await t.run((ctx) =>
    createThread(ctx, components.agent, { userId: "another user" }),
  );
  await t.run(async (ctx) => {
    for (const id of [threadId, second, foreign]) {
      await saveMessages(ctx, components.agent, {
        threadId: id,
        messages: [
          { role: "user", content: "Ask support" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolName: "askHuman",
                toolCallId: `call-${id}`,
                input: { question: `Help with ${id}?` },
              },
            ],
          },
        ],
      });
    }
  });
  const args = { paginationOpts: { cursor: null, numItems: 10 } };
  expect(
    (await t.query(api.chat.human.listInbox, args)).page
      .map((r) => r.threadId)
      .sort(),
  ).toEqual([threadId, second].sort());
  await expect(
    t.query(api.chat.human.listPendingRequests, { threadId: foreign }),
  ).rejects.toThrow(/Unauthorized/);
  await expect(
    t.mutation(api.chat.human.respondToTool, {
      threadId: foreign,
      toolCallId: `call-${foreign}`,
      humanName: "Sam",
      response: "No",
    }),
  ).rejects.toThrow(/Unauthorized/);
  await t.mutation(api.chat.human.reply, {
    threadId,
    agentName: "Sam",
    message: "An ordinary support message",
  });
  expect(
    await t.query(api.chat.human.listPendingRequests, { threadId }),
  ).toHaveLength(1);
  await t.mutation(api.chat.human.respondToTool, {
    threadId,
    toolCallId: `call-${threadId}`,
    humanName: "Sam",
    response: "Yes",
  });
  expect(
    (await t.query(api.chat.human.listInbox, args)).page.map((r) => r.threadId),
  ).toEqual([second]);
});

test("requests older than 100 messages can be found and answered in their original turn", async () => {
  const { t, threadId } = await setup();
  await t.run(async (ctx) => {
    await saveMessages(ctx, components.agent, {
      threadId,
      messages: [
        { role: "user", content: "Ask support" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "askHuman",
              toolCallId: "old-call",
              input: { question: "Old request" },
            },
          ],
        },
      ],
    });
    await saveMessages(ctx, components.agent, {
      threadId,
      messages: Array.from({ length: 120 }, (_, i) => ({
        role: "user" as const,
        content: `Later message ${i}`,
      })),
    });
  });
  const [request] = await t.query(api.chat.human.listPendingRequests, {
    threadId,
  });
  expect(request.question).toBe("Old request");
  await t.mutation(api.chat.human.respondToTool, {
    threadId,
    toolCallId: "old-call",
    humanName: "Sam",
    response: "Old answer",
  });
  expect(
    await t.query(api.chat.human.listPendingRequests, { threadId }),
  ).toEqual([]);
  const messages = await t.query(api.chat.basic.listThreadMessages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 200 },
  });
  expect(messages.page.find((m) => m.message?.role === "tool")?.order).toBe(
    request.order,
  );
});

test("inbox pagination can continue past conversations with no requests", async () => {
  const { t, threadId } = await setup();
  await t.run((ctx) =>
    saveMessages(ctx, components.agent, {
      threadId,
      messages: [
        { role: "user", content: "Help" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "askHuman",
              toolCallId: "call",
              input: { question: "Question" },
            },
          ],
        },
      ],
    }),
  );
  await t.mutation(api.threads.createNewThread, {
    title: "New empty conversation",
  });
  const first = await t.query(api.chat.human.listInbox, {
    paginationOpts: { cursor: null, numItems: 1 },
  });
  expect(first.page).toEqual([]);
  expect(first.isDone).toBe(false);
  const second = await t.query(api.chat.human.listInbox, {
    paginationOpts: { cursor: first.continueCursor, numItems: 1 },
  });
  expect(second.page[0].question).toBe("Question");
});

test("deleting dismisses only the chosen request and resumes once the remaining request is answered", async () => {
  const { t, threadId } = await setup();
  await t.run((ctx) =>
    saveMessages(ctx, components.agent, {
      threadId,
      messages: [
        { role: "user", content: "Two questions" },
        {
          role: "assistant",
          content: ["a", "b"].map((toolCallId) => ({
            type: "tool-call",
            toolName: "askHuman",
            toolCallId,
            input: { question: toolCallId },
          })),
        },
      ],
    }),
  );
  await t.mutation(api.chat.human.deleteRequest, { threadId, toolCallId: "a" });
  expect(
    (await t.query(api.chat.human.listPendingRequests, { threadId })).map(
      (r) => r.toolCallId,
    ),
  ).toEqual(["b"]);
  expect(
    await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  ).toHaveLength(0);
  const history = await t.query(api.chat.basic.listThreadMessages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(history.page.some((m) => m.message?.role === "user")).toBe(true);
  expect(history.page.some((m) => m.message?.role === "assistant")).toBe(true);
  expect(
    history.page.find((m) => m.message?.role === "tool")?.message?.content,
  ).toMatchObject([
    { type: "tool-result", toolCallId: "a", output: { type: "error-text" } },
  ]);
  await expect(
    t.mutation(api.chat.human.deleteRequest, { threadId, toolCallId: "a" }),
  ).rejects.toThrow(/already answered/);
  const foreign = await t.run((ctx) =>
    createThread(ctx, components.agent, { userId: "another user" }),
  );
  await expect(
    t.mutation(api.chat.human.deleteRequest, {
      threadId: foreign,
      toolCallId: "b",
    }),
  ).rejects.toThrow(/Unauthorized/);
  await t.mutation(api.chat.human.respondToTool, {
    threadId,
    toolCallId: "b",
    humanName: "Sam",
    response: "Yes",
  });
  expect(
    await t.query(api.chat.human.listPendingRequests, { threadId }),
  ).toEqual([]);
  expect(
    await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  ).toHaveLength(1);
});

test("deleting a conversation removes its messages and inbox requests without affecting other threads", async () => {
  const { t, threadId } = await setup();
  const other = await t.mutation(api.threads.createNewThread, {
    title: "Keep this",
  });
  await t.run((ctx) =>
    saveMessages(ctx, components.agent, {
      threadId,
      messages: [
        { role: "user", content: "Help" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "askHuman",
              toolCallId: "call",
              input: { question: "Help?" },
            },
          ],
        },
        ...Array.from({ length: 120 }, (_, i) => ({
          role: "user" as const,
          content: `Later message ${i}`,
        })),
      ],
    }),
  );
  const foreign = await t.run((ctx) =>
    createThread(ctx, components.agent, { userId: "another user" }),
  );
  await expect(
    t.mutation(api.chat.human.deleteConversation, { threadId: foreign }),
  ).rejects.toThrow(/Unauthorized/);
  await t.mutation(api.chat.human.deleteConversation, { threadId });
  await t.finishAllScheduledFunctions(() => {});
  expect(
    await t.query(components.agent.threads.getThread, { threadId }),
  ).toBeNull();
  expect(
    await t.query(api.chat.human.listPendingRequests, { threadId }),
  ).toEqual([]);
  expect(
    await t.query(api.chat.human.getMessages, {
      threadId,
      paginationOpts: { cursor: null, numItems: 20 },
      streamArgs: { kind: "list" },
    }),
  ).toMatchObject({
    page: [],
    isDone: true,
    streams: { kind: "list", messages: [] },
  });
  expect(
    await t.query(components.agent.threads.getThread, { threadId: other }),
  ).not.toBeNull();
  expect(
    (
      await t.query(components.agent.messages.listMessagesByThreadId, {
        threadId,
        order: "asc",
        paginationOpts: { cursor: null, numItems: 200 },
      })
    ).page,
  ).toEqual([]);
  expect(
    (
      await t.query(api.chat.human.listInbox, {
        paginationOpts: { cursor: null, numItems: 10 },
      })
    ).page,
  ).toEqual([]);
});
