// Runs the eval cases in ./cases.ts against the real agents and the real
// pipeline, several trials each, and records the results. A case that passes
// 2 of 3 is a reliability problem a single run would have hidden.
//
//   npx convex run easygov/evals/runner:start '{"note":"baseline"}'
//   npx convex run easygov/evals/runner:start '{"note":"...","slices":["draft"],"trials":5}'
//   npx convex run easygov/evals/runner:start '{"note":"...","slices":["forms"],"serial":true}'
//   npx convex run easygov/evals/runner:forgetFetched
//   npx convex run easygov/evals/runner:runs
//   npx convex run easygov/evals/runner:quality '{"runId":"..."}'
//   npx convex run easygov/evals/runner:trials '{"runId":"...","failedOnly":true}'
//
// Like `dev.ts`, these are public and check nothing: they're for the test
// pages. Don't ship this file.
import { requireOperator } from "../operators";
import { createThread, saveMessage } from "@convex-dev/agent";
import { generateText, Output } from "ai";
import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod/v4";
import { api, components, internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "../../_generated/server";
import { languageModel, researchModel } from "../../modelsForDemo";
import { doc } from "convex-helpers/validators";
import schema from "../../schema";
import { pilot, type CaseEvent, type CaseView } from "../autopilot";
import { chosen } from "../case/schema";
import {
  choosePack,
  draftProcess,
  intakeReply,
  suggestAnswers,
  readRequest,
  research,
  subjectOf,
  tailorChecklist,
  type ResearchTrace,
} from "../case/agents";
import { researchedPack, type Draft } from "../case/draft";
import { fileAt, locateForms, newFinder } from "../case/locate";
import {
  bareResearch,
  formLeads,
  isIdentified,
  notesOf,
} from "../case/research";
import { chargeUsage } from "../limits";
import { proposeMapping } from "../forms/agents";
import { normalizeFormId, parseJurisdiction } from "../packs/schema";
import { addressFromText } from "../profile/agents";
import { withTelemetry } from "../../debugging/spans";
import * as cases from "./cases";
import { references, type Reference } from "./references";
import {
  gradeAddress,
  gradeDraft,
  gradeForms,
  gradeIntake,
  gradeMapping,
  gradePipeline,
  gradeSuggest,
  gradeRequest,
  gradeResearch,
  gradeTailor,
  outcomeOf,
  passes,
  type FilledForm,
  type FormGrade,
  type Graded,
} from "./grading";
import {
  draftInput,
  FORM_OUTCOMES,
  HELD_COUNT_CAP,
  SLICES,
  vHeld,
  vJudgeCheck,
  vSlice,
  vTrialOutcome,
  vTrialView,
  type Slice,
} from "./tables";

const DEFAULT_TRIALS = 3;
/** The search has no model in it: once is enough. */
const DETERMINISTIC: Slice[] = ["search"];
/** A saved draft case's id: "saved:<row id>". */
const SAVED = "saved:";
/** Trials start this far apart, so a run doesn't hit the gateway all at once. */
const STAGGER_MS = 400;
/**
 * Longer than any trial takes: a model step is one action (ten minutes at
 * most), and a real case settles in a few short steps.
 */
const TRIAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Starts a run: every case of the chosen slices, `trials` times each. With
 * `serial`, one trial runs at a time, in planned order, so no trial's time
 * or cache is another's: the first starts once the held rows are counted,
 * and each next one as the one before ends.
 */
export const start = mutation({
  args: {
    note: v.string(),
    slices: v.optional(v.array(vSlice)),
    trials: v.optional(v.number()),
    serial: v.optional(v.boolean()),
  },
  returns: v.id("easygovEvalRuns"),
  handler: async (
    ctx,
    { note, slices = [...SLICES], trials = DEFAULT_TRIALS, serial = false },
  ) => {
    await requireOperator(ctx);
    if (!Number.isInteger(trials) || trials < 1 || trials > 10) {
      throw new ConvexError("trials must be a whole number from 1 to 10");
    }
    // The search, outcome and pipeline cases run against the fixture packs.
    await ctx.runMutation(api.easygov.dev.seed, {});
    const saved = await ctx.db.query("easygovEvalCases").take(100);
    const planned = slices.flatMap((slice) => {
      const ids: string[] = cases[slice].map((c: { id: string }) => c.id);
      if (slice === "draft") ids.push(...saved.map((row) => SAVED + row._id));
      const times = DETERMINISTIC.includes(slice) ? 1 : trials;
      return ids.flatMap((caseId) =>
        Array.from({ length: times }, (_, i) => ({
          slice,
          caseId,
          trial: i + 1,
        })),
      );
    });
    const runId = await ctx.db.insert("easygovEvalRuns", {
      note,
      models: `${languageModel.modelId}, research ${researchModel.modelId}`,
      trialsPerCase: trials,
      totalTrials: planned.length,
      finishedTrials: 0,
      status: planned.length ? "running" : "done",
      ...(serial ? { serial } : {}),
    });
    for (const [i, trial] of planned.entries()) {
      const trialId = await ctx.db.insert("easygovEvalTrials", {
        runId,
        ...trial,
        status: "pending",
      });
      // A serial run's first trial is started by `countHeld`.
      if (serial) continue;
      await ctx.scheduler.runAfter(
        i * STAGGER_MS,
        internal.easygov.evals.runner.runTrial,
        { trialId },
      );
    }
    await ctx.scheduler.runAfter(0, internal.easygov.evals.runner.countHeld, {
      runId,
      cursor: null,
      addresses: 0,
    });
    if (slices.includes("draft")) {
      await ctx.scheduler.runAfter(
        0,
        internal.easygov.evals.runner.checkJudge,
        {
          runId,
        },
      );
    }
    return runId;
  },
});

function find<T extends { id: string }>(list: T[], id: string): T {
  const found = list.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown eval case "${id}"`);
  return found;
}

type Result = Graded & {
  output: unknown;
  cost?: Record<string, number>;
  forms?: FormGrade[];
};

/** A draft that says nothing: the forms come from the research alone. */
const NO_DRAFT: Draft = {
  title: "-",
  description: "-",
  aliases: [],
  inputQuestions: [],
  output: { title: "-", checklist: ["-"] },
};

/** One trial: run the slice's step on the case's input, then grade it. */
export const runTrial = internalAction({
  args: { trialId: v.id("easygovEvalTrials") },
  returns: v.null(),
  handler: async (ctx, { trialId }): Promise<null> => {
    const { slice, caseId, threadId, saved }: Begun = await ctx.runMutation(
      internal.easygov.evals.runner.beginTrial,
      { trialId },
    );
    const started = Date.now();
    try {
      if (slice === "outcome" || slice === "pipeline") {
        const id = await startCase(ctx, slice, caseId);
        await ctx.runMutation(internal.easygov.evals.runner.caseStarted, {
          trialId,
          id,
        });
        return null;
      }
      const { checks, detail, output, cost, forms } = await withTelemetry(
        ctx,
        threadId,
        () => run[slice](ctx, caseId, threadId, saved),
      );
      await ctx.runMutation(internal.easygov.evals.runner.finishTrial, {
        trialId,
        outcome: {
          status: passes(checks) ? "passed" : "failed",
          checks,
          detail,
          output: JSON.stringify(output, null, 1).slice(0, 20000),
          ms: Date.now() - started,
          cost,
          forms,
        },
      });
    } catch (error) {
      await ctx.runMutation(internal.easygov.evals.runner.finishTrial, {
        trialId,
        outcome: {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          ms: Date.now() - started,
        },
      });
    }
    return null;
  },
});

type SavedDraft = Doc<"easygovEvalCases"> | null;
type Begun = {
  slice: Slice;
  caseId: string;
  threadId: string;
  saved: SavedDraft;
};

const run: Record<
  Exclude<Slice, "outcome" | "pipeline">,
  (
    ctx: ActionCtx,
    caseId: string,
    threadId: string,
    saved: SavedDraft,
  ) => Promise<Result>
> = {
  async intake(ctx, caseId, threadId) {
    const { message, expect } = find(cases.intake, caseId);
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: message,
    });
    const turn = await intakeReply(ctx, threadId, messageId);
    return { ...gradeIntake(expect, turn), output: turn };
  },

  async request(ctx, caseId, threadId) {
    const { goal, ...expected } = find(cases.request, caseId);
    const request = await readRequest(ctx, threadId, goal);
    return {
      ...gradeRequest(expected, request, parseJurisdiction, normalizeFormId),
      output: request,
    };
  },

  async choose(ctx, caseId, threadId) {
    const { goal, jurisdiction, packs, expect } = find(cases.choose, caseId);
    const choice = await choosePack(ctx, threadId, goal, jurisdiction, packs);
    return {
      checks: { choice: choice === expect },
      detail: `chose ${choice}, expected ${expect}`,
      output: { choice },
    };
  },

  async research(ctx, caseId, threadId) {
    const { subject, domain, facts } = find(cases.research, caseId);
    const notes = notesOf(await research(ctx, threadId, subject));
    return { ...gradeResearch({ domain, facts }, notes), output: notes };
  },

  // The forms step, for the cases outside the US.
  world: (...args) => run.forms(...args),

  // A goal to the forms it needs: the request is read, the process
  // researched, and each form located, as a proposal would. The draft and
  // the form mapping are left out: neither decides which forms come back.
  async forms(ctx, caseId, threadId) {
    const { goal, expect } = find([...cases.forms, ...cases.world], caseId);
    const request = await readRequest(ctx, threadId, goal);
    const jurisdiction = parseJurisdiction(request.jurisdiction ?? "");
    if (!jurisdiction) throw new Error("No place was read from the goal");
    const subject = subjectOf(request, goal, jurisdiction);
    const trace: ResearchTrace = {};
    // What finding the forms spends, apart from what grading them does.
    const finder = newFinder();
    const began = Date.now();
    const found = await research(ctx, threadId, subject, trace, finder);
    const researched = Date.now();
    // The forms and the pages, as a proposal's draft would carry them.
    const pack = researchedPack(NO_DRAFT, subject, found);
    const located = await locateForms(
      ctx,
      threadId,
      pack.packetForms ?? [],
      subject,
      pack.output?.sources ?? [],
      finder,
    );
    const forms = located.map(({ form, located: { file, ...how } }) => ({
      code: form.code,
      when: form.when?.equals,
      given: form.sourceUrl,
      ...how,
      ...file,
    }));
    const got = forms.filter(({ url }) => url);
    const cost = {
      ...finder.spend.spent,
      forms: forms.length,
      // How many forms got a file, and how many of those files are the one
      // an official page links as that form: at all, and only by reading
      // one link further on than the pages research read.
      located: got.length,
      backed: got.filter(({ backed }) => backed).length,
      backedFurther: got.filter(
        ({ backed, designated }) => backed && designated?.further,
      ).length,
      furtherPages: forms.reduce((sum, f) => sum + f.links.further, 0),
      researchMs: researched - began,
      locateMs: Date.now() - researched,
    };
    // The file each expected form was last published as, fetched now, to
    // tell the right edition from another file found under the same name.
    // Paid for apart from the packet, so it isn't counted as its cost.
    const grading = newFinder({});
    const published = await Promise.all(
      expect.map(async ({ code, url }) => {
        // The case says the authority publishes the form at this address.
        // Its file still has to name the form on its own.
        const file = await fileAt(ctx, grading, { jurisdiction, code }, url);
        return file.ok
          ? { code, editionId: file.editionId, facts: file.facts }
          : { code };
      }),
    );
    const graded = gradeForms(expect, forms, published);
    // What a reader would catch that the comparison of files can't.
    const reference = references[caseId];
    if (reference) {
      const judged = await judgeForms(
        ctx,
        reference,
        // Listed once for each way of filing that needs it: not a repeat.
        forms.map(({ code, when, url, backed, facts }) => ({
          code,
          when,
          url,
          backed,
          facts,
        })),
      ).catch(() => undefined);
      if (judged) {
        graded.checks["~judge"] = !judged.problems.length;
        if (judged.problems.length) {
          graded.detail = [graded.detail, `judge: ${judged.problems.join(" ")}`]
            .filter(Boolean)
            .join("; ");
        }
      }
    }
    return {
      ...graded,
      cost,
      // Everything each step saw, so a rule can be judged across cases.
      output: {
        kind: request.kind,
        subject,
        forms,
        reported: formLeads(found).map(({ code, method, pdfUrl }) => ({
          code,
          method,
          pdfUrl,
          identified: isIdentified({ code, pdfUrl, requiredBy: "" }),
        })),
        raw: trace.raw && {
          forms: trace.raw.forms,
          methods: trace.raw.methods.map(({ method, forms }) => ({
            method,
            forms,
          })),
          sources: trace.raw.sources,
        },
        searched: trace.searched,
        followUps: trace.followUps,
      },
    };
  },

  async draft(ctx, caseId, threadId, saved) {
    const { subject, notes, ...expected } = saved
      ? {
          subject: {
            process: saved.process,
            jurisdiction: saved.jurisdiction,
            authority: saved.authority,
            forms: saved.forms,
          },
          notes: saved.notes,
        }
      : find(cases.draft, caseId);
    // A frozen case is only its notes: no ways of filing or forms as data.
    const draft = await draftProcess(
      ctx,
      threadId,
      subject,
      notes ? bareResearch(notes) : undefined,
    );
    const graded = gradeDraft(draft, notes, expected);
    const questions = (draft.inputQuestions ?? []).map((q) => q.question);
    // The one check code can't make: do two questions ask the same thing?
    if (questions.length > 1) {
      const judged = await judgeQuestions(ctx, subject.process, questions);
      graded.checks.distinctQuestions = judged.verdict === "pass";
      if (judged.verdict !== "pass") {
        graded.detail = [graded.detail, `judge: ${judged.reasoning}`]
          .filter(Boolean)
          .join("; ");
      }
    }
    return { ...graded, output: draft };
  },

  async suggest(ctx, caseId, threadId) {
    const { questions, said, ...expected } = find(cases.suggest, caseId);
    const answers = await suggestAnswers(ctx, threadId, questions, said);
    return { ...gradeSuggest(expected, answers), output: answers };
  },

  async tailor(ctx, caseId, threadId) {
    const { checklist, situation, ...expected } = find(cases.tailor, caseId);
    const kept = await tailorChecklist(ctx, threadId, checklist, situation);
    return { ...gradeTailor(expected, kept), output: { kept } };
  },

  async address(ctx, caseId) {
    const { text, ...expected } = find(cases.address, caseId);
    const got = await addressFromText(ctx, undefined, text);
    return { ...gradeAddress(expected, got), output: got };
  },

  async mapping(ctx, caseId) {
    const { title, targets, expect } = find(cases.mapping, caseId);
    const drafted = await proposeMapping(ctx, undefined, title, targets);
    return { ...gradeMapping(expect, drafted), output: drafted };
  },

  async search(ctx, caseId) {
    const { jurisdiction, terms, expect } = find(cases.search, caseId);
    const found: { title: string }[] | null = await ctx.runQuery(
      api.easygov.dev.searchPacks,
      { jurisdiction, terms, mine: false },
    );
    const titles = (found ?? []).map((pack) => pack.title);
    return {
      checks: {
        found: expect === null ? titles.length === 0 : titles.includes(expect),
      },
      detail: `found: ${titles.join(" | ") || "nothing"}`,
      output: titles,
    };
  },
};

// --- Trials on a real case --------------------------------------------------
//
// "outcome" and "pipeline" start a real case and wait on its workflow. They
// never wait inside an action: an action that sleeps holds a slot the case's
// own workflow needs, and enough of them starve it. Each step looks once,
// acts once, and schedules the next look.

const POLL_MS = 1500;
/** Long enough for research and a draft. */
const CASE_TIMEOUT_MS = 6 * 60 * 1000;
const read = (ctx: ActionCtx, caseId: Id<"cases">): Promise<CaseView> =>
  ctx.runQuery(api.easygov.case.public.getCase, { caseId });
const sendTo = (ctx: ActionCtx, c: CaseView, event: CaseEvent): Promise<null> =>
  ctx.runMutation(api.easygov.case.public.sendEvent, {
    caseId: c._id,
    expectedSeq: c.seq,
    event,
  });

/** The goal a real-case trial states, if it starts from one. */
function goalOf(slice: Slice, caseId: string): string | undefined {
  if (slice === "outcome") return find(cases.outcome, caseId).goal;
  const { start } = find(cases.pipeline, caseId);
  return "goal" in start ? start.goal : undefined;
}

/**
 * Gets a real form ready to fill, as a person would on the forms page: fetch
 * it from its source, sign off its mapping, publish its pack. Each step is
 * the same thing done twice, so trials can share it.
 */
async function formPack(
  ctx: ActionCtx,
  form: typeof cases.FORM_8822,
): Promise<Id<"processPacks">> {
  const { code, title, jurisdiction, sourceUrl, delivery } = form;
  const formId: Id<"forms"> = await ctx.runMutation(
    api.easygov.forms.data.createForm,
    { code, title, jurisdiction, sourceUrl },
  );
  const { editionId }: { editionId: Id<"formEditions"> } = await ctx.runAction(
    api.easygov.forms.actions.fetchForm,
    { formId },
  );
  const edition: { targets: { id: string; label: string }[] } | null =
    await ctx.runQuery(api.easygov.forms.data.getEdition, { editionId });
  if (!edition) throw new Error("The fetched edition is missing");
  const mapping = form.mapping.map(({ label, entry }) => {
    const target = edition.targets.find((t) => new RegExp(label).test(t.label));
    if (!target) throw new Error(`No place on the form matches /${label}/`);
    return { target: target.id, ...entry };
  });
  await ctx.runMutation(api.easygov.forms.data.updateMapping, {
    editionId,
    mapping,
    reviewed: true,
  });
  return await ctx.runMutation(api.easygov.forms.data.publishPack, {
    editionId,
    delivery,
  });
}

/** Starts the trial's case; `stepCase` takes it from there. */
async function startCase(ctx: ActionCtx, slice: Slice, caseId: string) {
  const start =
    slice === "pipeline" ? find(cases.pipeline, caseId).start : undefined;
  let packId: Id<"processPacks"> | undefined;
  if (start && "form" in start) {
    packId = await formPack(ctx, start.form);
  } else if (start && "pack" in start) {
    const { packs }: { packs: Record<string, Id<"processPacks">> } =
      await ctx.runMutation(api.easygov.dev.seed, {});
    packId = packs[start.pack];
  }
  const id: Id<"cases"> = await ctx.runMutation(
    api.easygov.case.public.createCase,
    { packId, source: `eval:${slice}` },
  );
  // An eval is the operator's own spend: its case skips the rate limits.
  await ctx.runMutation(internal.easygov.evals.runner.unmeter, { caseId: id });
  return id;
}

/**
 * One look at a real-case trial: send the next thing a person would, or
 * grade the case if it has got where the trial is going.
 */
export const stepCase = internalAction({
  args: { trialId: v.id("easygovEvalTrials") },
  returns: v.null(),
  handler: async (ctx, { trialId }): Promise<null> => {
    const trial: Doc<"easygovEvalTrials"> | null = await ctx.runQuery(
      internal.easygov.evals.runner.trialOf,
      { trialId },
    );
    if (trial?.status !== "pending" || !trial.realCase) return null;
    const { slice, caseId } = trial;
    const { id, startedAt, goalSent } = trial.realCase;
    const again = (delay = POLL_MS) =>
      ctx.scheduler.runAfter(delay, internal.easygov.evals.runner.stepCase, {
        trialId,
      });
    const finish = async (result: Result | { error: string }) => {
      const c = await read(ctx, id);
      // Don't leave the case's workflow waiting on a person who has left.
      if (c.status === "active") await sendTo(ctx, c, { type: "case.cancel" });
      const ms = Date.now() - startedAt;
      await ctx.runMutation(internal.easygov.evals.runner.finishTrial, {
        trialId,
        outcome:
          "error" in result
            ? { status: "error", error: result.error, ms }
            : {
                status: passes(result.checks) ? "passed" : "failed",
                checks: result.checks,
                detail: result.detail,
                output: JSON.stringify(result.output, null, 1).slice(0, 20000),
                ms,
              },
      });
      return null;
    };
    try {
      const c = await read(ctx, id);
      const failed = c.run?.state === "failed";
      const settled = c.waitingFor || failed || c.status !== "active";
      if (!settled) {
        if (Date.now() - startedAt > CASE_TIMEOUT_MS) {
          return await finish({ error: "The case never settled" });
        }
        await again();
        return null;
      }
      const goal = goalOf(slice, caseId);
      if (goal && !goalSent) {
        await sendTo(ctx, c, { type: "goal.set", goal });
        await ctx.runMutation(internal.easygov.evals.runner.goalSent, {
          trialId,
        });
        await again();
        return null;
      }
      if (slice === "outcome") {
        const { expect } = find(cases.outcome, caseId);
        const got = outcomeOf(c);
        return await finish({
          checks: { outcome: got === expect, noFailure: !failed },
          detail: `${got}, expected ${expect}`,
          output: { selection: c.selection, run: c.run },
        });
      }
      const { pilot: options, expect } = find(cases.pipeline, caseId);
      const next = pilot(
        c,
        { ...options, until: "end" },
        new Date().toISOString().slice(0, 10),
      );
      // "wait" can't follow a settled case unless it's stuck on its own state.
      if (next === "stop" || next === "wait") {
        const { answers, artifact, delivery, referral, status, endReason } = c;
        // What the PDF itself holds, not what the case says it wrote.
        const storageId = artifact?.document?.storageId;
        const filled: FilledForm | undefined = storageId
          ? await ctx.runAction(internal.easygov.forms.actions.readFilled, {
              storageId,
            })
          : undefined;
        return await finish({
          ...gradePipeline(expect, c, filled),
          output: { status, endReason, answers, artifact, delivery, referral },
        });
      }
      await sendTo(
        ctx,
        c,
        "event" in next
          ? next.event
          : {
              type: "evidence.add",
              key: next.upload,
              name: `${next.upload}.txt`,
              storageId: await ctx.storage.store(
                new Blob([`Test file for ${next.upload}`], {
                  type: "text/plain",
                }),
              ),
            },
      );
      await again(0);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Something else wrote to the case between the look and the send: a
      // profile save reaches every open case. Look again.
      if (message.includes("The case has changed")) {
        await again();
        return null;
      }
      return await finish({ error: message }).catch(() => null);
    }
  },
});

export const trialOf = internalQuery({
  args: { trialId: v.id("easygovEvalTrials") },
  returns: v.union(doc(schema, "easygovEvalTrials"), v.null()),
  handler: async (ctx, { trialId }) =>
    await ctx.db.get("easygovEvalTrials", trialId),
});

export const caseStarted = internalMutation({
  args: { trialId: v.id("easygovEvalTrials"), id: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { trialId, id }) => {
    const trial = await ctx.db.get("easygovEvalTrials", trialId);
    if (trial?.status !== "pending") return null;
    await ctx.db.replace("easygovEvalTrials", trialId, {
      ...trial,
      realCase: { id, startedAt: Date.now(), goalSent: false },
    });
    await ctx.scheduler.runAfter(
      POLL_MS,
      internal.easygov.evals.runner.stepCase,
      { trialId },
    );
    return null;
  },
});

/** Marks an eval's case as exempt from the rate limits. Internal only. */
export const unmeter = internalMutation({
  args: { caseId: v.id("cases") },
  returns: v.null(),
  handler: async (ctx, { caseId }) => {
    await ctx.db.patch("cases", caseId, { unmetered: true });
    return null;
  },
});

export const goalSent = internalMutation({
  args: { trialId: v.id("easygovEvalTrials") },
  returns: v.null(),
  handler: async (ctx, { trialId }) => {
    const trial = await ctx.db.get("easygovEvalTrials", trialId);
    if (trial?.status !== "pending" || !trial.realCase) return null;
    await ctx.db.replace("easygovEvalTrials", trialId, {
      ...trial,
      realCase: { ...trial.realCase, goalSent: true },
    });
    return null;
  },
});

// --- The judge --------------------------------------------------------------

/** Asks a model whether a draft's questions are fair to put to the person. */
async function judgeQuestions(
  ctx: ActionCtx,
  process: string,
  questions: string[],
): Promise<{ verdict: "pass" | "fail"; reasoning: string }> {
  const { output, usage } = await generateText({
    model: languageModel,
    output: Output.object({
      schema: z.object({
        reasoning: z.string(),
        verdict: z.enum(["pass", "fail"]),
      }),
    }),
    prompt: [
      "You are grading the questions a form asks a person, before it writes a letter for them.",
      '"fail" if two questions ask for the same information under different names,',
      "or if a question asks for something the person would have to research",
      "(rules, eligibility conditions, which form applies).",
      "Asking what a notice, letter or ticket they were sent says is fine: that is theirs to read.",
      'Otherwise "pass".',
      `<process>${process}</process>`,
      `<questions>${JSON.stringify(questions)}</questions>`,
    ].join("\n"),
  });
  await chargeUsage(ctx, undefined, usage.totalTokens);
  return output;
}

/**
 * Asks a model what is wrong with the forms a trial found, against the
 * reviewer's reference for the case. It is told what to look for, since the
 * faults a code check can't see are the ones a hurried reader misses too.
 */
async function judgeForms(
  ctx: ActionCtx,
  reference: Reference,
  found: unknown,
): Promise<{ problems: string[] }> {
  const { output, usage } = await generateText({
    model: languageModel,
    output: Output.object({
      schema: z.object({ problems: z.array(z.string()) }),
    }),
    prompt: [
      "You are checking the official forms an assistant found for a person against a reviewer's reference,",
      "which was written from the authority's own pages and the files themselves.",
      "List each problem in one sentence. A problem is:",
      "- a form the reference lists that wasn't found, or has no file;",
      "- a file that isn't the edition the reference gives (compare the revision printed, as YYYYMM);",
      "- a file from somewhere other than where the authority publishes it: another government's copy,",
      "  a staging or test site, a sample, a rule-making or instruction document;",
      "- a translation given as the form;",
      "- the same form listed more than once for the same way of filing (`when`);",
      "- anything the reference calls a trap.",
      "Not a problem: a form the reference doesn't list, unless a trap names it; the same file at another",
      "address of the same site; a file that isn't backed; or a revision that gives the same year with no month.",
      "Return no problems if there are none.",
      `<reference>${JSON.stringify(reference)}</reference>`,
      `<found>${JSON.stringify(found)}</found>`,
    ].join("\n"),
  });
  await chargeUsage(ctx, undefined, usage.totalTokens);
  return output;
}

/** Grades known-good and known-bad questions, to check the judge itself. */
export const checkJudge = internalAction({
  args: { runId: v.id("easygovEvalRuns") },
  returns: v.null(),
  handler: async (ctx, { runId }): Promise<null> => {
    const { process, good, bad } = cases.judgeCheck;
    let judgeCheck;
    try {
      const [goodVerdict, badVerdict] = await Promise.all([
        judgeQuestions(ctx, process, good),
        judgeQuestions(ctx, process, bad),
      ]);
      judgeCheck = {
        goodPassed: goodVerdict.verdict === "pass",
        badFailed: badVerdict.verdict === "fail",
      };
    } catch (error) {
      judgeCheck = {
        goodPassed: false,
        badFailed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await ctx.runMutation(internal.easygov.evals.runner.recordJudgeCheck, {
      runId,
      judgeCheck,
    });
    return null;
  },
});

export const recordJudgeCheck = internalMutation({
  args: { runId: v.id("easygovEvalRuns"), judgeCheck: vJudgeCheck },
  returns: v.null(),
  handler: async (ctx, { runId, judgeCheck }) => {
    await ctx.db.patch("easygovEvalRuns", runId, { judgeCheck });
    return null;
  },
});

// --- Bookkeeping ------------------------------------------------------------

export const beginTrial = internalMutation({
  args: { trialId: v.id("easygovEvalTrials") },
  returns: v.object({
    slice: vSlice,
    caseId: v.string(),
    threadId: v.string(),
    saved: v.union(
      v.object({
        _id: v.id("easygovEvalCases"),
        _creationTime: v.number(),
        name: v.string(),
        ...draftInput,
      }),
      v.null(),
    ),
  }),
  handler: async (ctx, { trialId }): Promise<Begun> => {
    const trial = await ctx.db.get("easygovEvalTrials", trialId);
    if (!trial) throw new Error(`Eval trial ${trialId} not found`);
    const { slice, caseId, runId } = trial;
    // Usage lands under `eval:<runId>`, apart from real users.
    const threadId = await createThread(ctx, components.agent, {
      userId: `eval:${runId}`,
      title: `easygov eval: ${slice} / ${caseId} #${trial.trial}`,
    });
    const savedId = caseId.startsWith(SAVED)
      ? ctx.db.normalizeId("easygovEvalCases", caseId.slice(SAVED.length))
      : null;
    const saved = savedId
      ? await ctx.db.get("easygovEvalCases", savedId)
      : null;
    if (caseId.startsWith(SAVED) && !saved) {
      throw new Error(`The saved case ${caseId} is gone`);
    }
    // A trial whose action died without reporting, or whose chain of looks
    // at a real case broke, would stay pending, and its run would never be
    // done: this ends it.
    await ctx.scheduler.runAfter(
      TRIAL_TIMEOUT_MS,
      internal.easygov.evals.runner.expireTrial,
      { trialId },
    );
    return { slice, caseId, threadId, saved };
  },
});

