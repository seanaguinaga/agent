// What the drafting model returns, and how it becomes a process pack. Pure:
// no model call and no database, so every rule here can be tested with a
// plain draft.
import type { Infer } from "convex/values";
import { z } from "zod/v4";
import {
  INPUT_KEY,
  isInputKey,
  normalizeFormId,
  vProcessPackDefinition,
} from "../packs/schema";
import { isReading, READINGS } from "../profile/vocabulary";
import { placeholders } from "./answers";
import {
  FILING_METHOD,
  filingQuestion,
  formLeads,
  isIdentified,
  methodNamed,
  methodsOf,
  notesOf,
  pagesOf,
  sameForm,
  tidy,
  type Research,
} from "./research";

/** Few enough that answering them is less work than reading every step. */
export const MAX_SITUATION = 3;

/**
 * A key answers are indexed by. Rejected here, a name like `constructor`
 * costs one redrawn draft; let through, it reads a function off the answers.
 */
const zKey = z
  .string()
  .regex(INPUT_KEY)
  .refine(isInputKey, "Use a key that isn't a built-in property name");
/** Applies only to people who answered `key` with `equals`. */
const zWhen = z.object({ key: zKey, equals: z.string() });

export const zDraft = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(600),
  aliases: z.array(z.string().trim().min(1).max(80)).max(10),
  inputQuestions: z
    .array(
      z.object({
        key: zKey,
        question: z.string().trim().min(1).max(240),
      }),
    )
    .max(12)
    .refine((questions) => {
      const keys = questions.map(({ key }) => key);
      return keys.length === new Set(keys).size;
    }, "Each input must have a distinct key"),
  letterWhen: zWhen
    .optional()
    .describe("Route condition when the letter is only one alternative."),
  filingOrder: z
    .array(z.string())
    .optional()
    .describe(
      "Packet order from the authority. Use 'letter', form codes, and evidence keys. Leave out if the authority gives no order.",
    ),
  deadline: z
    .object({
      label: z.string(),
      fromInput: zKey,
      question: z.string(),
      days: z.number().int().positive(),
      sourceUrl: z.string(),
    })
    .optional()
    .describe(
      "Only a source-backed fixed calendar-day period from a known date. Keep exceptions and other deadline types in the instructions.",
    ),
  evidence: z
    .array(
      z.object({
        key: zKey,
        label: z.string(),
        required: z.boolean(),
        when: zWhen.optional(),
      }),
    )
    .optional()
    .describe(
      "Supporting documents to attach. For evidence needed only in some cases (e.g. proof of a name change), set when to a situation question and the answer that makes it required. Otherwise mark it optional.",
    ),
  eligibility: z
    .array(
      z.object({
        condition: z.string(),
        sourceUrl: z.string(),
        key: zKey,
        question: z.string(),
        qualifiesWhen: z.string(),
      }),
    )
    .optional()
    .describe(
      "Conditions established by the authority. Ask a factual yes/no question, never ask the applicant to interpret a rule. Use yes or no as qualifiesWhen.",
    ),
  referralKind: z
    .string()
    .optional()
    .describe(
      "Only where the instructions call for professional assistance, the relevant kind of lawyer.",
    ),
  situationQuestions: z
    .array(
      z.object({
        choices: z
          .array(z.string())
          .optional()
          .describe(
            "The exact values offered for this decision, including every route.",
          ),
        key: zKey,
        question: z.string().trim().min(1).max(240),
      }),
    )
    .max(MAX_SITUATION)
    .optional()
    .describe(
      "Questions about the person's own circumstances that decide which checklist steps apply to them, " +
        "e.g. how they want to file, or whether a date has passed. Each has a yes/no or one-word answer " +
        "the person knows without looking anything up. Ask one only when the checklist has steps that " +
        "apply to some people and not others. Leave it out otherwise.",
    ),
  output: z.object({
    title: z.string().trim().min(1).max(120),
    // Roomy limits: a draft that breaks one is thrown away and redone, and
    // the model writes worse when it's squeezing text to fit.
    checklist: z
      .array(z.string().trim().min(1).max(800))
      .min(1)
      .max(15)
      .describe(
        "Steps in order. Each is one or two plain sentences: no numbering, no markdown, no line breaks.",
      ),
    letter: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .optional()
      .describe(
        "Write it whenever the notes say the person writes a letter, a statement or an explanation, " +
          "or may write one in place of a form. Leave it out only when there is nothing for them to write.",
      ),
  }),
});

