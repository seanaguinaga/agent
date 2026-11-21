import { describe, expect, test } from "vitest";
import { backingNote } from "./FormBacking";

const form = { code: "SSA-561", sourceUrl: "https://example.org/ssa-561.pdf" };

describe("backingNote", () => {
  test("says nothing for a form that doesn't record it", () => {
    expect(backingNote(form)).toBeNull();
  });

  test("an unbacked form says what was found and what to check", () => {
    const note = backingNote({ ...form, backed: false });
    expect(note).toMatchObject({
      kind: "unconfirmed",
      headline: "SSA-561: not confirmed by the authority’s own page",
    });
    const words = JSON.stringify(note);
    expect(words).toMatch(/found under the name SSA-561/);
    expect(words).toMatch(/check on the authority’s site/);
  });

  test("a backed form claims only that an official page links the file", () => {
    const note = backingNote({ ...form, backed: true });
    expect(note).toEqual({
      kind: "linked",
      text: "An official page of the authority links this file as SSA-561.",
    });
  });

  test("a backed form is never called official, current or accepted", () => {
    expect(JSON.stringify(backingNote({ ...form, backed: true }))).not.toMatch(
      /current|accepted|official form|is official/i,
    );
  });
});