/** Ends a pending trial, once, and counts it toward its run. */
async function endTrial(
  ctx: MutationCtx,
  trialId: Id<"easygovEvalTrials">,
  outcome: Infer<typeof vTrialOutcome>,
): Promise<void> {
  const trial = await ctx.db.get("easygovEvalTrials", trialId);
  if (trial?.status !== "pending") return;
  // The case it drove, if any, belongs to the pending trial only.
  const { realCase: _realCase, ...row } = trial;
  await ctx.db.replace("easygovEvalTrials", trialId, { ...row, ...outcome });
  const run = await ctx.db.get("easygovEvalRuns", trial.runId);
  if (!run) return;
  const finishedTrials = run.finishedTrials + 1;
  await ctx.db.patch("easygovEvalRuns", run._id, {
    finishedTrials,
    status: finishedTrials >= run.totalTrials ? "done" : "running",
  });
  if (run.serial) await startNext(ctx, run._id);
}

/** Starts a serial run's next trial: the first planned that is pending. */
async function startNext(
  ctx: MutationCtx,
  runId: Id<"easygovEvalRuns">,
): Promise<void> {
  // The index keeps the order the trials were planned in.
  const trials = await ctx.db
    .query("easygovEvalTrials")
    .withIndex("by_runId", (q) => q.eq("runId", runId))
    .take(1000);
  const next = trials.find((trial) => trial.status === "pending");
  if (!next) return;
  await ctx.scheduler.runAfter(0, internal.easygov.evals.runner.runTrial, {
    trialId: next._id,
  });
}

