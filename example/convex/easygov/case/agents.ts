// The two agents. Intake chats until it knows the person's goal; selection
// proposes a process pack for it. Neither saves anything: the workflow's next
// mutation decides what to keep, so a retried model call can't leave a
// duplicate in the thread.
import { Agent } from "@convex-dev/agent";
import { vWorkflowId } from "@convex-dev/workflow";
import { Output } from "ai";
import { type Infer, v } from "convex/values";
import { z } from "zod/v4";
import { components, internal } from "../../_generated/api";
import { internalAction, type ActionCtx } from "../../_generated/server";
import { defaultConfig } from "../../agents/config";
import { researchModel } from "../../modelsForDemo";
import {
  normalizeFormId,
  parseJurisdiction,
  vProcessPackDefinition,
} from "../packs/schema";
import { answerProblem, placeholders } from "./answers";

// --- Intake -----------------------------------------------------------------

export const intakeAgent = new Agent(components.agent, {
  name: "Intake",
  instructions:
    "You help people say what legal or government task they need done. " +
    "As soon as a message says what the task is, set `goal` to one plain sentence describing it " +
    "and reply briefly. Don't ask for details then: later steps collect them. " +
    "Only when you can't tell what the task is, set `goal` to null and ask one question.",
  ...defaultConfig,
});

const turnSchema = z.object({
  reply: z.string().describe("What to say to the person."),
  goal: z.string().nullable().describe("The task, once it's clear."),
});

/**
 * Answers one user message. Saves nothing: `recordTurn` decides
 * what to keep, so a retried turn can't leave a duplicate reply.
 */
export const intakeTurn = internalAction({
  args: { caseId: v.id("cases"), promptMessageId: v.string() },
  returns: v.object({ reply: v.string(), goal: v.union(v.string(), v.null()) }),
  handler: async (
    ctx,
    { caseId, promptMessageId },
  ): Promise<{ reply: string; goal: string | null }> => {
    const { threadId }: { threadId: string } = await ctx.runQuery(
      internal.easygov.case.data.threadOf,
      { caseId },
    );
    return await intakeReply(ctx, threadId, promptMessageId);
  },
});

/** One intake reply to the message `promptMessageId`, on any thread. */
export async function intakeReply(
  ctx: ActionCtx,
  threadId: string,
  promptMessageId: string,
): Promise<{ reply: string; goal: string | null }> {
  const { object } = await intakeAgent.generateObject(
    ctx,
    { threadId },
    { promptMessageId, schema: turnSchema },
    { storageOptions: { saveMessages: "none" } },
  );
  return object;
}

// --- Selection --------------------------------------------------------------
//
// Read the request, compare the saved candidates, and if none fits, read the
// authority's own site and draft a process from what it says.

export const selectionAgent = new Agent(components.agent, {
  name: "Select process pack",
  instructions:
    "Identify the process pack that fits a person's goal. " +
    "Only select a pack for the same task, in a jurisdiction that covers the person's. " +
    "Authorities are named in many ways; compare what they do, not their labels.",
  ...defaultConfig,
});

export const proposalFields = {
  message: v.string(),
  packId: v.optional(v.id("processPacks")),
  draft: v.optional(vProcessPackDefinition),
  /** The request needs legal advice, not a process pack. */
  referral: v.optional(v.literal(true)),
  /** Where a referral applies, if the request said. */
  jurisdiction: v.optional(v.string()),
  needsClarification: v.optional(v.literal(true)),
  /** What the search found, when a draft was written from it. */
  research: v.optional(v.string()),
  /** The goal and workflow it was proposed for, to drop a stale result. */
  origin: v.object({ goalVersion: v.number(), workflowId: vWorkflowId }),
};
const vProposal = v.object(proposalFields);

/** What the first call reads from the goal. Labels here only feed search. */
const zRequest = z.object({
  kind: z
    .enum(["process", "referral", "unclear"])
    .describe(
      "process: the person wants to understand, prepare for, or respond to a government or court matter, " +
        "e.g. make sense of a notice or make a checklist. " +
        "referral: the person asks what they should do legally, whether to sue or settle, or wants a lawyer. " +
        "unclear: one question would settle where or what it is.",
    ),
  message: z
    .string()
    .describe(
      "Addressed to the person: a brief sentence, the one question to ask, " +
        "or for a referral, that you'll connect them with legal help.",
    ),
  jurisdiction: z
    .string()
    .optional()
    .describe(
      'Where it applies, narrowest known: "us" for federal, "us/ca" for a state, "us/ca/alameda" for a county.',
    ),
  authority: z
    .string()
    .optional()
    .describe("Who handles it, e.g. Internal Revenue Service."),
  forms: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Official form numbers, e.g. IRS-8822."),
  searchTerms: z
    .string()
    .optional()
    .describe("Process terms and synonyms only, without personal details."),
});

