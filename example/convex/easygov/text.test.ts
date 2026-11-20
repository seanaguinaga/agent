import { expect, test } from "vitest";
import { clip } from "./text";

test("keeps text that fits, on one line", () => {
  expect(clip("  What is\nyour name? ", 240)).toBe("What is your name?");
});

test("cuts text that doesn't at a word, and marks the cut", () => {
  const cut = clip("What is the date printed on the notice you received?", 30);
  expect(cut).toBe("What is the date printed on…");
  expect(cut.length).toBeLessThanOrEqual(30);
});

test("still cuts text with no word to break at", () => {
  expect(clip("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
});