// --- What was already fetched -----------------------------------------------

/**
 * A row can carry a page's links (up to 400, each address at most 500
 * characters): few are read at a time, to stay well inside what one
 * mutation may read.
 */
const HELD_BATCH = 20;

/**
 * Counts the `formAddresses` rows held as a run starts, a batch at a time:
 * none is a cold run. A serial run's first trial starts once they are
 * counted.
 */
export const countHeld = internalMutation({
  args: {
    runId: v.id("easygovEvalRuns"),
    cursor: v.union(v.string(), v.null()),
    addresses: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { runId, cursor, addresses }) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("formAddresses")
      .paginate({ numItems: HELD_BATCH, cursor });
    addresses = Math.min(addresses + page.length, HELD_COUNT_CAP);
    if (!isDone && addresses < HELD_COUNT_CAP) {
      await ctx.scheduler.runAfter(0, internal.easygov.evals.runner.countHeld, {
        runId,
        cursor: continueCursor,
        addresses,
      });
      return null;
    }
    const run = await ctx.db.get("easygovEvalRuns", runId);
    if (!run) return null;
    await ctx.db.patch("easygovEvalRuns", runId, {
      heldAtStart: { addresses },
    });
    if (run.serial) await startNext(ctx, runId);
    return null;
  },
});

