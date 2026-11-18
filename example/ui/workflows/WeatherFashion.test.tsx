// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UIMessage } from "@convex-dev/agent/react";
import { groupTurns, parseOutfit, replyView } from "./turns";
import { WorkflowThread } from "./WeatherFashion";

const state = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  workflow: undefined as unknown,
  /** What `replyError` answers for a failed reply. */
  replyError: null as string | null,
  /** [function name, args] for every mutation the page calls. */
  calls: [] as [string, unknown][],
}));
vi.mock("@convex-dev/agent/react", () => ({
  useUIMessages: () => ({
    results: state.messages,
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
  useSmoothText: (text: string) => [text],
  optimisticallySendMessage: () => () => {},
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      args === "skip"
        ? undefined
        : getFunctionName(ref) === "workflows/weatherFashion:replyError"
          ? state.replyError
          : state.workflow,
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const call = (args: unknown) => {
        state.calls.push([getFunctionName(ref), args]);
        return Promise.resolve(null);
      };
      return Object.assign(call, { withOptimisticUpdate: () => call });
    },
  };
});
vi.mock("convex-helpers/react", () => ({ usePaginatedQuery: vi.fn() }));
beforeEach(() => {
  state.messages = [];
  state.workflow = { type: "completed" };
  state.replyError = null;
  state.calls = [];
});
afterEach(cleanup);

let n = 0;
function msg(
  fields: Partial<UIMessage> & Pick<UIMessage, "role" | "order">,
): UIMessage {
  n++;
  return {
    id: `m${n}`,
    key: `k${n}`,
    stepOrder: n,
    status: "success",
    _creationTime: n,
    text: "",
    parts: fields.text ? [{ type: "text", text: fields.text }] : [],
    ...fields,
  };
}

const outfit = {
  hat: "beanie",
  tops: "parka",
  bottoms: "lined trousers",
  shoes: "boots",
};
const forecast = [
  msg({ role: "user", order: 0, text: "What is the weather in Oslo?" }),
  msg({
    role: "assistant",
    order: 0,
    agentName: "Weather Agent",
    parts: [
      {
        type: "tool-getWeather",
        toolCallId: "w",
        state: "output-available",
        input: {},
        output: {
          temperature: "18°F",
          feelsLike: "7°F",
          windSpeed: "12 mph",
          windGust: "21 mph",
          description: "Snowing",
        },
      },
      { type: "text", text: "It's 18°F and snowing." },
    ],
    text: "It's 18°F and snowing.",
  }),
];
const fashionQuestion = msg({
  role: "user",
  order: 1,
  text: "What should I wear based on the weather?",
});
/** What useUIMessages delivers after retries: one merged, failed reply. */
const failedFashion = msg({ role: "assistant", order: 1, status: "failed" });
const outfitReply = msg({
  role: "assistant",
  order: 1,
  agentName: "Fashion Agent",
  text: JSON.stringify(outfit),
});

test("groupTurns pairs each prompt with its latest reply", () => {
  const turns = groupTurns([...forecast, fashionQuestion, failedFashion, outfitReply]);
  expect(turns.map((t) => [t.prompt?.text, t.reply?.id])).toEqual([
    ["What is the weather in Oslo?", forecast[1]!.id],
    ["What should I wear based on the weather?", outfitReply.id],
  ]);
});

test("replyView: a failed attempt stays quiet while the workflow can retry it", () => {
  const turn = { order: 1, prompt: fashionQuestion, reply: failedFashion };
  expect(replyView(turn, { isLatest: true, workflowRunning: true })).toEqual({
    kind: "working",
  });
  expect(replyView(turn, { isLatest: true, workflowRunning: false })).toEqual({
    kind: "failed",
    message: undefined,
  });
  // Partial text from a stopped or broken answer stays on screen.
  const partial = { ...failedFashion, text: "Wear a" };
  expect(
    replyView({ ...turn, reply: partial }, { isLatest: true, workflowRunning: false }),
  ).toEqual({ kind: "failed", message: partial });
  expect(replyView({ order: 2 }, { isLatest: true, workflowRunning: false })).toEqual({
    kind: "working",
  });
});

test("parseOutfit accepts only the outfit shape", () => {
  expect(parseOutfit(JSON.stringify(outfit))).toEqual(outfit);
  expect(parseOutfit('{"suggestion":"a hat"}')).toBeUndefined();
  expect(parseOutfit("It's snowing")).toBeUndefined();
});

test("while the workflow retries, the page shows work in progress, not errors", () => {
  state.workflow = { type: "inProgress" };
  state.messages = [...forecast, fashionQuestion, failedFashion];
  render(<WorkflowThread threadId="t" />);

  expect(screen.getByText(/Weather: 18°F \(feels like 7°F\), Snowing/)).toBeTruthy();
  expect(screen.getByText("Working…")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/attempt/i)).toBeNull();
});

