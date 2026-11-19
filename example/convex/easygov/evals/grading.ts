// The graders. All code, and pure, so they're tested like any function. The
// one judgment call that needs a model is in `runner.ts` (`judgeQuestions`).
import type { Infer } from "convex/values";
import type { CaseView } from "../autopilot";
import { sourcesIn } from "../case/agents";
import type { Mapping } from "../forms/schema";
import type { vProcessPackDefinition } from "../packs/schema";
import { isReading, type Address } from "../profile/vocabulary";

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

/** A question about who the person is or how to reach them. */
const PERSONAL =
  /\b(?:your (?:full |legal )?name|(?:mailing|home|your|current) address|(?:phone|telephone) number|email address)\b/i;

/** Numbers of two or more digits: fees, time limits, addresses, phones. */
function numbers(text: string): string[] {
  return (text.match(/\d[\d,]*\d/g) ?? []).map((n) => n.replaceAll(",", ""));
}

/**
 * A draft against the notes it was written from. `letter`, `maxQuestions`,
 * `asks` and `tailors` are checked only when the case says what to expect.
 */
export function gradeDraft(
  draft: Draft,
  notes: string,
  expected: {
    letter?: boolean;
    maxQuestions?: number;
    asks?: string[];
    tailors?: boolean;
    usesProfile?: boolean;
  } = {},
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
  let extra: string[] | undefined;
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
  // The person's name, address and contact details are read from their
  // profile by its keys, never asked again under a made-up name.
  if (expected.usesProfile) {
    const asksAgain = (draft.inputQuestions ?? []).filter(
      ({ key, question }) =>
        !isReading(key) && PERSONAL.test(`${key} ${question}`),
    );
    checks.usesProfile = asksAgain.length === 0;
    if (asksAgain.length) {
      (extra ??= []).push(
        `asks again: ${asksAgain.map(({ key }) => key).join(", ")}`,
      );
    }
  }
  // Whether it asks about the person's situation, to cut the checklist by.
  if (expected.tailors !== undefined) {
    checks.tailors =
      (draft.output?.tailorBy?.length ?? 0) > 0 === expected.tailors;
  }
  return {
    checks,
    detail:
      [
        cutOff.length ? `cut off: "…${cutOff[0].slice(-40)}"` : "",
        leaks.length ? `leak: "${leaks[0].slice(0, 80)}"` : "",
        invented.length ? `not in the notes: ${invented.join(", ")}` : "",
        homework.length ? `homework: "${homework[0]}"` : "",
        unasked.length ? `never asks: ${unasked.join(", ")}` : "",
        ...(extra ?? []),
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

// --- Tailoring --------------------------------------------------------------

export type TailorExpectation = {
  /** Steps (from 1) that apply to the person and must stay. */
  keep: readonly number[];
  /** Steps their answers rule out. */
  drop: readonly number[];
};

export function gradeTailor(
  expected: TailorExpectation,
  kept: number[],
): Graded {
  const lost = expected.keep.filter((n) => !kept.includes(n));
  const stray = expected.drop.filter((n) => kept.includes(n));
  return {
    checks: {
      // Losing a step that applies is the costly mistake.
      keeps: lost.length === 0,
      drops: stray.length === 0,
    },
    detail:
      [
        lost.length ? `lost: ${lost.join(", ")}` : "",
        stray.length ? `should have dropped: ${stray.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ") || `kept ${kept.join(", ")}`,
  };
}

// --- Address ----------------------------------------------------------------

export type AddressExpectation = {
  /** The parts the text gives, each exactly. Null: it isn't an address. */
  parts: Partial<Address> | null;
  /** Parts the text doesn't give: anything here was made up. */
  blank?: readonly (keyof Address)[];
};

export function gradeAddress(
  expected: AddressExpectation,
  got: Address | null,
): Graded {
  if (expected.parts === null || got === null) {
    return {
      checks: { recognized: (expected.parts === null) === (got === null) },
      detail: got ? "read as an address" : "not read as an address",
    };
  }
  const same = (a?: string, b?: string) =>
    (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  const wrong = Object.entries(expected.parts).filter(
    ([key, value]) => !same(got[key as keyof Address], value),
  );
  const invented = (expected.blank ?? []).filter((key) => got[key]);
  return {
    checks: {
      recognized: true,
      parts: wrong.length === 0,
      // A ZIP or city the text didn't give must stay empty.
      noGuess: invented.length === 0,
    },
    detail:
      [
        wrong.length
          ? `wrong: ${wrong.map(([key]) => `${key}=${got[key as keyof Address] ?? ""}`).join(", ")}`
          : "",
        invented.length
          ? `made up: ${invented.map((key) => `${key}=${got[key]}`).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; ") || undefined,
  };
}

// --- Mapping a form ---------------------------------------------------------

/** What one place on a form should be mapped to. */
export type TargetExpectation =
  /** One of these profile readings. */
  | { readings: readonly string[] }
  /** A question for the case: a key that isn't a profile reading. */
  | { caseInput: true }
  /** Left for the person: a signature, an ID number we don't hold. */
  | { left: true }
  /** Someone else's: never the filer's profile. Blank is fine. */
  | { notProfile: true }
  /**
   * A tick box in a group: every box with the same `group` shares one case
   * input, each with its own option; `many` when several may be ticked.
   */
  | { group: string; many: boolean };

export function gradeMapping(
  expected: Record<string, TargetExpectation>,
  mapping: Mapping,
): Graded {
  const got = new Map(mapping.map((entry) => [entry.target, entry]));
  const wrong: Record<
    "profile" | "caseInputs" | "left" | "others" | "groups",
    string[]
  > = { profile: [], caseInputs: [], left: [], others: [], groups: [] };
  const groups = new Map<string, { inputs: string[]; options: string[] }>();
  for (const [target, want] of Object.entries(expected)) {
    const entry = got.get(target);
    const input = entry?.input;
    const said = `${target}=${input ?? (entry?.leave ? entry.leave.why : "blank")}`;
    if ("readings" in want) {
      if (!input || !want.readings.includes(input)) wrong.profile.push(said);
    } else if ("caseInput" in want) {
      if (!input || isReading(input)) wrong.caseInputs.push(said);
    } else if ("left" in want) {
      // Blank is safe too: the box stays empty for the person. An answer
      // typed into it is what must not happen.
      if (input) wrong.left.push(said);
    } else if ("notProfile" in want) {
      if (input && isReading(input)) wrong.others.push(said);
    } else {
      const option = want.many ? entry?.includes : entry?.equals;
      if (!input || isReading(input) || option === undefined) {
        wrong.groups.push(
          `${said} (${want.many ? "includes" : "equals"} missing)`,
        );
        continue;
      }
      const group = groups.get(want.group) ?? { inputs: [], options: [] };
      group.inputs.push(input);
      group.options.push(option);
      groups.set(want.group, group);
    }
  }
  for (const [name, { inputs, options }] of groups) {
    if (new Set(inputs).size !== 1) {
      wrong.groups.push(
        `${name}: split across ${[...new Set(inputs)].join(", ")}`,
      );
    } else if (new Set(options).size !== options.length) {
      wrong.groups.push(`${name}: two boxes share an option`);
    }
  }
  return {
    checks: {
      // The filer's own facts are read from their profile, by the right key.
      profile: wrong.profile.length === 0,
      caseInputs: wrong.caseInputs.length === 0,
      // A signature or ID number is never an input.
      left: wrong.left.length === 0,
      // Someone else's box never gets the filer's own details.
      notOthers: wrong.others.length === 0,
      // Boxes that answer one question are one input, each its own option.
      groups: wrong.groups.length === 0,
    },
    detail:
      Object.entries(wrong)
        .filter(([, list]) => list.length)
        .map(([kind, list]) => `${kind}: ${list.join(", ")}`)
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
  /**
   * For a pack that fills an official form: the inputs whose answers must be
   * on the PDF, how many boxes are ticked, and how many things are left for
   * the person.
   */
  form?: { inputs: readonly string[]; ticked: number; toComplete: number };
};

/** What was read back from a filled form's PDF. */
export type FilledForm = { texts: string[]; ticked: number };

export function gradePipeline(
  expected: PipelineExpectation,
  c: CaseView,
  filled?: FilledForm,
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
  let missing: string[] = [];
  if (expected.form) {
    const document = c.artifact?.document;
    checks.document = document !== undefined && filled !== undefined;
    // Nothing was left out for not fitting, and nothing failed its read-back.
    checks.noOmissions = document?.omissions.length === 0;
    checks.toComplete =
      document?.toComplete.length === expected.form.toComplete;
    // Read from the PDF itself, not from what the case says it wrote.
    missing = expected.form.inputs.filter(
      (key) => !filled?.texts.includes(c.answers[key] ?? "\u0000"),
    );
    checks.written = missing.length === 0;
    checks.ticked = filled?.ticked === expected.form.ticked;
  }
  return {
    checks,
    detail:
      `${c.status}${c.endReason ? `: ${c.endReason}` : ""}${c.failure ? `; failed: ${c.failure.error}` : ""}` +
      (missing.length ? `; not on the PDF: ${missing.join(", ")}` : "") +
      (filled ? `; ${filled.ticked} ticked` : ""),
  };
}