/** Deletes a batch of the addresses no form is remembered at. */
async function forgetBatch(ctx: MutationCtx): Promise<void> {
  const rows = await ctx.db
    .query("formAddresses")
    .withIndex("by_chosen_jurisdiction_and_chosen_bare", (q) =>
      q.eq("chosen.jurisdiction", undefined),
    )
    .take(HELD_BATCH);
  for (const row of rows) await ctx.db.delete("formAddresses", row._id);
  if (rows.length < HELD_BATCH) return;
  await ctx.scheduler.runAfter(
    0,
    internal.easygov.evals.runner.forgetMoreFetched,
    {},
  );
}

/**
 * Forgets how official addresses answered, so the next run starts cold. The
 * addresses remembered for a form (`chosen`) stay. It works in batches:
 * start the run once `formAddresses` holds only those.
 */
export const forgetFetched = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireOperator(ctx);
    await forgetBatch(ctx);
    return null;
  },
});

export const forgetMoreFetched = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await forgetBatch(ctx);
    return null;
  },
});

export const finishTrial = internalMutation({
  args: { trialId: v.id("easygovEvalTrials"), outcome: vTrialOutcome },
  returns: v.null(),
  handler: async (ctx, { trialId, outcome }) => {
    await endTrial(ctx, trialId, outcome);
    return null;
  },
});