export function citedFormPdfs(codes: string[], urls: string[]) {
  const matches: { code: string; sourceUrl: string }[] = [];
  for (const code of codes) {
    const id = normalizeFormId(code).toLowerCase();
    const printed = id.replace(/^[a-z]+-(?=\d)/, "");
    const compact = (text: string) =>
      text.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const sourceUrl = urls.find((url) => {
      const filename = url.split(/[?#]/)[0].split("/").pop() ?? "";
      if (!/\.pdf$/i.test(filename)) return false;
      const stem = compact(filename.slice(0, -4));
      return [compact(id), compact(printed)].some(
        (name) => name && [name, "f" + name, "form" + name].includes(stem),
      );
    });
    if (sourceUrl) matches.push({ code, sourceUrl });
  }
  return matches;
}

export function confidentialInput(key: string, question: string) {
  return /\b(?:ssn|itin|ein|tin|social security|taxpayer (?:id|identification)|passport number|driver.?s? licen[cs]e number)\b/i.test(
    key.replace(/([a-z])([A-Z])/g, "$1 $2") + " " + question,
  );
}

const MAX_SOURCES = 8;

/**
 * Every page the research names, in the order it names them. A rule, a
 * deadline or a form is backed by any of them, however many there are.
 */
export function citedIn(notes: string): string[] {
  const urls = notes.match(/https:\/\/[^\s`"'<>()[\]]+/g) ?? [];
  const cleaned = urls.map((url) => url.replace(/[.,;:!?*]+$/, ""));
  return [...new Set(cleaned)];
}

/** The first of those pages: the ones a draft lists as its sources. */
export function sourcesIn(notes: string): string[] {
  return citedIn(notes).slice(0, MAX_SOURCES);
}

/** What the request is about, as the search and the draft both read it. */
export type Subject = {
  process: string;
  jurisdiction: string;
  authority?: string;
  forms: string[];
};

export type Draft = z.infer<typeof zDraft>;
type Pack = Infer<typeof vProcessPackDefinition>;
type RouteCondition = { key: string; equals: string };
type OfficialForm = { code: string; sourceUrl: string; when?: RouteCondition };

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/**
 * With no research there's no knowing what the authority wants written, or
 * which steps are whose: a checklist of what to verify, and no more.
 */
export function checklistPack(draft: Draft, subject: Subject): Pack {
  const { title, description, aliases, output } = draft;
  const { jurisdiction, authority, forms } = subject;
  return {
    title,
    description,
    aliases,
    output: { title: output.title, checklist: output.checklist },
    jurisdiction,
    authority,
    forms,
    inputs: [],
    inputQuestions: [],
  };
}

/**
 * A pack from a draft and the research it was written from. A question
 * exists because something reads its answer: the letter reads its
 * placeholders, tailoring reads the situation questions, and routes,
 * eligibility and the deadline read theirs. Anything else the model asked is
 * dropped, and so is any rule or deadline whose source the research doesn't
 * cite.
 *
 * The forms and the way of filing come from the research, not the draft:
 * each form is routed to the way that needs it, and the person is asked
 * which way only when the research found more than one. Throws if the draft
 * routes by an answer nobody is asked for, so the draft is redone.
 */
export function researchedPack(
  draft: Draft,
  subject: Subject,
  research: Research,
): Pack {
  const found = tidy(research);
  const notes = notesOf(found);
  const cited = new Set(citedIn(notes));
  const pages = pagesOf(found);
  const sources = (pages.length ? pages : [...cited]).slice(0, MAX_SOURCES);
  const methods = methodsOf(found);
  const filing = methods.length > 1 ? filingQuestion(methods) : undefined;

  // The question about the way of filing is ours to ask, with the ways the
  // research found. The model's own version of it is dropped.
  const mine = <T extends { key: string }>(asked: T[] = []) =>
    asked.filter(({ key }) => !(filing && key === FILING_METHOD));
  const situationQuestions = mine(draft.situationQuestions);
  const drafted = new Map([
    ...[...mine(draft.inputQuestions), ...situationQuestions].map(
      ({ key, question }) => [key, question] as const,
    ),
    ...(filing ? [[filing.key, filing.question] as const] : []),
  ]);
  // A route by the way of filing names one of the ways found, as we spell it.
  const routedBy = (when?: RouteCondition) => {
    if (!when || !filing || when.key !== FILING_METHOD) return when;
    const method = methodNamed(when.equals);
    if (!method || !methods.includes(method)) {
      throw new Error(
        `The draft routes by "${when.equals}", a way of filing the research didn't find.`,
      );
    }
    return { key: FILING_METHOD, equals: method };
  };
  const letterWhen = routedBy(draft.letterWhen);
  const evidence = draft.evidence?.map(({ when, ...item }) => ({
    ...item,
    ...(when && { when: routedBy(when) }),
  }));

  const letter = redactConfidential(draft.output.letter, drafted);
  const letterKeys = unique(placeholders(letter ?? "")).filter(isInputKey);
  const tailorBy = unique([
    ...(filing ? [filing.key] : []),
    ...situationQuestions.map(({ key }) => key),
  ]).filter((key) => !letterKeys.includes(key));
  const rules = (draft.eligibility ?? []).filter((rule) =>
    cited.has(rule.sourceUrl),
  );
  const deadline =
    draft.deadline && cited.has(draft.deadline.sourceUrl)
      ? draft.deadline
      : undefined;
  const packetForms = onePerForm(
    withCitedPdfs(
      // A form known only by a title stays in the notes, for the checklist.
      formLeads(found)
        .filter(isIdentified)
        .map(({ code, pdfUrl, method }) => ({
          code,
          sourceUrl: pdfUrl,
          ...(filing &&
            method && { when: { key: filing.key, equals: method } }),
        })),
      citedFormPdfs(subject.forms, [...cited]),
    ),
    sameEntry,
  );

  const routes = [
    letterWhen,
    ...whens(packetForms),
    ...whens(evidence ?? []),
  ].filter((when) => when !== undefined);

  const inputs = unique([
    ...(letterWhen ? [letterWhen.key] : letterKeys),
    ...tailorBy,
    ...routes.map(({ key }) => key),
    ...rules.map((rule) => rule.key),
    ...(deadline ? [deadline.fromInput] : []),
  ]);

  // Later entries win: a rule's or the deadline's own question replaces
  // whatever the model asked under the same key.
  const questions = new Map([
    ...drafted,
    ...rules.map((rule) => [rule.key, rule.question] as const),
    ...(deadline ? [[deadline.fromInput, deadline.question] as const] : []),
  ]);
  // A route nobody is asked about can never be told apart from the others.
  const unasked = routes.find(({ key }) => !questions.has(key));
  if (unasked) {
    throw new Error(
      `The draft routes by "${unasked.key}" but asks no question for it.`,
    );
  }
  const plain = (values: string[]) =>
    values.map((value) => ({
      value,
      label: value === "unknown" ? "Unsure" : value,
    }));
  const choicesFor = (key: string) => {
    if (filing && key === filing.key) return filing.choices;
    if (rules.some((rule) => rule.key === key)) {
      return plain(["yes", "no", "unknown"]);
    }
    const offered = situationQuestions.find((q) => q.key === key)?.choices;
    if (!offered?.length) return undefined;
    // A route's answer has to be one the person can pick.
    const routed = routes.filter((when) => when.key === key);
    return plain(
      routed.reduce(
        (all, { equals }) =>
          all.some((choice) => sameAnswer(choice, equals))
            ? all
            : [...all, equals.trim()],
        offered,
      ),
    );
  };

  const { jurisdiction, authority, forms } = subject;
  return {
    title: draft.title,
    description: draft.description,
    aliases: draft.aliases,
    jurisdiction,
    authority,
    forms,
    letterRoute: letterWhen && { ...letterWhen, inputs: letterKeys },
    deadline: deadline && {
      label: deadline.label,
      fromInput: deadline.fromInput,
      days: deadline.days,
    },
    evidence,
    referral: draft.referralKind ? { kind: draft.referralKind } : undefined,
    eligibility: rules.length
      ? rules.map(({ question: _question, ...rule }) => rule)
      : undefined,
    packetForms: packetForms.length
      ? packetForms.map(({ code, sourceUrl, when }) => ({
          code,
          sourceUrl: cited.has(sourceUrl) ? sourceUrl : "",
          inputs: [],
          ...(when && { when }),
          openItem: `Locate and complete ${code} using the authority’s instructions.`,
        }))
      : undefined,
    output: {
      title: draft.output.title,
      checklist: draft.output.checklist,
      letter,
      filingOrder: draft.filingOrder,
      sources: sources.length ? sources : undefined,
      tailorBy: tailorBy.length ? tailorBy : undefined,
    },
    inputs,
    inputQuestions: unique([...inputs, ...letterKeys]).map((key) => {
      const choices = choicesFor(key);
      return {
        key,
        question: isReading(key)
          ? READINGS[key].label
          : (questions.get(key) ?? key),
        ...(choices?.length && { choices }),
      };
    }),
  };
}

/** The letter, with each placeholder for a confidential identifier blanked. */
function redactConfidential(
  letter: string | undefined,
  questions: ReadonlyMap<string, string>,
) {
  return letter?.replace(/{{(\w+)}}/g, (token, key: string) =>
    confidentialInput(key, questions.get(key) ?? "")
      ? "[complete by hand]"
      : token,
  );
}

/** Items in groups: each joins the first group holding one `same` as it. */
export function groupsOf<T>(items: T[], same: (a: T, b: T) => boolean): T[][] {
  return items.reduce<T[][]>((groups, item) => {
    const at = groups.findIndex((group) =>
      group.some((other) => same(other, item)),
    );
    return at < 0
      ? [...groups, [item]]
      : groups.map((group, i) => (i === at ? [...group, item] : group));
  }, []);
}

/** Two packet entries for one form: see `sameForm`. */
export const sameEntry = (
  a: { code: string; sourceUrl: string },
  b: { code: string; sourceUrl: string },
) =>
  sameForm(
    { code: a.code, pdfUrl: a.sourceUrl },
    { code: b.code, pdfUrl: b.sourceUrl },
  );

/**
 * One entry for each form. Entries that are the same form (`same`) become
 * one: the one with a printed code, where only some have one. A form needed
 * whichever way the person files is listed once, for everyone; a form only
 * some ways need is listed once for each of those ways.
 */
export function onePerForm<T extends { code: string; when?: RouteCondition }>(
  forms: T[],
  same: (a: T, b: T) => boolean,
): T[] {
  return groupsOf(forms, same).flatMap((group) => {
    const coded = group.filter(({ code }) => /\d/.test(code));
    const named = coded.length ? coded : group;
    if (group.some(({ when }) => !when)) {
      return [
        named.find(({ when }) => !when) ?? { ...named[0], when: undefined },
      ];
    }
    return named.filter(
      (form, i) =>
        named.findIndex(
          (other) =>
            other.when?.key === form.when?.key &&
            other.when?.equals === form.when?.equals,
        ) === i,
    );
  });
}

/** The drafted forms, then each cited PDF whose URL isn't among them yet. */
function withCitedPdfs(
  forms: OfficialForm[],
  pdfs: OfficialForm[],
): OfficialForm[] {
  return pdfs.reduce(
    (all, pdf) =>
      all.some((form) => form.sourceUrl === pdf.sourceUrl)
        ? all
        : [...all, pdf],
    forms,
  );
}

/** The conditions that decide whether each item applies. */
function whens(items: { when?: RouteCondition }[]) {
  return items.map(({ when }) => when);
}

/** Whether two answers are the same, as a case compares them. */
function sameAnswer(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
