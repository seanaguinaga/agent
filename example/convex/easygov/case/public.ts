// The public API: start a case, read it, chat, and send it events.
import {
  createThread,
  listUIMessages,
  saveMessage,
  syncStreams,
  vStreamArgs,
} from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import { getAuthUserId } from "../../utils";
import { sha256Hex } from "../hash";
import { vCaseDoc } from "../schema";
import { currentVersion } from "../packs/data";
import {
  endCase,
  logCaseEvent,
  processPackDefinition,
  writeCase,
} from "./data";
import { currentFacts, scheduleSync, syncCase } from "../profile/data";
import { FACT_KEYS, factOf } from "../profile/vocabulary";
import { request, take, type PersonEvent } from "./events";
import { addFollowUp, remove } from "./evidence";
import {
  vCaseEvent,
  vHistoryKind,
  vPhase,
  vWaitingFor,
  type CaseEvent,
} from "./schema";
import {
  asks,
  currentSelection,
  evidenceAsks,
  isGuest,
  lawyerDoor,
  conflictingSuggestions,
  deadlineOf,
  phase,
  requiredInputs,
  suggestions,
  waitingFor,
  type Case,
} from "./state";
import { limits } from "../limits";
import { advance, workflow } from "./workflow";

/**
 * Starts a case. With a `packId` (from a landing page) the case starts on
 * that pack: there's no chat and no proposal, and it waits for the answers.
 * `source` says where the case came from, e.g. the page's name.
 *
 * With a `guestKey` the case needs no account. The key is a secret the
 * client makes up (a UUID or longer) and keeps: it's the only way back to
 * the case until `claimCase` moves it to an account.
 */
export const createCase = mutation({
  args: {
    packId: v.optional(v.id("processPacks")),
    source: v.optional(v.string()),
    guestKey: v.optional(v.string()),
  },
  returns: v.id("cases"),
  handler: async (ctx, { packId, source, guestKey }): Promise<Id<"cases">> => {
    const userId = await caller(ctx, guestKey);
    const pack = packId ? await currentVersion(ctx, packId) : null;
    if (packId && !pack) throw new ConvexError("Process pack not found.");
    const threadId = await createThread(ctx, components.agent, {
      userId,
      title: "easygov case",
    });
    const caseId = await ctx.db.insert("cases", {
      userId,
      source: source?.trim().slice(0, 200) || undefined,
      threadId,
      status: "active",
      seq: 0,
      answers: {},
      evidence: [],
      // Choosing the page is choosing the pack: it starts out accepted.
      ...(pack && {
        goal: { text: pack.title, version: 1 },
        selection: {
          status: "accepted" as const,
          kind: "pack" as const,
          goalVersion: 1,
          definition: processPackDefinition(pack),
        },
      }),
    });
    // Started on a pack, there's work at once. Otherwise nothing runs until
    // the person says something.
    await advance(ctx, caseId);
    // Started on a pack: what the profile already knows is filled in.
    await syncCase(ctx, caseId);
    await logCaseEvent(ctx, caseId, "case.started");
    return caseId;
  },
});

/** The case as its owner reads it: all but what only the server uses. */
const {
  unmetered: _unmetered,
  lastMessageKey: _lastMessageKey,
  ...publicCaseFields
} = vCaseDoc.fields;

const vAsk = v.object({
  key: v.string(),
  question: v.string(),
  /** What the answer must be; without one, any text. */
  kind: v.optional(v.union(v.literal("date"), v.literal("number"))),
  choices: v.optional(
    v.array(v.object({ value: v.string(), label: v.string() })),
  ),
  multiple: v.optional(v.boolean()),
  answer: v.optional(v.string()),
  /** On offer for the person to accept: not an answer yet. */
  suggestion: v.optional(v.string()),
  /** The sources disagree: the person picks one, or types another. */
  conflict: v.optional(v.array(v.string())),
  /** The profile fact this reads. Answer it with `profile/public:setFact`. */
  fact: v.optional(v.string()),
  /** The answer came from the profile and changes with it. */
  following: v.boolean(),
});

const vEvidenceAsk = v.object({
  key: v.string(),
  label: v.string(),
  required: v.boolean(),
  attached: v.number(),
});