/**
 * Ends a trial that is still pending long after it should have finished, as
 * an error, and cancels the case it was driving. Does nothing to a trial
 * that has ended.
 */
export const expireTrial = internalMutation({
  args: { trialId: v.id("easygovEvalTrials") },
  returns: v.null(),
  handler: async (ctx, { trialId }) => {
    const trial = await ctx.db.get("easygovEvalTrials", trialId);
    if (trial?.status !== "pending") return null;
    const c = trial.realCase && (await ctx.db.get("cases", trial.realCase.id));
    // Don't leave the case's workflow waiting on a person who has left.
    if (c?.status === "active") {
      await ctx.runMutation(api.easygov.case.public.sendEvent, {
        caseId: c._id,
        expectedSeq: c.seq,
        event: { type: "case.cancel" },
      });
    }
    await endTrial(ctx, trialId, {
      status: "error",
      error: "The trial never finished",
      ms: TRIAL_TIMEOUT_MS,
    });
    return null;
  },
});

// --- Reading results --------------------------------------------------------

const vTally = v.object({
  passed: v.number(),
  graded: v.number(),
  errors: v.number(),
});

/**
 * Recent runs, newest first. For each slice and each case: how many graded
 * trials passed. Crashed trials count under `errors`, not as failures.
 */
export const runs = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      runId: v.id("easygovEvalRuns"),
      startedAt: v.number(),
      note: v.string(),
      models: v.string(),
      status: v.union(v.literal("running"), v.literal("done")),
      finishedTrials: v.number(),
      totalTrials: v.number(),
      judgeOk: v.union(v.boolean(), v.null()),
      /** Whether its trials ran one at a time. */
      serial: v.boolean(),
      /** The fetched rows held when it started; null until counted. */
      heldAtStart: v.union(vHeld, v.null()),
      slices: v.record(v.string(), vTally),
      /** By "slice / case": e.g. "2/3". */
      cases: v.record(v.string(), v.string()),
    }),
  ),
  handler: async (ctx, { limit = 10 }) => {
    await requireOperator(ctx);
    const found = await ctx.db
      .query("easygovEvalRuns")
      .order("desc")
      .take(limit);
    const rows = [];
    for (const run of found) {
      const trials = await ctx.db
        .query("easygovEvalTrials")
        .withIndex("by_runId", (q) => q.eq("runId", run._id))
        .take(1000);
      const tally = () => ({ passed: 0, graded: 0, errors: 0 });
      const slices: Record<string, ReturnType<typeof tally>> = {};
      const byCase: Record<string, ReturnType<typeof tally>> = {};
      for (const trial of trials) {
        // Record keys are ASCII: a case's name may not be.
        const key = `${trial.slice} / ${trial.caseId}`.replace(/[^ -~]/g, "?");
        for (const count of [
          (slices[trial.slice] ??= tally()),
          (byCase[key] ??= tally()),
        ]) {
          if (trial.status === "passed") count.passed++;
          if (trial.status === "passed" || trial.status === "failed") {
            count.graded++;
          }
          if (trial.status === "error") count.errors++;
        }
      }
      rows.push({
        runId: run._id,
        startedAt: run._creationTime,
        note: run.note,
        models: run.models,
        status: run.status,
        finishedTrials: run.finishedTrials,
        totalTrials: run.totalTrials,
        judgeOk: run.judgeCheck
          ? run.judgeCheck.goodPassed && run.judgeCheck.badFailed
          : null,
        serial: run.serial ?? false,
        heldAtStart: run.heldAtStart ?? null,
        slices,
        cases: Object.fromEntries(
          Object.entries(byCase).map(([key, c]) => [
            key,
            `${c.passed}/${c.graded}${c.errors ? ` (+${c.errors} crashed)` : ""}`,
          ]),
        ),
      });
    }
    return rows;
  },
});

