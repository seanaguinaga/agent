// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import JevDecision from "./JevDecision";

const { triage } = vi.hoisted(() => ({ triage: vi.fn() }));
vi.mock("convex/react", () => ({ useAction: () => triage }));
const decision: FunctionReturnType<typeof api.decisions.jev.triage> = {
  id: "test-decision",
  model: "typesafe/jev-1.13",
  answers: {
    priority: { type: "choice", choice: "urgent", confidence: 0.9 },
    needsHuman: { type: "noul", noul: 0.8 },
  },
};
beforeEach(() => triage.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("shows distinct confidence and human-review probability and labels the evaluated input", async () => {
  const pending = Promise.withResolvers<typeof decision>();
  triage.mockReturnValueOnce(pending.promise);
  render(
    <MemoryRouter>
      <JevDecision />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Support ticket"), {
    target: { value: "System is down" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Evaluate with Jev" }));
  expect(
    (screen.getByLabelText("Support ticket") as HTMLTextAreaElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Outage" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => pending.resolve(decision));
  expect(screen.getByText("urgent")).toBeTruthy();
  expect(screen.getByText("Confidence: 90.0%")).toBeTruthy();
  expect(screen.getByText("80.0%")).toBeTruthy();
  expect(screen.getAllByText("Not reported")).toHaveLength(3);
  fireEvent.change(screen.getByLabelText("Support ticket"), {
    target: { value: "A different question" },
  });
  expect(
    screen.getByRole("region", { name: "Decision result" }).textContent,
  ).toContain("System is down");
  expect(
    screen.getByRole("region", { name: "Decision result" }).textContent,
  ).not.toContain("A different question");
});

test("preserves the ticket on failure and supports retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  triage
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce(decision);
  render(
    <MemoryRouter>
      <JevDecision />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Support ticket"), {
    target: { value: "Keep my ticket" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Evaluate with Jev" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("Support ticket") as HTMLTextAreaElement).value,
  ).toBe("Keep my ticket");
  expect(screen.queryByRole("region", { name: "Decision result" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Evaluate with Jev" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(
    await screen.findByRole("region", { name: "Decision result" }),
  ).toBeTruthy();
  expect(triage).toHaveBeenNthCalledWith(2, { ticket: "Keep my ticket" });
});

test("blank input cannot evaluate", () => {
  render(
    <MemoryRouter>
      <JevDecision />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Support ticket"), {
    target: { value: " " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Evaluate with Jev" }));
  expect(triage).not.toHaveBeenCalled();
});