test("once the workflow gives up: one plain error, details on request, Retry", () => {
  state.workflow = {
    type: "failed",
    error: "Error: No object generated: response did not match schema.",
  };
  state.messages = [...forecast, fashionQuestion, failedFashion];
  render(<WorkflowThread threadId="t" />);

  expect(screen.getByRole("alert").textContent).toBe("Couldn't finish this answer.");
  expect(screen.getByText("Details")).toBeTruthy();
  expect(screen.getByText(/did not match schema/)).toBeTruthy();
  expect(screen.queryByLabelText("Follow-up question")).toBeNull();

  fireEvent.click(screen.getByText("Retry"));
  expect(state.calls).toEqual([
    ["workflows/weatherFashion:retryWorkflow", { threadId: "t" }],
  ]);
});

test("a failed follow-up keeps its partial answer and retries the same question", () => {
  const followUp = msg({ role: "user", order: 2, text: "What about gloves?" });
  state.messages = [
    ...forecast,
    fashionQuestion,
    outfitReply,
    followUp,
    msg({ role: "assistant", order: 2, status: "failed", text: "Wool gloves are" }),
  ];
  render(<WorkflowThread threadId="t" />);

  expect(screen.getByText("Wool gloves are")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("This answer didn't finish.");
  expect(screen.queryByText("Details")).toBeNull();

  fireEvent.click(screen.getByText("Retry"));
  expect(state.calls).toEqual([
    [
      "workflows/weatherFashion:retryFollowUp",
      { threadId: "t", promptMessageId: followUp.id },
    ],
  ]);
});

test("a streaming answer can be stopped", () => {
  state.messages = [
    ...forecast,
    fashionQuestion,
    outfitReply,
    msg({ role: "user", order: 2, text: "What about gloves?" }),
    msg({ role: "assistant", order: 2, status: "streaming", text: "Wool" }),
  ];
  render(<WorkflowThread threadId="t" />);

  fireEvent.click(screen.getByText("Stop"));
  expect(state.calls).toEqual([
    ["chat/streamAbort:abortStreamByOrder", { threadId: "t", order: 2 }],
  ]);
});

test("a failed follow-up says why under Details", () => {
  state.messages = [
    ...forecast,
    fashionQuestion,
    outfitReply,
    msg({ role: "user", order: 2, text: "What about gloves?" }),
    msg({ role: "assistant", order: 2, status: "failed" }),
  ];
  state.replyError = "Provider is down";
  render(<WorkflowThread threadId="t" />);

  expect(screen.getByText("Details")).toBeTruthy();
  expect(screen.getByText("Provider is down")).toBeTruthy();
});

test("a finished workflow shows the outfit card and takes follow-ups", () => {
  state.messages = [...forecast, fashionQuestion, outfitReply];
  render(<WorkflowThread threadId="t" />);

  expect(screen.getByLabelText("Outfit").textContent).toContain("parka");
  expect(screen.queryByText("Stop")).toBeNull();

  fireEvent.change(screen.getByLabelText("Follow-up question"), {
    target: { value: "What about gloves?" },
  });
  fireEvent.click(screen.getByText("Send"));
  expect(state.calls).toEqual([
    [
      "workflows/weatherFashion:askFollowUp",
      { threadId: "t", prompt: "What about gloves?" },
    ],
  ]);
});

test("reasoning from a thinking model is tucked behind a toggle", () => {
  state.messages = [
    msg({ role: "user", order: 0, text: "Q" }),
    msg({
      role: "assistant",
      order: 0,
      text: "A",
      parts: [
        { type: "reasoning", text: "Snow means boots." },
        { type: "text", text: "A" },
      ],
    }),
  ];
  render(<WorkflowThread threadId="t" />);
  expect(screen.getByText("Thinking")).toBeTruthy();
  expect(screen.getByText("Snow means boots.")).toBeTruthy();
});