const INPUT_KEY = /^[a-z][a-zA-Z0-9]{0,47}$/;

const zDraft = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(600),
  aliases: z.array(z.string().trim().min(1).max(80)).max(10),
  inputQuestions: z
    .array(
      z.object({
        key: z.string().regex(INPUT_KEY),
        question: z.string().trim().min(1).max(240),
      }),
    )
    .max(12)
    .refine((questions) => {
      const keys = questions.map(({ key }) => key);
      return (
        keys.length === new Set(keys).size &&
        keys.every((key) => !Object.hasOwn(Object.prototype, key))
      );
    }, "Each input must have a distinct key"),
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
        "Only if the person sends a letter. Leave it out entirely otherwise.",
      ),
  }),
});

const noStorage = { storageOptions: { saveMessages: "none" } } as const;

/** Enough of the research to draft from, and no more than the prompt needs. */
const MAX_NOTES = 5000;
const MAX_SOURCES = 8;

/** The pages the research names, in the order it names them. */
export function sourcesIn(notes: string): string[] {
  const urls = notes.match(/https:\/\/[^\s`"'<>()[\]]+/g) ?? [];
  const cleaned = urls.map((url) => url.replace(/[.,;:!?*]+$/, ""));
  return [...new Set(cleaned)].slice(0, MAX_SOURCES);
}

/** What the request is about, as the search and the draft both read it. */
export type Subject = {
  process: string;
  jurisdiction: string;
  authority?: string;
  forms: string[];
};

function subjectLines({ process, jurisdiction, authority, forms }: Subject) {
  return [
    `Process: ${process}`,
    `Jurisdiction: ${jurisdiction}`,
    authority ? `Authority: ${authority}` : "",
    forms.length ? `Forms: ${forms.join(", ")}` : "",
  ].filter(Boolean);
}

// Each step below is one model call, on its own, so it can be run and graded
// alone (see `evals/`). `propose` strings them together.

/** Step 1: what kind of request the goal is, and where it applies. */
export async function readRequest(
  ctx: ActionCtx,
  threadId: string,
  goal: string,
) {
  const { output } = await selectionAgent.generateText(
    ctx,
    { threadId },
    {
      prompt: `Goal: ${goal}\nWhat kind of request is this, and where does it apply?`,
      output: Output.object({ schema: zRequest }),
    },
    noStorage,
  );
  return output;
}

/** A saved pack as the model sees it when comparing candidates. */
export type Candidate = {
  title: string;
  description: string;
  jurisdiction: string;
  authority?: string;
  forms: string[];
};

/** Step 2: which candidate is for the same task: its number, or 0 for none. */
export async function choosePack(
  ctx: ActionCtx,
  threadId: string,
  goal: string,
  jurisdiction: string,
  packs: Candidate[],
): Promise<number> {
  const { output } = await selectionAgent.generateText(
    ctx,
    { threadId },
    {
      prompt: [
        `Goal: ${goal}`,
        `Jurisdiction: ${jurisdiction}`,
        "Which saved process pack is for the same task? Answer its number, or 0 if none is.",
        ...packs.map(
          (pack, i) =>
            `${i + 1}. ${pack.title} (${pack.jurisdiction}` +
            `${pack.authority ? `, ${pack.authority}` : ""}` +
            `${pack.forms.length ? `, forms ${pack.forms.join(", ")}` : ""}). ` +
            pack.description,
        ),
      ].join("\n"),
      output: Output.object({
        schema: z.object({
          choice: z.number().int().min(0).max(packs.length),
        }),
      }),
    },
    noStorage,
  );
  return output.choice;
}

/**
 * Step 3: what the authority's own website says about a process, with the
 * pages it came from. Throws if the search fails.
 */
export async function research(
  ctx: ActionCtx,
  threadId: string,
  subject: Subject,
): Promise<string> {
  const { text } = await selectionAgent.generateText(
    ctx,
    { threadId },
    {
      model: researchModel,
      prompt: [
        "Find how a person does this, from the official website of the authority that handles it.",
        ...subjectLines(subject),
        "Report the steps in order, the ways to do it (online, by mail, in person), who is eligible for each, " +
          "and the documents, fees and time limits the site states.",
        "Use only the authority's own site. Give the full URL of each page you used.",
        "Keep it under 400 words, as plain text.",
        "If the site doesn't say something, say that it doesn't. Don't guess, and don't give advice.",
      ].join("\n"),
    },
    { contextOptions: { recentMessages: 0 }, ...noStorage },
  );
  return text.trim().slice(0, MAX_NOTES);
}

/**
 * Step 4: a process drafted from the research notes: a checklist, a letter
 * if the process calls for one, and a question for each thing the letter
 * needs from the person. With no notes, it only says what to verify.
 */
export async function draftProcess(
  ctx: ActionCtx,
  threadId: string,
  subject: Subject,
  notes: string,
): Promise<Infer<typeof vProcessPackDefinition>> {
  const { output: recipe } = await selectionAgent.generateText(
    ctx,
    { threadId },
    {
      prompt: [
        "Draft a process for a person to follow.",
        ...subjectLines(subject),
        "Give it a title, description, and common aliases.",
        notes
          ? "Write the checklist from the research notes below: the concrete steps, in order, " +
            "with the documents, fees and time limits the notes state. " +
            "Where there is more than one way to do it (online, by mail, in person), give each its own step. " +
            "Where the notes are silent, say to check with the authority. Add nothing the notes don't say."
          : "No research is available. Write a checklist of what to gather and what to verify with the " +
            "relevant authority. Do not invent requirements, deadlines, eligibility, URLs or filing instructions.",
        "Write to the person, in complete sentences. They can't see the research notes: " +
          'never mention "the notes" or "the research". Say "check with" the authority instead.',
        "Anything the person would have to look up belongs in the checklist, never in a question.",
        "If the person has to write to the authority (a request, a dispute, a demand, a written explanation), " +
          "always write that letter for them in output.letter, with a {{key}} placeholder for each fact only " +
          "the person knows about their own situation, such as their name or the date on a notice. " +
          "When the letter has to say why, or what happened, that is one of the placeholders. " +
          "Leave the letter out only when there is nothing for the person to write.",
        "Ask one short, plain question for each placeholder, and no other questions. " +
          "Don't ask for the same thing twice under two names.",
        "Store questions and general guidance only. Do not include case facts, answers, or identifying information.",
        notes ? `Research notes, from the official website:\n${notes}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      output: Output.object({ schema: zDraft }),
    },
    { contextOptions: { recentMessages: 0 }, ...noStorage },
  );
  // A question exists because the letter reads its answer: the inputs are
  // the letter's placeholders, whatever else the model asked.
  const asked = new Map(
    recipe.inputQuestions.map(({ key, question }) => [key, question]),
  );
  const inputs = [...new Set(placeholders(recipe.output.letter ?? ""))].filter(
    (key) => INPUT_KEY.test(key) && !Object.hasOwn(Object.prototype, key),
  );
  const sources = sourcesIn(notes);
  const { jurisdiction, authority, forms } = subject;
  return {
    ...recipe,
    output: { ...recipe.output, sources: sources.length ? sources : undefined },
    jurisdiction,
    authority,
    forms,
    inputs,
    inputQuestions: inputs.map((key) => ({
      key,
      question: asked.get(key) ?? key,
    })),
  };
}

