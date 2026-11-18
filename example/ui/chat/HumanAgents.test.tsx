// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { getFunctionName } from "convex/server";
import HumanAgents from "./HumanAgents";

const controls = vi.hoisted(() => ({
  respond: vi.fn(),
  cancel: vi.fn(),
  removeConversation: vi.fn(),
  ask: vi.fn(),
  saveUser: vi.fn(),
  loadMore: vi.fn(),
  status: "Exhausted",
  empty: false,
}));
vi.mock("convex/react", () => ({
  useAction: () => controls.ask,
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference).split(":").at(-1);
    if (name === "respondToTool") return controls.respond;
    if (name === "deleteRequest") return controls.cancel;
    if (name === "deleteConversation") return controls.removeConversation;
    if (name === "sendMessageFromUser") return controls.saveUser;
    return vi.fn();
  },
  usePaginatedQuery: () => ({
    results: controls.empty
      ? []
      : [
          {
            threadId: "thread",
            threadTitle: "Refund conversation",
            toolCallId: "call",
            question: "Can I get a refund?",
            createdAt: 1,
          },
        ],
    status: controls.status,
    loadMore: controls.loadMore,
  }),
  useQuery: () => [{ toolCallId: "call", question: "Can I get a refund?" }],
}));
vi.mock("./Transcript", () => ({
  default: () => <div>Conversation transcript</div>,
}));
beforeEach(() => {
  vi.clearAllMocks();
  for (const command of [
    controls.respond,
    controls.cancel,
    controls.removeConversation,
    controls.ask,
  ])
    command.mockResolvedValue(undefined);
  controls.status = "Exhausted";
  controls.empty = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function page(path = "/chat-human?thread=thread") {
  return (
    <MemoryRouter initialEntries={[path]}>
      <HumanAgents />
    </MemoryRouter>
  );
}

test("customer messages invoke the AI by default", async () => {
  render(page());
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Please ask a human about my refund" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
  await waitFor(() =>
    expect(controls.ask).toHaveBeenCalledWith({
      threadId: "thread",
      question: "Please ask a human about my refund",
    }),
  );
  expect(controls.saveUser).not.toHaveBeenCalled();
});

test("empty inbox pages load automatically and do not claim the inbox is empty before the search finishes", async () => {
  controls.status = "CanLoadMore";
  controls.empty = true;
  const view = render(page("/chat-human"));
  await waitFor(() => expect(controls.loadMore).toHaveBeenCalledWith(10));
  expect(screen.getByText("Finding support requests…")).toBeTruthy();
  expect(screen.queryByText("No requests waiting for a human.")).toBeNull();
  expect(screen.queryByText("Check more conversations")).toBeNull();
  controls.status = "Exhausted";
  controls.empty = false;
  view.rerender(page("/chat-human"));
  expect(screen.getByRole("link", { name: /Can I get a refund/ })).toBeTruthy();
});

test("selecting a request opens context and its reply form inside the inbox", async () => {
  render(page("/chat-human"));
  fireEvent.click(screen.getByRole("link", { name: /Can I get a refund/ }));
  expect(screen.getByText("Conversation transcript")).toBeTruthy();
  const inbox = screen.getByRole("region", { name: "Human inbox" });
  const response = within(inbox).getByLabelText("Your reply");
  expect(
    within(inbox).getByRole("form", { name: "Support reply" }),
  ).toBeTruthy();
  expect(
    response.compareDocumentPosition(screen.getByLabelText("Message")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.change(response, {
    target: { value: "Please provide your purchase date." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  await waitFor(() =>
    expect(controls.respond).toHaveBeenCalledWith({
      threadId: "thread",
      toolCallId: "call",
      humanName: "Support agent",
      response: "Please provide your purchase date.",
    }),
  );
});

test("a failed support reply preserves both drafts for retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  controls.respond.mockRejectedValueOnce(new Error("offline"));
  render(page());
  fireEvent.change(screen.getByLabelText("Your reply"), {
    target: { value: "Keep my reply" },
  });
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Keep my message" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("Your reply") as HTMLTextAreaElement).value,
  ).toBe("Keep my reply");
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
    "Keep my message",
  );
  fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(controls.respond).toHaveBeenCalledTimes(2);
});

test("delete conversation targets the thread and clears selection only after a successful retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  controls.removeConversation.mockRejectedValueOnce(new Error("offline"));
  render(page());
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: "Keep this draft" },
  });
  fireEvent.click(
    screen.getAllByRole("button", { name: "Delete conversation" })[0],
  );
  await screen.findByRole("alert");
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
    "Keep this draft",
  );
  expect(controls.cancel).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Delete conversation" })[0],
  );
  await waitFor(() => expect(screen.queryByLabelText("Message")).toBeNull());
  expect(controls.removeConversation).toHaveBeenCalledWith({
    threadId: "thread",
  });
  expect(
    screen.getByRole("button", { name: "Start conversation" }),
  ).toBeTruthy();
});
