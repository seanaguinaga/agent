// The graders. All code, and pure, so they're tested like any function. The
// one judgment call that needs a model is in `runner.ts` (`judgeQuestions`).
import type { Infer } from "convex/values";
import type { CaseView } from "../autopilot";
import { sourcesIn } from "../case/agents";
import type { vProcessPackDefinition } from "../packs/schema";

export type Checks = Record<string, boolean>;
export type Graded = { checks: Checks; detail?: string };
type Draft = Infer<typeof vProcessPackDefinition>;

/** A trial passes when every check does, apart from the advisory "~" ones. */
export function passes(checks: Checks): boolean {
  return Object.entries(checks).every(
    ([name, ok]) => name.startsWith("~") || ok,
  );
}

// --- Intake -----------------------------------------------------------------

export function gradeIntake(
  expected: "goal" | "ask",
  turn: { reply: string; goal: string | null },
): Graded {
  const questions = (turn.reply.match(/\?/g) ?? []).length;
  const goal = turn.goal?.trim() ?? "";
  return {
    checks: {
      // A clear request gets a goal; anything else gets a question back.
      goal: expected === "goal" ? goal !== "" : goal === "",
      replies: turn.reply.trim() !== "",
      oneQuestion: questions <= 1 && (expected === "goal" || questions === 1),
      // One sentence, not the person's story.
      shortGoal: goal.length <= 200,
    },
  };
}

// --- Reading the request ----------------------------------------------------

export type RequestExpectation = {
  kinds: readonly string[];
  /** Accepted paths; null means none should be given. */
  jurisdictions?: readonly (string | null)[];
  forms?: readonly string[];
};

export function gradeRequest(
  expected: RequestExpectation,
  request: { kind: string; jurisdiction?: string; forms?: string[] },
  parse: (raw: string) => string | null,
  normalizeForm: (raw: string) => string,
): Graded {
  const place = parse(request.jurisdiction ?? "");
  const checks: Checks = { kind: expected.kinds.includes(request.kind) };
  if (expected.jurisdictions) {
    checks.jurisdiction = expected.jurisdictions.includes(place);
  }
  if (expected.forms) {
    const forms = (request.forms ?? []).map(normalizeForm);
    // Advisory: the form number helps search, but the goal rarely states it.
    checks["~forms"] = expected.forms.every((form) => forms.includes(form));
  }
  return { checks, detail: `${request.kind} @ ${place ?? "nowhere"}` };
}

// --- Research ---------------------------------------------------------------