/**
 * Proposes a process for the case's goal. The person still has to confirm
 * it; this only suggests one. Four model calls at most: read the request,
 * compare the saved candidates, and if none fits, research the process and
 * draft it. Nothing is saved until `recordProposal`, so a retry is safe.
 */
export const propose = internalAction({
  args: { caseId: v.id("cases") },
  returns: vProposal,
  handler: async (ctx, { caseId }): Promise<Infer<typeof vProposal>> => {
    const { goal, goalVersion, threadId, workflowId } = await ctx.runQuery(
      internal.easygov.case.data.goalOf,
      { caseId },
    );
    const origin = { goalVersion, workflowId };
    const request = await readRequest(ctx, threadId, goal);
    const jurisdiction = parseJurisdiction(request.jurisdiction ?? "");
    if (
      request.kind === "unclear" ||
      (request.kind === "process" && !jurisdiction)
    ) {
      return {
        message:
          request.kind === "unclear"
            ? request.message
            : "Which state, county or country is this request for?",
        needsClarification: true,
        origin,
      };
    }
    const authority = request.authority?.trim() || undefined;
    const forms = [
      ...new Set((request.forms ?? []).map(normalizeFormId).filter(Boolean)),
    ];
    const terms = [request.searchTerms ?? "", authority ?? "", ...forms].join(
      " ",
    );

    // Search even for a referral: where advice ends and a process begins is a
    // judgment call, and a saved pack for the same task should win it.
    const packs = jurisdiction
      ? await ctx.runQuery(internal.easygov.packs.data.findMatch, {
          caseId,
          jurisdiction,
          terms,
        })
      : [];
    if (packs.length && jurisdiction) {
      const choice = await choosePack(ctx, threadId, goal, jurisdiction, packs);
      const match = packs[choice - 1];
      if (match) {
        return {
          packId: match.id,
          message: `Suggested process: ${match.title}.`,
          origin,
        };
      }
    }

    if (request.kind === "referral" || !jurisdiction) {
      return {
        message: request.message,
        referral: true,
        jurisdiction: jurisdiction ?? undefined,
        origin,
      };
    }

    const subject: Subject = {
      process: request.searchTerms ?? goal,
      jurisdiction,
      authority,
      forms,
    };
    // A failed search isn't worth failing the case for: the draft then says
    // only what to verify, as it would with no research at all.
    const notes = await research(ctx, threadId, subject).catch((error) => {
      console.error("easygov research failed", error);
      return "";
    });
    const draft = await draftProcess(ctx, threadId, subject, notes);
    const pages = draft.output?.sources?.length ?? 0;
    return {
      origin,
      message:
        `No saved process fits, so I drafted a checklist for ${draft.title}` +
        (pages
          ? `, from ${pages} official page${pages === 1 ? "" : "s"}. `
          : ". I couldn't check the official website, so it only says what to verify. ") +
        (draft.inputs.length
          ? "Review it and the questions before confirming."
          : "Review it before confirming."),
      draft,
      research: notes || undefined,
    };
  },
});