/**
 * What the people in a run's forms trials ended up holding: how many of the
 * forms they needed came out each way (see `FORM_OUTCOMES`), and how often
 * a form came out as the same file in every trial of its case. `wrongUnwarned`
 * is the one that harms a filer; a form that is a different file from one
 * trial to the next can't be trusted even when each trial passes.
 */
export const quality = query({
  args: { runId: v.id("easygovEvalRuns") },
  returns: v.object({
    forms: v.number(),
    outcomes: v.record(v.string(), v.number()),
    /** Forms asked for in two trials or more, and those the same each time. */
    repeated: v.number(),
    sameEachTime: v.number(),
  }),
  handler: async (ctx, { runId }) => {
    await requireOperator(ctx);
    const trials = await ctx.db
      .query("easygovEvalTrials")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .take(1000);
    const outcomes: Record<string, number> = Object.fromEntries(
      FORM_OUTCOMES.map((outcome) => [outcome, 0]),
    );
    // The file each trial chose, by case and form.
    const chosen = new Map<string, (string | undefined)[]>();
    for (const trial of trials) {
      const graded = "forms" in trial ? (trial.forms ?? []) : [];
      for (const { code, outcome, file } of graded) {
        outcomes[outcome]++;
        const key = `${trial.caseId}\n${code}`;
        chosen.set(key, [...(chosen.get(key) ?? []), file]);
      }
    }
    const repeated = [...chosen.values()].filter((files) => files.length > 1);
    return {
      forms: Object.values(outcomes).reduce((sum, n) => sum + n, 0),
      outcomes,
      repeated: repeated.length,
      sameEachTime: repeated.filter(
        (files) => files[0] !== undefined && new Set(files).size === 1,
      ).length,
    };
  },
});

