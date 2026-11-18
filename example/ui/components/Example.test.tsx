// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { ExampleBoundary, TaskError, useExampleTask } from "./Example";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("failed actions clear pending, preserve inputs, and allow a successful retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const request = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce("done");
  function Form() {
    const task = useExampleTask<string>();
    const [draft, setDraft] = useState("keep this");
    return (
      <>
        <input
          aria-label="Draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button disabled={task.pending} onClick={() => void task.run(request)}>
          Run
        </button>
        <TaskError error={task.error} />
        <p>{task.result}</p>
      </>
    );
  }
  render(<Form />);
  await act(async () => {
    fireEvent.click(screen.getByText("Run"));
  });
  expect(screen.getByRole("alert").textContent).toContain("could not finish");
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
    "keep this",
  );
  await act(async () => {
    fireEvent.click(screen.getByText("Run"));
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("done")).toBeTruthy();
});

test.each([true, false])(
  "query recovery handles initial and later failures without resetting sibling drafts (initial: %s)",
  async (initial) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let failed = initial;
    function Reader() {
      if (failed) throw new Error("query unavailable");
      return <p>Live result</p>;
    }
    function Page() {
      return (
        <>
          <input aria-label="Sibling draft" defaultValue="" />
          <ExampleBoundary>
            <Reader />
          </ExampleBoundary>
        </>
      );
    }
    const view = render(<Page />);
    fireEvent.change(screen.getByLabelText("Sibling draft"), {
      target: { value: "saved draft" },
    });
    if (!initial) {
      failed = true;
      view.rerender(<Page />);
    }
    expect(screen.getByRole("alert")).toBeTruthy();
    failed = false;
    fireEvent.click(screen.getByText("Retry"));
    expect(screen.getByText("Live result")).toBeTruthy();
    expect(
      (screen.getByLabelText("Sibling draft") as HTMLInputElement).value,
    ).toBe("saved draft");
  },
);