/** One row of a list of cases. */
const vCaseRow = v.object({
  id: v.id("cases"),
  startedAt: v.number(),
  status: v.string(),
  phase: vPhase,
  waitingFor: vWaitingFor,
  goal: v.optional(v.string()),
  source: v.optional(v.string()),
  deadline: v.union(
    v.object({ label: v.string(), date: v.string() }),
    v.null(),
  ),
});

/** The caller's cases, newest first, a page at a time. */
export const listCases = query({
  args: {
    paginationOpts: paginationOptsValidator,
    guestKey: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(vCaseRow),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { paginationOpts, guestKey }) => {
    const userId = await caller(ctx, guestKey);
    const { page, isDone, continueCursor } = await ctx.db
      .query("cases")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(paginationOpts);
    return {
      page: page.map((row) => ({
        id: row._id,
        startedAt: row._creationTime,
        status: row.status,
        phase: phase(row),
        waitingFor: waitingFor(row),
        goal: row.goal?.text,
        source: row.source,
        deadline: deadlineOf(row) ?? null,
      })),
      isDone,
      continueCursor,
    };
  },
});

/** How much history one call returns: more than a case writes. */
const MAX_HISTORY = 300;

/** What happened on the case, oldest first. */
export const listHistory = query({
  args: { caseId: v.id("cases"), guestKey: v.optional(v.string()) },
  returns: v.array(
    v.object({
      at: v.number(),
      kind: vHistoryKind,
      detail: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { caseId, guestKey }) => {
    await authorizeCase(ctx, caseId, guestKey);
    const rows = await ctx.db
      .query("caseEvents")
      .withIndex("by_caseId", (q) => q.eq("caseId", caseId))
      .take(MAX_HISTORY);
    return rows.map(({ _creationTime, kind, detail }) => ({
      at: _creationTime,
      kind,
      detail,
    }));
  },
});

/**
 * The case's conversation, for `useUIMessages`. That hook passes a
 * `threadId`, so the case's own is asked for, and anything else is refused:
 * only the case's owner reads its thread.
 */
export const listMessages = query({
  args: {
    caseId: v.id("cases"),
    threadId: v.string(),
    guestKey: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, { caseId, threadId, guestKey, ...args }) => {
    const found = await authorizeCase(ctx, caseId, guestKey);
    if (found.threadId !== threadId) throw new ConvexError("Case not found.");
    const paginated = await listUIMessages(ctx, components.agent, {
      threadId,
      paginationOpts: args.paginationOpts,
    });
    const streams = await syncStreams(ctx, components.agent, {
      threadId,
      streamArgs: args.streamArgs,
    });
    return { ...paginated, streams };
  },
});

/** The case, what it waits for a person to do, and the date to act by. */
export const getCase = query({
  args: { caseId: v.id("cases"), guestKey: v.optional(v.string()) },
  returns: v.object({
    ...publicCaseFields,
    /** Started without an account: it's claimed before it can be shared. */
    guest: v.boolean(),
    /** Intake has a message of the person's it hasn't answered yet. */
    replying: v.boolean(),
    /**
     * What to ask, in order, once a process is accepted: each question as
     * the pack words it, what it takes, and where its answer stands. A page
     * renders this as it is; it needn't read the pinned definition.
     */
    asks: v.array(vAsk),
    /** The files the process asks for, and how many of each are attached. */
    files: v.array(vEvidenceAsk),
    /**
     * Whether `referral.request` is taken now, and why to suggest it: a
     * `decision` against the person has come in, or the process is a
     * `contested` one that lawyers take.
     */
    lawyer: v.object({
      available: v.boolean(),
      reason: v.optional(
        v.union(v.literal("decision"), v.literal("contested")),
      ),
    }),
    /** Where the case is, by name: see `PHASES`. */
    phase: vPhase,
    waitingFor: vWaitingFor,
    deadline: v.union(
      v.object({ label: v.string(), date: v.string() }),
      v.null(),
    ),
    /**
     * Answers on offer, still waiting to be accepted: found in what the
     * person said, or remembered from their profile.
     */
    suggestions: v.record(v.string(), v.string()),
    /**
     * The profile fact behind each input that reads one, by input key. To
     * answer such an input, save the fact (`profile/public:setFact`).
     */
    profileInputs: v.record(v.string(), v.string()),
    /** A link to each attached file, by its storage id. */
    evidenceUrls: v.record(v.string(), v.string()),
    conflicts: v.record(v.string(), v.array(v.string())),
    documentUrls: v.record(v.string(), v.string()),
  }),
  handler: async (ctx, { caseId, guestKey }) => {
    const found = await authorizeCase(ctx, caseId, guestKey);
    const evidenceUrls: Record<string, string> = {};
    for (const { storageId } of found.evidence) {
      const url = await ctx.storage.getUrl(storageId);
      if (url) evidenceUrls[storageId] = url;
    }
    const documentUrls: Record<string, string> = {};
    for (const document of [
      ...(found.artifact?.documents ?? []),
      ...(found.artifact?.document ? [found.artifact.document] : []),
    ]) {
      const url = await ctx.storage.getUrl(document.storageId);
      if (url) documentUrls[document.storageId] = url;
    }
    // What only the server reads stays here.
    const { unmetered: _unmetered, lastMessageKey: _key, ...shown } = found;
    return {
      conflicts: conflictingSuggestions(found),
      documentUrls,
      evidenceUrls,
      ...shown,
      guest: isGuest(found),
      replying: found.pendingMessageId !== undefined,
      asks: asks(found),
      files: evidenceAsks(found),
      lawyer: lawyerDoor(found),
      phase: phase(found),
      waitingFor: waitingFor(found),
      deadline: deadlineOf(found) ?? null,
      suggestions: suggestions(found),
      profileInputs: Object.fromEntries(
        (requiredInputs(found) ?? []).flatMap((key) => {
          const fact = factOf(key);
          return fact ? [[key, fact]] : [];
        }),
      ),
    };
  },
});

/**
 * Moves a guest's case to the signed-in account. The key stops working, and
 * the case can then be shared with a lawyer.
 */
export const claimCase = mutation({
  args: { caseId: v.id("cases"), guestKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { caseId, guestKey }) => {
    const userId = await requireUser(ctx);
    await authorizeCase(ctx, caseId, guestKey);
    // What the guest told us comes along, where the account has nothing.
    const guest = await currentFacts(ctx, await caller(ctx, guestKey));
    const own = await currentFacts(ctx, userId);
    for (const key of FACT_KEYS) {
      const value = guest.facts[key];
      if (value !== undefined && own.facts[key] === undefined) {
        await ctx.db.insert("profileFacts", { userId, key, value });
      }
    }
    await writeCase(ctx, caseId, { userId });
    await syncCase(ctx, caseId);
    await logCaseEvent(ctx, caseId, "case.claimed");
    return null;
  },
});

/**
 * Takes back a case shared with a lawyer, while no firm has accepted it.
 * Returns false if there was nothing to take back: nothing was shared, or a
 * firm already has it.
 */
export const withdrawReferral = mutation({
  args: { caseId: v.id("cases"), guestKey: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { caseId, guestKey }) => {
    const found = await authorizeCase(ctx, caseId, guestKey);
    const kind = found.referral?.kind;
    const referral =
      kind === undefined
        ? null
        : await ctx.db
            .query("referrals")
            .withIndex("by_caseId_and_kind", (q) =>
              q.eq("caseId", caseId).eq("kind", kind),
            )
            // The newest: one taken back or expired may come before it.
            .order("desc")
            .first();
    if (kind === undefined || referral?.status !== "open") return false;
    await ctx.db.replace("referrals", referral._id, {
      ...referral,
      status: "withdrawn",
    });
    // The case says so too: it's no longer shared with anyone.
    await writeCase(ctx, caseId, { referral: { kind, status: "withdrawn" } });
    await logCaseEvent(ctx, caseId, "referral.withdrawn", kind);
    return true;
  },
});

/**
 * Where to upload a file for the case. Post the file to the URL, with its
 * media type as the `Content-Type`, then send `evidence.add` with the
 * storage id it returns. A done case takes files too: what came afterwards.
 */
export const createUploadUrl = mutation({
  args: { caseId: v.id("cases"), guestKey: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, { caseId, guestKey }) => {
    const found = await authorizeCase(ctx, caseId, guestKey);
    if (found.status !== "active" && found.status !== "done") {
      throw new ConvexError(`The case is ${found.status}.`);
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Saves a chat message to the case's thread. Intake answers it: at once
 * while the case waits for a goal (after the reply it's writing, if any), or
 * when a proposed pack is rejected. Once
 * a pack is accepted there's no intake left, and a message is refused.
 *
 * `messageKey` is a string the client makes up once per message (a UUID,
 * say) and sends again on a retry. The same key twice in a row is the same
 * message, and is saved once.
 */
export const sendMessage = mutation({
  args: {
    caseId: v.id("cases"),
    text: v.string(),
    messageKey: v.string(),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, text, messageKey, guestKey }) => {
    const found = await authorizeCase(ctx, caseId, guestKey);
    if (found.status !== "active") {
      throw new ConvexError(`The case is ${found.status}.`);
    }
    // Only intake answers chat, and it's over once a pack is accepted.
    if (currentSelection(found)?.status === "accepted") {
      throw new ConvexError(
        "The process is chosen: answer its questions instead of chatting.",
      );
    }
    const prompt = text.trim();
    if (!prompt) throw new ConvexError("Type a message first.");
    if (!messageKey) throw new ConvexError("The message needs a key.");
    if (found.lastMessageKey === messageKey) return null;
    if (!found.unmetered) {
      await limits.limit(ctx, "caseMessages", {
        key: found.userId,
        throws: true,
      });
    }
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId: found.threadId,
      userId: found.userId,
      prompt,
    });
    await writeCase(ctx, caseId, {
      pendingMessageId: messageId,
      lastMessageKey: messageKey,
    });
    await advance(ctx, caseId);
    return null;
  },
});

/** Events that only add what the person gave: taken on a stale view. */
const DATA_ENTRY = new Set<CaseEvent["type"]>([
  "answers.set",
  "evidence.add",
  "evidence.update",
  "evidence.remove",
]);

/**
 * Sends an event to a case. `expectedSeq` is the `seq` the sender last saw,
 * so a decision based on a stale view of the case is refused. An answer or
 * a file is taken either way.
 */
export const sendEvent = mutation({
  args: {
    caseId: v.id("cases"),
    event: vCaseEvent,
    expectedSeq: v.number(),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, event, expectedSeq, guestKey }) => {
    const found = await authorizeCase(ctx, caseId, guestKey);
    // The guard is for decisions: nobody should accept what
    // changed while they weren't looking. Typing an answer or attaching a
    // file isn't one: it writes its own key, whatever else moved.
    if (found.seq !== expectedSeq && !DATA_ENTRY.has(event.type)) {
      throw new ConvexError("The case has changed. Reload and try again.");
    }
    if (found.status !== "active") {
      if (
        found.status === "done" &&
        event.type === "artifact.reassess" &&
        found.artifact
      ) {
        await writeCase(ctx, caseId, {
          status: "active",
          accepted: undefined,
          delivery: undefined,
          reassess: true,
        });
        await advance(ctx, caseId);
        return null;
      }
      // What came back may be a denial: the person can ask for a lawyer then.
      if (found.status === "done" && event.type === "referral.request") {
        await writeCase(ctx, caseId, await request(ctx, found));
        return null;
      }
      // A finished case still takes what comes afterwards: the receipt, and
      // whatever the authority sends back.
      if (found.status === "done" && event.type === "evidence.add") {
        if (event.key !== undefined) {
          throw new ConvexError("The case is done: attach it without a key.");
        }
        await writeCase(ctx, caseId, await addFollowUp(ctx, found, event));
        return null;
      }
      if (found.status === "done" && event.type === "evidence.remove") {
        const { storageId } = event;
        const followUp = { followUp: true };
        await writeCase(
          ctx,
          caseId,
          await remove(ctx, found, storageId, followUp),
        );
        return null;
      }
      throw new ConvexError(`The case is ${found.status}.`);
    }
    switch (event.type) {
      case "case.cancel":
        return await cancel(ctx, found);
      case "case.retry":
        return await retry(ctx, found);
      case "case.stop":
        if (found.run?.state !== "failed") {
          throw new ConvexError("Nothing has failed.");
        }
        await endCase(ctx, found, "stopped", "Stopped after a failure");
        return null;
      default:
        return await personEvent(ctx, found, event);
    }
  },
});

/** Writes what the event's handler returns, then starts what comes next. */
async function personEvent(
  ctx: MutationCtx,
  c: Case,
  event: PersonEvent,
): Promise<null> {
  await writeCase(ctx, c._id, await take(ctx, c, event));
  // What this case reads from the profile may have changed. An answer may
  // also have gone to the profile, which the person's other open cases read:
  // those pick it up in their own transactions.
  await syncCase(ctx, c._id);
  if (event.type === "answers.set" || event.type === "answers.accept") {
    await scheduleSync(ctx, c.userId);
  }
  await advance(ctx, c._id);
  return null;
}

/**
 * Drops the failed work and starts what the case needs now. Nothing lives
 * only in a workflow's history, so new work picks up where the case is.
 */
async function retry(ctx: MutationCtx, c: Case): Promise<null> {
  if (c.run?.state !== "failed") throw new ConvexError("Nothing has failed.");
  await writeCase(ctx, c._id, { run: undefined });
  await logCaseEvent(ctx, c._id, "case.retried");
  await advance(ctx, c._id);
  return null;
}

/** Ends the case, and stops its workflow if one is running. */
async function cancel(ctx: MutationCtx, c: Case): Promise<null> {
  // A failed workflow isn't running, and can't be canceled.
  if (c.run?.state === "running") await workflow.cancel(ctx, c.run.workflowId);
  await endCase(ctx, c, "canceled", "Canceled by the user");
  return null;
}

// --- Who may touch a case ---------------------------------------------------

export async function requireUser(ctx: QueryCtx): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Sign in first.");
  return userId;
}

/** A guest key is the only thing guarding its case, so it must be long. */
const MIN_GUEST_KEY = 32;

/** Who is calling: the guest with this key, or the signed-in user. */
export async function caller(
  ctx: QueryCtx,
  guestKey?: string,
): Promise<string> {
  if (guestKey === undefined) return await requireUser(ctx);
  if (guestKey.length < MIN_GUEST_KEY) {
    throw new ConvexError("The guest key is too short.");
  }
  // Only the key's hash is stored: reading the table doesn't give the key.
  return `guest:${sha256Hex(guestKey)}`;
}

/** The case, if it belongs to the caller. */
async function authorizeCase(
  ctx: QueryCtx,
  caseId: Id<"cases">,
  guestKey?: string,
): Promise<Case> {
  const userId = await caller(ctx, guestKey);
  const found = await ctx.db.get("cases", caseId);
  if (!found || found.userId !== userId) {
    throw new ConvexError("Case not found.");
  }
  return found;
}

export const handoff = query({
  args: { caseId: v.id("cases"), guestKey: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      firm: v.optional(v.string()),
      status: v.string(),
      questions: v.array(
        v.object({
          id: v.id("referralQuestions"),
          question: v.string(),
          answer: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx, { caseId, guestKey }) => {
    const c = await authorizeCase(ctx, caseId, guestKey);
    if (!c.referral) return null;
    const referral = await ctx.db
      .query("referrals")
      .withIndex("by_caseId_and_kind", (q) =>
        q.eq("caseId", caseId).eq("kind", c.referral!.kind),
      )
      .order("desc")
      .first();
    if (!referral) return null;
    const firm =
      referral.status === "accepted"
        ? await ctx.db.get("firms", referral.firmId)
        : null;
    const rows = await ctx.db
      .query("referralQuestions")
      .withIndex("by_referralId", (q) => q.eq("referralId", referral._id))
      .order("desc")
      .take(50);
    return {
      firm: firm?.name,
      status: referral.status,
      questions: rows.map(({ _id, question, answer }) => ({
        id: _id,
        question,
        answer,
      })),
    };
  },
});

export const answerLawyer = mutation({
  args: {
    caseId: v.id("cases"),
    questionId: v.id("referralQuestions"),
    answer: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, questionId, answer }) => {
    await authorizeCase(ctx, caseId);
    const request = await ctx.db.get("referralQuestions", questionId);
    if (!request || request.caseId !== caseId)
      throw new ConvexError("Question not found.");
    if (request.answer !== undefined || !answer.trim() || answer.length > 6000)
      throw new ConvexError("Send one answer of up to 6,000 characters.");
    await ctx.db.patch("referralQuestions", questionId, {
      answer: answer.trim(),
    });
    return null;
  },
});