/**
 * What a run's trials took, by slice: the mean time and the mean of each
 * thing counted, over the trials that were graded. For comparing two runs.
 */
export const costs = query({
  args: { runId: v.id("easygovEvalRuns") },
  returns: v.record(
    v.string(),
    v.object({
      trials: v.number(),
      meanMs: v.number(),
      maxMs: v.number(),
      mean: v.record(v.string(), v.number()),
    }),
  ),
  handler: async (ctx, { runId }) => {
    await requireOperator(ctx);
    const found = await ctx.db
      .query("easygovEvalTrials")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .take(1000);
    const round = (n: number) => Math.round(n * 10) / 10;
    const bySlice: Record<string, typeof found> = {};
    for (const trial of found) (bySlice[trial.slice] ??= []).push(trial);
    return Object.fromEntries(
      Object.entries(bySlice).flatMap(([slice, all]) => {
        const graded = all.flatMap((t) =>
          t.status === "passed" || t.status === "failed" ? [t] : [],
        );
        if (!graded.length) return [];
        const sums: Record<string, number> = {};
        for (const { cost } of graded) {
          for (const [key, n] of Object.entries(cost ?? {})) {
            sums[key] = (sums[key] ?? 0) + n;
          }
        }
        return [
          [
            slice,
            {
              trials: graded.length,
              meanMs: Math.round(
                graded.reduce((sum, t) => sum + t.ms, 0) / graded.length,
              ),
              maxMs: Math.max(...graded.map((t) => t.ms)),
              mean: Object.fromEntries(
                Object.entries(sums).map(([key, sum]) => [
                  key,
                  round(sum / graded.length),
                ]),
              ),
            },
          ],
        ];
      }),
    );
  },
});

