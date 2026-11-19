// The public API: start a case, read it, chat, and send it events.
import { createThread, saveMessage } from "@convex-dev/agent";
import { ConvexError, v } from "convex/values";
import { components, internal } from "../../_generated/api";
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
import { take, type PersonEvent } from "./events";
import { attachFollowUp, remove } from "./files";
import { vCaseEvent, vPhase, vWaitingFor, type CaseEvent } from "./schema";
import {
  currentSelection,
  deadlineOf,
  phase,
  pinnedPack,
  suggestions,
  waitingFor,
  type Case,
} from "./state";
import { nudgeCase, nudgeIfMoved, workflow } from "./workflow";

/**
 * Starts a case. With a `packId` (from a landing page) the case starts on
 * that pack: there's no chat and no proposal, and it waits for the answers.
 * `source` says where the case came from, e.g. the page's name.
 *
 * With a `guestKey` the case needs no account. The key is a secret the
 * client makes up (a UUID or longer) and keeps: it's the only way back to
 * the case until `claimCase` moves it to an account.
 */
export const startCase = mutation({
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
      files: [],
      // Choosing the page is choosing the pack: it starts out confirmed.
      ...(pack && {
        intake: { goal: pack.title, version: 1 },
        selection: {
          status: "confirmed" as const,
          kind: "pack" as const,
          goalVersion: 1,
          definition: processPackDefinition(pack),
        },
      }),
    });
    const workflowId = await workflow.start(
      ctx,
      internal.easygov.case.workflow.run,
      { caseId },
      {
        onComplete: internal.easygov.case.data.workflowDone,
        context: { caseId },
        // Not inline: a run that fails at once would report back before the
        // case knows its workflow id, and be ignored.
        startAsync: true,
      },
    );
    await writeCase(ctx, caseId, { run: { state: "running", workflowId } });
    // Started on a pack: what the profile already knows is filled in.
    await syncCase(ctx, caseId);
    await logCaseEvent(ctx, caseId, "case.started");
    return caseId;
  },
});

/** The case, what it waits for a person to do, and the date to act by. */
export const getCase = query({
  args: { caseId: v.id("cases"), guestKey: v.optional(v.string()) },
  returns: v.object({
    ...vCaseDoc.fields,
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
     * answer such an input, save the fact (`profile/public:save`).
     */
    profileInputs: v.record(v.string(), v.string()),
    /** A link to each attached file, by its storage id. */
    fileUrls: v.record(v.string(), v.string()),
  }),
  handler: async (ctx, { caseId, guestKey }) => {
    const found = await authorizeCase(ctx, caseId, guestKey);
    const fileUrls: Record<string, string> = {};
    for (const { storageId } of found.files) {
      const url = await ctx.storage.getUrl(storageId);
      if (url) fileUrls[storageId] = url;
    }
    return {
      fileUrls,
      ...found,
      phase: phase(found),
      waitingFor: waitingFor(found),
      deadline: deadlineOf(found) ?? null,
      suggestions: suggestions(found),
      profileInputs: Object.fromEntries(
        (pinnedPack(found)?.inputs ?? []).flatMap((key) => {
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
 * media type as the `Content-Type`, then send `document.attach` with the
 * storage id it returns. A done case takes files too: what came afterwards.
 */
export const uploadUrl = mutation({
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
 * while the case waits for a goal, or when a proposed pack is rejected. Once
 * a pack is confirmed there's no intake left, and a message is refused.
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
    // Only intake answers chat, and it's over once a pack is confirmed.
    if (currentSelection(found)?.status === "confirmed") {
      throw new ConvexError(
        "The process is chosen: answer its questions instead of chatting.",
      );
    }
    const prompt = text.trim();
    if (!prompt) throw new ConvexError("Type a message first.");
    if (!messageKey) throw new ConvexError("The message needs a key.");
    if (found.lastMessageKey === messageKey) return null;
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId: found.threadId,
      userId: found.userId,
      prompt,
    });
    await writeCase(ctx, caseId, {
      pendingMessageId: messageId,
      lastMessageKey: messageKey,
    });
    await nudgeCase(ctx, found);
    return null;
  },
});

/** Events that only add what the person gave: taken on a stale view. */
const DATA_ENTRY = new Set<CaseEvent["type"]>([
  "answers.set",
  "document.attach",
  "document.label",
  "document.remove",
]);

/**
 * Sends an event to a case. `expectedSeq` is the `seq` the sender last saw,
 * so a decision based on a stale view of the case is refused. An answer or
 * a file is taken either way.
 */
export const send = mutation({
  args: {
    caseId: v.id("cases"),
    event: vCaseEvent,
    expectedSeq: v.number(),
    guestKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, event, expectedSeq, guestKey }) => {
    const found = await authorizeCase(ctx, caseId, guestKey);
    // The guard is for decisions: nobody should approve or confirm what
    // changed while they weren't looking. Typing an answer or attaching a
    // file isn't one: it writes its own key, whatever else moved.
    if (found.seq !== expectedSeq && !DATA_ENTRY.has(event.type)) {
      throw new ConvexError("The case has changed. Reload and try again.");
    }
    if (found.status !== "active") {
      // A finished case still takes what comes afterwards: the receipt, and
      // whatever the authority sends back.
      if (found.status === "done" && event.type === "document.attach") {
        if (event.key !== undefined) {
          throw new ConvexError("The case is done: attach it without a key.");
        }
        await writeCase(ctx, caseId, await attachFollowUp(ctx, found, event));
        return null;
      }
      if (found.status === "done" && event.type === "document.remove") {
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
      case "step.retry":
        return await retry(ctx, found);
      case "step.cancel":
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

/** Writes what the event's handler returns, then tells the workflow. */
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
  await nudgeIfMoved(ctx, c);
  return null;
}

/**
 * Runs the failed workflow again from the top. Nothing it needs lives only
 * in its history, so it picks up where the case is.
 */
async function retry(ctx: MutationCtx, c: Case): Promise<null> {
  if (c.run?.state !== "failed") throw new ConvexError("Nothing has failed.");
  const { workflowId } = c.run;
  await workflow.restart(ctx, workflowId, { from: 0 });
  await writeCase(ctx, c._id, { run: { state: "running", workflowId } });
  await logCaseEvent(ctx, c._id, "case.retried");
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