// --- Prefill ----------------------------------------------------------------
//
// The person shouldn't be asked twice. What they already said may answer
// some of the questions; those come back as suggestions for them to accept.

/** A question, and what its answer must look like if a check reads it. */
export type Question = {
  key: string;
  question: string;
  kind?: "date" | "number";
};

/**
 * The answers the person already gave, by question key. Only what they
 * plainly said: a question they didn't answer is left out, and so is any
 * value that isn't the date or number its question needs.
 */
export async function prefillAnswers(
  ctx: ActionCtx,
  threadId: string,
  questions: Question[],
  said: string[],
): Promise<Record<string, string>> {
  if (!questions.length || !said.length) return {};
  const { output } = await selectionAgent.generateText(
    ctx,
    { threadId },
    {
      prompt: [
        "A person is about to fill in a form. Below is everything they have said so far, then the form's questions.",
        "For each question, give the answer only if the person plainly stated it, in their own words.",
        "Leave out every question they did not answer. Never guess, infer or make up a value: " +
          "a missing answer costs them one line of typing, and a wrong one ends up in their document.",
        "A question marked (date) takes YYYY-MM-DD. One marked (number) takes digits only.",
        `<said>\n${said.join("\n")}\n</said>`,
        "<questions>",
        ...questions.map(
          ({ key, question, kind }) =>
            `${key}: ${question}${kind ? ` (${kind})` : ""}`,
        ),
        "</questions>",
      ].join("\n"),
      output: Output.object({
        schema: z.object({
          answers: z.array(z.object({ key: z.string(), value: z.string() })),
        }),
      }),
    },
    { contextOptions: { recentMessages: 0 }, ...noStorage },
  );
  const kinds = new Map(questions.map(({ key, kind }) => [key, kind]));
  const found: Record<string, string> = {};
  for (const { key, value } of output.answers) {
    const text = value.trim().slice(0, 500);
    if (!kinds.has(key) || !text) continue;
    if (answerProblem(text, kinds.get(key))) continue;
    found[key] = text;
  }
  return found;
}

/**
 * Reads the conversation for answers to the confirmed pack's questions.
 * A failure here isn't worth failing the case for: the person just types
 * the answers, as they would have.
 */
export const prefill = internalAction({
  args: { caseId: v.id("cases") },
  returns: v.object({
    goalVersion: v.number(),
    answers: v.record(v.string(), v.string()),
  }),
  handler: async (
    ctx,
    { caseId },
  ): Promise<{ goalVersion: number; answers: Record<string, string> }> => {
    const input: {
      goalVersion: number;
      threadId: string;
      questions: Question[];
      said: string[];
    } = await ctx.runQuery(internal.easygov.case.data.prefillInput, { caseId });
    const { goalVersion, threadId, questions, said } = input;
    const answers = await prefillAnswers(ctx, threadId, questions, said).catch(
      (error) => {
        console.error("easygov prefill failed", error);
        return {};
      },
    );
    return { goalVersion, answers };
  },
});
