// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UIMessage } from "@convex-dev/agent/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Transcript from "./Transcript";
const state = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  cancel: vi.fn(),
}));
vi.mock("@convex-dev/agent/react", () => ({
  useUIMessages: () => ({
    results: state.messages,
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
}));
vi.mock("convex/react", () => ({ useMutation: () => state.cancel }));
beforeEach(() => {
  state.cancel.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function message(parts: UIMessage["parts"]): UIMessage {
  return {
    id: "message",
    key: "message",
    role: "assistant",
    order: 0,
    stepOrder: 0,
    status: "success",
    _creationTime: 1,
    text: "",
    parts,
  };
}
const waiting: UIMessage["parts"] = [
  { type: "step-start" },
  {
    type: "tool-askHuman",
    toolCallId: "call",
    state: "input-available",
    input: {
      question: "Private staff question: please check refund eligibility.",
    },
  },
];

test("pending handoffs show a compact status with cancel and keep staff questions and technical data out of chat", () => {
  state.messages = [message(waiting)];
  render(<Transcript threadId="thread" />);
  expect(screen.getByText("Waiting for support")).toBeTruthy();
  expect(
    screen.getByText(
      "Your question is in the support inbox. Their reply will appear here.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel request" })).toBeTruthy();
  expect(screen.queryByText(/Private staff question/)).toBeNull();
  expect(screen.queryByText("Technical details")).toBeNull();
  expect(screen.queryByText("step-start")).toBeNull();
  expect(screen.queryByText("success")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("completed handoffs show the actual support reply and assistant continuation", () => {
  state.messages = [
    message([
      {
        type: "tool-askHuman",
        toolCallId: "call",
        state: "output-available",
        input: { question: "Staff-only question" },
        output: "Please provide the purchase date.",
      },
      { type: "text", text: "Support needs your purchase date." },
    ]),
  ];
  render(<Transcript threadId="thread" />);
  expect(screen.getByText("Support replied")).toBeTruthy();
  expect(screen.getByText("Please provide the purchase date.")).toBeTruthy();
  expect(screen.getByText("Support needs your purchase date.")).toBeTruthy();
  expect(screen.queryByText("Staff-only question")).toBeNull();
  expect(screen.queryByText("Technical details")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
});

test("cancellation errors stay on the status card and allow retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.cancel.mockRejectedValueOnce(new Error("offline"));
  state.messages = [message(waiting)];
  const view = render(<Transcript threadId="thread" />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Waiting for support")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(state.cancel).toHaveBeenCalledWith({
    threadId: "thread",
    toolCallId: "call",
  });
  expect(state.cancel).toHaveBeenCalledTimes(2);
  state.messages = [
    message([
      {
        type: "tool-askHuman",
        toolCallId: "call",
        state: "output-error",
        input: { question: "Staff-only question" },
        errorText: "The human request was cancelled without an answer.",
      },
    ]),
  ];
  view.rerender(<Transcript threadId="thread" />);
  expect(screen.getByText("Support request closed")).toBeTruthy();
  expect(screen.getByText("No support answer was supplied.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
});
