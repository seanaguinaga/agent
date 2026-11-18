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
import ChatApproval from "./ChatApproval";

const controls = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  send: vi.fn(),
  decide: vi.fn(),
}));
vi.mock("../hooks/use-demo-thread", () => ({
  useDemoThread: () => ({ threadId: "thread", resetThread: vi.fn() }),
}));
vi.mock("@convex-dev/agent/react", () => ({
  useUIMessages: () => ({
    results: controls.messages,
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
  optimisticallySendMessage: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useMutation: () =>
    Object.assign(controls.decide, {
      withOptimisticUpdate: () => controls.send,
    }),
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  controls.messages = [
    {
      id: "assistant",
      key: "assistant",
      role: "assistant",
      text: "",
      status: "success",
      order: 1,
      stepOrder: 0,
      _creationTime: 1,
      parts: [
        {
          type: "tool-deleteFile",
          toolCallId: "call",
          input: { filename: "example.txt" },
          state: "approval-requested",
          approval: { id: "approval" },
        },
      ],
    },
  ];
  controls.decide.mockResolvedValue(undefined);
  controls.send.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("keeps a failed approval local and allows retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  controls.decide.mockRejectedValueOnce(new Error("offline"));
  render(<ChatApproval />);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain(
    "Could not save your decision",
  );
  expect(screen.getByText("Tool Approval Example")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(controls.decide).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("prevents another decision while the first is saving", async () => {
  const saved = Promise.withResolvers<void>();
  controls.decide.mockReturnValueOnce(saved.promise);
  render(<ChatApproval />);
  const approve = screen.getByRole("button", { name: "Approve" });
  fireEvent.click(approve);
  expect(approve.hasAttribute("disabled")).toBe(true);
  fireEvent.click(approve);
  expect(controls.decide).toHaveBeenCalledTimes(1);
  saved.resolve();
  await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
});

test("submits the denial reason with the rejected decision", async () => {
  render(<ChatApproval />);
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  fireEvent.change(screen.getByPlaceholderText("Reason for denial..."), {
    target: { value: "Keep the file" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  await waitFor(() =>
    expect(controls.decide).toHaveBeenCalledWith({
      threadId: "thread",
      approvalId: "approval",
      approved: false,
      reason: "Keep the file",
    }),
  );
});

test("shows a failed generation instead of an endless placeholder", () => {
  controls.messages = [
    { ...controls.messages[0], status: "failed", parts: [] },
  ];
  render(<ChatApproval />);
  expect(screen.getByRole("alert").textContent).toContain("Generation failed");
  expect(screen.queryByText("...")).toBeNull();
});