export function gradeResearch(
  expected: { domain: string; facts: readonly string[] },
  notes: string,
): Graded {
  const sources = sourcesIn(notes);
  const offDomain = sources.filter((url) => {
    const host = new URL(url).hostname;
    return host !== expected.domain && !host.endsWith(`.${expected.domain}`);
  });
  const missing = expected.facts.filter(
    (fact) => !new RegExp(fact, "i").test(notes),
  );
  return {
    checks: {
      sources: sources.length > 0,
      onDomain: sources.length > 0 && offDomain.length === 0,
      facts: missing.length === 0,
    },
    detail:
      [
        offDomain.length ? `off-domain: ${offDomain.join(", ")}` : "",
        missing.length ? `missing: ${missing.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ") || undefined,
  };
}

// --- Draft ------------------------------------------------------------------

const LEAK = /\b(?:the|research|these|those) notes?\b|\bthe research\b/i;
const MARKDOWN = /\*\*|__|^#|\n|^\s*(?:\d+[.)]|[-*•])\s/;
const ENDS = /[.!?)"”’]$/;
/** Questions that ask the person to do the author's research. */
const HOMEWORK =
  /\b(?:official|instructions?|requirements?|applicable|which forms?|authorit(?:y|ies)|verify|regulations?)\b/i;

/** Numbers of two or more digits: fees, time limits, addresses, phones. */
function numbers(text: string): string[] {
  return (text.match(/\d[\d,]*\d/g) ?? []).map((n) => n.replaceAll(",", ""));
}

/**
 * A draft against the notes it was written from. `letter`, `maxQuestions`
 * and `asks` are checked only when the case says what to expect.
 */
export function gradeDraft(
  draft: Draft,
  notes: string,
  expected: { letter?: boolean; maxQuestions?: number; asks?: string[] } = {},
): Graded {
  const checklist = draft.output?.checklist ?? [];
  const letter = draft.output?.letter;
  const questions = (draft.inputQuestions ?? []).map(
    ({ question }) => question,
  );
  const shown = [...checklist, draft.description, letter ?? "", ...questions];
  const known = notes.replaceAll(",", "");
  const invented = [
    ...new Set(numbers([...checklist, letter ?? ""].join(" "))),
  ].filter((n) => !known.includes(n));
  const cutOff = checklist.filter((item) => !ENDS.test(item.trim()));
  const leaks = shown.filter((text) => LEAK.test(text));
  const homework = questions.filter((question) => HOMEWORK.test(question));
  const checks: Checks = {
    // Every step is a finished sentence.
    complete: checklist.length > 0 && cutOff.length === 0,
    // The person never hears about "the notes".
    noLeak: leaks.length === 0,
    plain: !checklist.some((item) => MARKDOWN.test(item)),
    // Every fee, date and address came from the research.
    grounded: invented.length === 0,
    // Nothing the person would have to look up.
    noHomework: homework.length === 0,
    sources: !notes || (draft.output?.sources?.length ?? 0) > 0,
  };
  if (expected.letter !== undefined) {
    checks.letter = (letter !== undefined) === expected.letter;
  }
  if (expected.maxQuestions !== undefined) {
    checks.fewQuestions = questions.length <= expected.maxQuestions;
  }
  // What the letter can't be written without, e.g. the person's reason.
  const unasked = (expected.asks ?? []).filter(
    (pattern) =>
      !(draft.inputQuestions ?? []).some(({ key, question }) =>
        new RegExp(pattern, "i").test(`${key} ${question}`),
      ),
  );
  if (expected.asks) checks.asks = unasked.length === 0;
  return {
    checks,
    detail:
      [
        cutOff.length ? `cut off: "…${cutOff[0].slice(-40)}"` : "",
        leaks.length ? `leak: "${leaks[0].slice(0, 80)}"` : "",
        invented.length ? `not in the notes: ${invented.join(", ")}` : "",
        homework.length ? `homework: "${homework[0]}"` : "",
        unasked.length ? `never asks: ${unasked.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ") || undefined,
  };
}

// --- Prefill ----------------------------------------------------------------

export type PrefillExpectation = {
  /** What must be found: a pattern for each key the person answered. */
  has: Record<string, string>;
  /** Keys the person never answered: any value here is a guess. */
  absent: readonly string[];
};

export function gradePrefill(
  expected: PrefillExpectation,
  answers: Record<string, string>,
): Graded {
  const missed = Object.entries(expected.has).filter(
    ([key, pattern]) => !new RegExp(pattern, "i").test(answers[key] ?? ""),
  );
  const guessed = expected.absent.filter((key) => key in answers);
  return {
    checks: {
      // Everything the person said is offered back.
      found: missed.length === 0,
      // Nothing they didn't say is.
      noGuess: guessed.length === 0,
    },
    detail:
      [
        missed.length
          ? `missed: ${missed.map(([key]) => `${key}=${answers[key] ?? "(none)"}`).join(", ")}`
          : "",
        guessed.length
          ? `guessed: ${guessed.map((key) => `${key}=${answers[key]}`).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; ") || undefined,
  };
}

// --- A whole case -----------------------------------------------------------

export type Outcome = "pack" | "draft" | "referral" | "clarification" | "none";

/** What stage 1 came to for a goal. */
export function outcomeOf(c: CaseView): Outcome {
  const selection = c.processPack;
  if (!selection || selection.goalVersion !== c.intake?.version) return "none";
  if (selection.status === "rejected") return "clarification";
  if (selection.draft) return "draft";
  if (selection.referral) return "referral";
  return selection.definition ? "pack" : "none";
}

export type PipelineExpectation = {
  delivery?: string | null;
  referral?: "shared" | "declined" | null;
  /** Text the finished letter must contain, e.g. an answer it was built from. */
  letterHas?: string;
};

export function gradePipeline(
  expected: PipelineExpectation,
  c: CaseView,
): Graded {
  const checks: Checks = {
    done: c.status === "done",
    approved: c.approval?.fingerprint === c.artifact?.fingerprint,
  };
  if (expected.delivery !== undefined) {
    checks.delivery = (c.delivery?.channel ?? null) === expected.delivery;
  }
  if (expected.referral !== undefined) {
    checks.referral = (c.referral?.status ?? null) === expected.referral;
  }
  const letter = c.artifact?.letter;
  if (expected.letterHas !== undefined) {
    checks.letter = !!letter?.includes(expected.letterHas);
  }
  // No placeholder left unfilled.
  if (letter !== undefined) checks.filled = !/\{\{\w+\}\}/.test(letter);
  return {
    checks,
    detail: `${c.status}${c.endReason ? `: ${c.endReason}` : ""}${c.failure ? `; failed: ${c.failure.error}` : ""}`,
  };
}
