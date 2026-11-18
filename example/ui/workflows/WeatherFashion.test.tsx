// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UIMessage } from "@convex-dev/agent/react";
import { groupTurns, parseOutfit } from "./turns";
import { WorkflowThread } from "./WeatherFashion";

const state = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  askFollowUp: vi.fn(),
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
vi.mock("convex/react", () => ({
  useMutation: () =>
    Object.assign(state.askFollowUp, { withOptimisticUpdate: () => state.askFollowUp }),
}));
vi.mock("convex-helpers/react", () => ({ usePaginatedQuery: vi.fn() }));
beforeEach(() => {
  state.messages = [];
  state.askFollowUp.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

let n = 0;
function msg(fields: Partial<UIMessage> & Pick<UIMessage, "role" | "order">): UIMessage {
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

const outfit = { hat: "beanie", tops: "parka", bottoms: "lined trousers", shoes: "boots" };
const failedAttempt = { type: "data-failedAttempt", data: null } as const;

/**
 * The thread from the screenshot: a forecast, then a fashion step tried four
 * times. `useUIMessages` merges the attempts and keeps each failure part.
 */
function retriedWorkflow(finalStatus: "success" | "failed") {
  return [
    msg({ role: "user", order: 0, text: "What is the weather in Oslo?" }),
    msg({
      role: "assistant",
      order: 0,
      agentName: "Weather Agent",
      text: "It's 18°F and snowing.",
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
    }),
    msg({ role: "user", order: 1, text: "What should I wear based on the weather?" }),
    finalStatus === "success"
      ? msg({
          role: "assistant",
          order: 1,
          agentName: "Fashion Agent",
          text: JSON.stringify(outfit),
          parts: [
            failedAttempt,
            failedAttempt,
            failedAttempt,
            { type: "text", text: JSON.stringify(outfit) },
          ],
        })
      : msg({
          role: "assistant",
          order: 1,
          status: "failed",
          parts: [failedAttempt, failedAttempt, failedAttempt, failedAttempt],
        }),
  ];
}

test("retries show as one answer with the earlier failures listed", () => {
  const [, fashion] = groupTurns(retriedWorkflow("success"));
  expect(fashion!.earlierFailures).toBe(3);
  expect(fashion!.replies.map((r) => r.status)).toEqual(["success"]);
});

test("if every attempt failed, the latest failure is the answer", () => {
  const [, fashion] = groupTurns(retriedWorkflow("failed"));
  expect(fashion!.earlierFailures).toBe(3);
  expect(fashion!.replies.map((r) => r.status)).toEqual(["failed"]);
});

test("unmerged failed attempts are hidden behind the latest reply", () => {
  const turns = groupTurns([
    msg({ role: "user", order: 0, text: "Q" }),
    msg({ role: "assistant", order: 0, status: "failed", parts: [failedAttempt] }),
    msg({ role: "assistant", order: 0, text: "A" }),
  ]);
  expect(turns[0]!.replies.map((r) => r.text)).toEqual(["A"]);
  expect(turns[0]!.earlierFailures).toBe(1);
});

test("parseOutfit accepts only the outfit shape", () => {
  expect(parseOutfit(JSON.stringify(outfit))).toEqual(outfit);
  expect(parseOutfit('{"suggestion":"a hat"}')).toBeUndefined();
  expect(parseOutfit("It's snowing")).toBeUndefined();
});

test("renders tool steps, an outfit card and one line for the retries", () => {
  state.messages = retriedWorkflow("success");
  render(<WorkflowThread threadId="t" />);

  expect(screen.getByText(/Weather: 18°F \(feels like 7°F\), Snowing/)).toBeTruthy();
  expect(screen.getByText("3 earlier attempts failed")).toBeTruthy();
  const card = screen.getByLabelText("Outfit");
  expect(card.textContent).toContain("parka");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a failed latest attempt shows an alert and no follow-up box", () => {
  state.messages = retriedWorkflow("failed");
  render(<WorkflowThread threadId="t" />);

  expect(screen.getByRole("alert").textContent).toContain("This attempt failed.");
  expect(screen.getByText("3 earlier attempts failed")).toBeTruthy();
  expect(screen.queryByLabelText("Follow-up question")).toBeNull();
});

test("follow-ups are sent once there is an outfit", () => {
  state.messages = retriedWorkflow("success");
  render(<WorkflowThread threadId="t" />);

  fireEvent.change(screen.getByLabelText("Follow-up question"), {
    target: { value: "What about gloves?" },
  });
  fireEvent.click(screen.getByText("Send"));
  expect(state.askFollowUp).toHaveBeenCalledWith({
    threadId: "t",
    prompt: "What about gloves?",
  });
});

test("a question with no reply yet shows that work is in progress", () => {
  state.messages = [msg({ role: "user", order: 0, text: "What is the weather in Oslo?" })];
  render(<WorkflowThread threadId="t" />);
  expect(screen.getByRole("status").textContent).toBe("Working…");
});