/** A run's trials, in the order they were planned. */
export const trials = query({
  args: { runId: v.id("easygovEvalRuns"), failedOnly: v.optional(v.boolean()) },
  returns: v.array(vTrialView),
  handler: async (ctx, { runId, failedOnly }) => {
    await requireOperator(ctx);
    const found = await ctx.db
      .query("easygovEvalTrials")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .take(1000);
    return found
      .filter(
        (t) => !failedOnly || t.status === "failed" || t.status === "error",
      )
      .map((found) => {
        const { _id, _creationTime, runId: _runId, ...trial } = found;
        if (trial.status !== "pending") return trial;
        const { realCase: _realCase, ...pending } = trial;
        return pending;
      });
  },
});

// --- Cases saved from real drafts -------------------------------------------

/**
 * Saves a case's draft as a draft eval case: the process and the research
 * notes it was written from, to replay against a changed prompt.
 */
export const saveDraftCase = mutation({
  args: { caseId: v.id("cases"), name: v.optional(v.string()) },
  returns: v.id("easygovEvalCases"),
  handler: async (ctx, { caseId, name }) => {
    await requireOperator(ctx);
    const found = await ctx.db.get("cases", caseId);
    const selection = chosen(found?.selection);
    if (!found || selection?.kind !== "draft") {
      throw new ConvexError("That case has no draft.");
    }
    const { draft, research } = selection;
    return await ctx.db.insert("easygovEvalCases", {
      name: name?.trim() || draft.title,
      process: found.goal?.text ?? draft.title,
      jurisdiction: draft.jurisdiction,
      authority: draft.authority,
      forms: draft.forms,
      notes: research ?? "",
    });
  },
});

export const savedCases = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("easygovEvalCases"),
      name: v.string(),
      jurisdiction: v.string(),
      hasNotes: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    await requireOperator(ctx);
    const rows = await ctx.db.query("easygovEvalCases").order("desc").take(100);
    return rows.map(({ _id, name, jurisdiction, notes }) => ({
      id: _id,
      name,
      jurisdiction,
      hasNotes: notes !== "",
    }));
  },
});

export const removeSavedCase = mutation({
  args: { id: v.id("easygovEvalCases") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperator(ctx);
    await ctx.db.delete("easygovEvalCases", id);
    return null;
  },
});
