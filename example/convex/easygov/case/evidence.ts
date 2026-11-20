// A case's evidence: the letter that started it, the evidence behind it, and
// what comes back once it's filed. A file is uploaded to storage first
// (`createUploadUrl`), then attached here, and read once by a model: what it
// states is offered as answers, and is all any later step sees of it.
import { saveMessage } from "@convex-dev/agent";
import { ConvexError, v, type Infer } from "convex/values";
import { components, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../../_generated/server";
import { readableAs, readDocument, type Question } from "./agents";
import { offerFact } from "../profile/data";
import { vFoundFacts } from "./schema";
import { attachedLine, logCaseEvent, openQuestions, writeCase } from "./data";
import { vEvidenceRead, type Evidence } from "./schema";
import { pinnedPack, waitingFor, type Case } from "./state";
import { advance } from "./workflow";

/** Enough for a thick case, and a bounded case row. */
export const MAX_EVIDENCE = 30;
const MB = 1024 * 1024;
export const MAX_FILE_BYTES = 20 * MB;
/** Past this a file is kept but not sent to the model. */
const MAX_READ_BYTES = 10 * MB;

type Upload = { storageId: Id<"_storage">; name?: string };

/** Attaches an uploaded file to a case that's still being put together. */
export async function add(
  ctx: MutationCtx,
  c: Case,
  { key, ...upload }: Upload & { key?: string },
): Promise<Partial<Case>> {
  if (key === undefined) return keep(ctx, c, await uploaded(ctx, c, upload));
  requireAsked(c, key);
  const named = { ...upload, name: upload.name ?? key };
  const file = await uploaded(ctx, c, named);
  return keep(ctx, c, { ...file, key });
}

/** Attaches what came once the case was done: a receipt, or a reply. */
export async function addFollowUp(
  ctx: MutationCtx,
  c: Case,
  upload: Upload,
): Promise<Partial<Case>> {
  const file = await uploaded(ctx, c, upload);
  return keep(ctx, c, { ...file, followUp: true });
}

/** Says which of the pack's documents an attached file is, or (no key) none. */
export function update(
  c: Case,
  storageId: Id<"_storage">,
  key?: string,
): Partial<Case> {
  const { key: _was, ...file } = attached(c, storageId, { followUp: false });
  if (key !== undefined) requireAsked(c, key);
  const labelled = key === undefined ? file : { ...file, key };
  return {
    evidence: c.evidence.map((other) =>
      other.storageId === storageId ? labelled : other,
    ),
  };
}

/** Takes a file off the case, and out of storage unless a lawyer has it. */
export async function remove(
  ctx: MutationCtx,
  c: Case,
  storageId: Id<"_storage">,
  which: { followUp: boolean },
): Promise<Partial<Case>> {
  const file = attached(c, storageId, which);
  // A case that was shared gave the lawyer its files. Follow-ups never are.
  const shared =
    !which.followUp &&
    (await ctx.db
      .query("referrals")
      .withIndex("by_caseId_and_kind", (q) => q.eq("caseId", c._id))
      .first());
  if (!shared) await ctx.storage.delete(storageId);
  await logCaseEvent(ctx, c._id, "evidence.removed", file.name);
  return {
    evidence: c.evidence.filter((other) => other.storageId !== storageId),
  };
}

function requireAsked(c: Case, key: string): void {
  if (!pinnedPack(c)?.evidence?.some((document) => document.key === key)) {
    throw new ConvexError(`"${key}" isn't one of this case's documents.`);
  }
}

/** The case's file, or its follow-up: one doesn't pass for the other. */
function attached(
  c: Case,
  storageId: Id<"_storage">,
  { followUp }: { followUp: boolean },
): Evidence {
  const file = c.evidence.find((file) => file.storageId === storageId);
  if (!file || !!file.followUp !== followUp) {
    throw new ConvexError("That file isn't attached.");
  }
  return file;
}

/** Why a file isn't sent to the model, if it isn't. */
function unreadable(mediaType: string, size: number): string | undefined {
  if (!readableAs(mediaType)) return "This kind of file is kept, but not read.";
  if (size > MAX_READ_BYTES) return "It's too large to read, but it's kept.";
  return undefined;
}

/** The upload as a case keeps it, if the case has room for it. */
async function uploaded(
  ctx: MutationCtx,
  c: Case,
  { storageId, name }: Upload,
): Promise<Evidence> {
  if (c.evidence.some((file) => file.storageId === storageId)) {
    throw new ConvexError("That file is already attached.");
  }
  if (c.evidence.length >= MAX_EVIDENCE) {
    throw new ConvexError(`A case holds up to ${MAX_EVIDENCE} files.`);
  }
  const stored = await ctx.db.system.get("_storage", storageId);
  if (!stored) throw new ConvexError("Upload the file first.");
  const { size, contentType } = stored;
  if (size > MAX_FILE_BYTES) {
    await ctx.storage.delete(storageId);
    throw new ConvexError(`A file can be up to ${MAX_FILE_BYTES / MB} MB.`);
  }
  // "text/plain; charset=utf-8" is text/plain.
  const mediaType =
    contentType?.split(";")[0].trim().toLowerCase() ||
    "application/octet-stream";
  const reason = unreadable(mediaType, size);
  return {
    storageId,
    name: name?.trim().slice(0, 200) || "file",
    mediaType,
    size,
    read: reason ? { status: "unread", reason } : { status: "reading" },
  };
}

/** Puts the file on the case, and starts reading it if it can be read. */
async function keep(
  ctx: MutationCtx,
  c: Case,
  file: Evidence,
): Promise<Partial<Case>> {
  if (file.read.status === "reading") {
    await ctx.scheduler.runAfter(0, internal.easygov.case.evidence.read, {
      caseId: c._id,
      storageId: file.storageId,
    });
  }
  await logCaseEvent(
    ctx,
    c._id,
    "evidence.added",
    file.followUp ? `${file.name} (after filing)` : file.name,
  );
  return { evidence: [...c.evidence, file] };
}

// --- Reading ----------------------------------------------------------------

/** What reading a file needs, or null if there's nothing left to read. */
export const readInput = internalQuery({
  args: { caseId: v.id("cases"), storageId: v.id("_storage") },
  returns: v.union(
    v.object({
      threadId: v.string(),
      name: v.string(),
      mediaType: v.string(),
      questions: v.array(
        v.object({
          key: v.string(),
          question: v.string(),
          kind: v.optional(v.union(v.literal("date"), v.literal("number"))),
        }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, { caseId, storageId }) => {
    const found = await ctx.db.get("cases", caseId);
    const file = found?.evidence.find((file) => file.storageId === storageId);
    if (!found || file?.read.status !== "reading") return null;
    return {
      threadId: found.threadId,
      name: file.name,
      mediaType: file.mediaType,
      // A follow-up answers nothing: the case's questions are settled.
      questions:
        found.status === "active" && !file.followUp ? openQuestions(found) : [],
    };
  },
});

/**
 * Reads an attached file with a model. A failure isn't worth more than a
 * note on the file: the person types the answers, as they would have.
 */
export const read = internalAction({
  args: { caseId: v.id("cases"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { caseId, storageId }): Promise<null> => {
    const input: {
      threadId: string;
      name: string;
      mediaType: string;
      questions: Question[];
    } | null = await ctx.runQuery(internal.easygov.case.evidence.readInput, {
      caseId,
      storageId,
    });
    if (!input) return null;
    const { threadId, name, mediaType, questions } = input;
    let found: Infer<typeof vEvidenceRead>;
    let facts: Infer<typeof vFoundFacts> | undefined;
    try {
      const blob = await ctx.storage.get(storageId);
      if (!blob) throw new Error("The file is gone");
      const bytes = await blob.arrayBuffer();
      const parsed = await readDocument(
        ctx,
        threadId,
        { name, mediaType, bytes },
        questions,
      );
      const { summary, answers, adverse } = parsed;
      facts = parsed.facts;
      found = {
        status: "read",
        summary,
        ...(Object.keys(answers).length > 0 && { answers }),
        ...(adverse && { adverse }),
      };
    } catch (error) {
      console.error("easygov file read failed", error);
      found = { status: "unread", reason: "It couldn't be read." };
    }
    await ctx.runMutation(internal.easygov.case.evidence.recordRead, {
      caseId,
      storageId,
      read: found,
      facts,
    });
    return null;
  },
});

/**
 * Keeps what reading found. While the case still waits for a goal, what
 * the file states goes into the conversation as the person's own message:
 * intake answers it, so a case can start from the letter alone.
 */
export const recordRead = internalMutation({
  args: {
    caseId: v.id("cases"),
    storageId: v.id("_storage"),
    read: vEvidenceRead,
    facts: v.optional(vFoundFacts),
  },
  returns: v.null(),
  handler: async (ctx, { caseId, storageId, read, facts }) => {
    const found = await ctx.db.get("cases", caseId);
    const file = found?.evidence.find((file) => file.storageId === storageId);
    // Removed meanwhile, or already read: nothing to keep.
    if (!found || file?.read.status !== "reading") return null;
    for (const entry of facts ?? [])
      await offerFact(ctx, found, entry.fact, entry.text, file.name);
    const now = { ...file, read };
    const patch: Partial<Case> = {
      evidence: found.evidence.map((other) => (other === file ? now : other)),
    };
    const line = attachedLine(now);
    if (line && waitingFor(found) === "goal") {
      const { messageId } = await saveMessage(ctx, components.agent, {
        threadId: found.threadId,
        userId: found.userId,
        prompt: line,
      });
      patch.pendingMessageId = messageId;
    }
    await writeCase(ctx, caseId, patch);
    await advance(ctx, caseId);
    return null;
  },
});
