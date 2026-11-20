// What is shown of a long text file, and what is kept of a file's reading.
import { describe, expect, test } from "vitest";
import { fitText, summaryOf } from "./reading";

describe("fitText", () => {
  test("shows a file that fits whole", () => {
    expect(fitText("Dear Ada,\nYour claim is denied.")).toEqual({
      text: "Dear Ada,\nYour claim is denied.",
      partial: false,
    });
  });

  test("keeps the start and end of one that doesn't, on whole lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const { text, partial } = fitText(lines.join("\n"), 400);
    expect(partial).toBe(true);
    const shown = text.split("\n");
    const gap = shown.findIndex((line) => line.startsWith("[..."));
    expect(shown[0]).toBe("line 1");
    expect(shown.at(-1)).toBe("line 200");
    expect(shown[gap]).toMatch(
      /^\[\.\.\. \d+ characters left out here \.\.\.\]$/,
    );
    // Every line shown is a whole line of the file.
    for (const line of shown.filter((_, i) => i !== gap)) {
      expect(lines).toContain(line);
    }
    expect(text.length).toBeLessThan(500);
  });

  test("still cuts a file that has no line breaks", () => {
    const { text, partial } = fitText("x".repeat(1000), 100);
    expect(partial).toBe(true);
    expect(text).toBe(
      `${"x".repeat(60)}\n[... 900 characters left out here ...]\n${"x".repeat(40)}`,
    );
  });
});

describe("summaryOf", () => {
  const what = "A denial letter from the Example Agency, dated 2026-10-01.";

  test("says what the file is, then one fact to a line", () => {
    expect(
      summaryOf({
        what,
        stated: [
          { label: "Date to act by", value: "2026-12-01" },
          { label: "Case number", value: "AB-1234" },
        ],
      }),
    ).toBe(`${what}\nDate to act by: 2026-12-01\nCase number: AB-1234`);
  });

  test("drops whole facts past the limit, and never half of one", () => {
    const stated = Array.from({ length: 40 }, (_, i) => ({
      label: `Fact ${i + 1}`,
      value: `value ${i + 1}`,
    }));
    const lines = summaryOf({ what, stated }).split("\n");
    expect(lines).toHaveLength(26);
    expect(lines.at(-1)).toBe("Fact 25: value 25");
  });

  test("marks a value it had to cut short, and skips empty facts", () => {
    const summary = summaryOf({
      what,
      stated: [
        { label: "Reason", value: "because ".repeat(100) },
        { label: "Amount", value: "  " },
        { label: "Address", value: "1 Main St\nSpringfield" },
      ],
    });
    const [, reason, address, ...rest] = summary.split("\n");
    expect(reason.length).toBeLessThanOrEqual("Reason: ".length + 300);
    expect(reason.endsWith("because…")).toBe(true);
    expect(address).toBe("Address: 1 Main St Springfield");
    expect(rest).toEqual([]);
  });

  test("says when only part of the file was read", () => {
    expect(summaryOf({ what, stated: [] }, true)).toBe(
      `${what}\nOnly the start and end of this file were read.`,
    );
  });

  test("is empty when the model says nothing about the file", () => {
    expect(summaryOf({ what: " ", stated: [{ label: "a", value: "b" }] })).toBe(
      "",
    );
  });
});
