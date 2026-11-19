// `waitingFor` with plain values: no Convex, no workflow.
import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { fingerprint } from "./answers";
import { PHASES, WAITS } from "./schema";
import { phase, waitingFor, type Case } from "./state";

const packId = "pack" as Id<"processPacks">;
const base = {
  _id: "case" as Id<"cases">,
  _creationTime: 0,
  userId: "u",
  threadId: "t",
  status: "active",
  seq: 0,
  answers: {},
  documents: {},
} satisfies Case;

/** A pack asking for `a` and `b`, as a selection holds it. */
const pack = {
  kind: "pack" as const,
  goalVersion: 1,
  definition: { id: packId, inputs: ["a", "b"] },
};
const failed = {
  state: "failed",
  error: "boom",
  workflowId: "w" as never,
} as const;

/** A case with a goal and a confirmed pack asking for `a` and `b`. */
function confirmed(extra: Partial<Case> = {}): Case {
  return {
    ...base,
    intake: { goal: "Do it", version: 1 },
    processPack: {
      status: "confirmed",
      kind: "pack",
      goalVersion: 1,
      definition: { id: packId, inputs: ["a", "b"] },
    },
    ...extra,
  };
}

describe("waitingFor", () => {
  test("a goal, until one stands", () => {
    expect(waitingFor(base)).toBe("goal");
    const rejected = confirmed({
      processPack: { status: "rejected", goalVersion: 1, reason: "person" },
    });
    expect(waitingFor(rejected)).toBe("goal");
  });

  test("the pack, while one is proposed for the current goal", () => {
    const proposed = confirmed({
      processPack: { ...pack, status: "proposed" },
    });
    expect(waitingFor(proposed)).toBe("pack");
    // Made for an earlier goal: nothing to decide yet; a proposal is coming.
    const stale = confirmed({
      intake: { goal: "Something else", version: 2 },
      processPack: { ...pack, status: "proposed" },
    });
    expect(waitingFor(stale)).toBeNull();
  });

  test("answers, then approval once the document matches them", () => {
    expect(waitingFor(confirmed())).toBe("answers");
    const answers = { a: "1", b: "2" };
    // All answered, document not built yet: the workflow is busy.
    expect(waitingFor(confirmed({ answers }))).toBeNull();
    const artifact = { summary: "", fingerprint: fingerprint(answers) };
    expect(waitingFor(confirmed({ answers, artifact }))).toBe("approval");
    const approval = { fingerprint: artifact.fingerprint };
    expect(waitingFor(confirmed({ answers, artifact, approval }))).toBeNull();
    // An answer changed in review: the document is out of date, so busy.
    const edited = { ...answers, b: "3" };
    expect(waitingFor(confirmed({ answers: edited, artifact }))).toBeNull();
  });

  test("nothing after a failure, for a referral, or once ended", () => {
    expect(waitingFor(confirmed({ run: failed }))).toBeNull();
    expect(waitingFor(confirmed({ status: "done" }))).toBeNull();
  });

  test("a required file, along with the answers", () => {
    const answers = { a: "1", b: "2" };
    const needsFile = confirmed({
      answers,
      processPack: {
        status: "confirmed",
        kind: "pack",
        goalVersion: 1,
        definition: {
          id: packId,
          inputs: ["a", "b"],
          documents: [
            { key: "notice", label: "The notice", required: true },
            { key: "extra", label: "Anything else", required: false },
          ],
        },
      },
    });
    expect(waitingFor(needsFile)).toBe("answers");
    const documents = { notice: "file" as Id<"_storage"> };
    // All in, document not built yet: the workflow is busy.
    expect(waitingFor({ ...needsFile, documents })).toBeNull();
  });

  test("consent, while a referral is offered", () => {
    const offered = { kind: "advice", status: "offered" } as const;
    const advice = confirmed({
      processPack: { status: "confirmed", kind: "referral", goalVersion: 1 },
    });
    expect(waitingFor({ ...advice, referral: offered })).toBe("consent");
    expect(
      waitingFor({ ...advice, referral: { ...offered, status: "declined" } }),
    ).toBeNull();

    // With a pack, only once the document is approved.
    const answers = { a: "1", b: "2" };
    const artifact = { summary: "", fingerprint: fingerprint(answers) };
    const inReview = confirmed({ answers, artifact, referral: offered });
    expect(waitingFor(inReview)).toBe("approval");
    const approval = { fingerprint: artifact.fingerprint };
    expect(waitingFor({ ...inReview, approval })).toBe("consent");
    expect(
      waitingFor({
        ...inReview,
        approval,
        referral: { ...offered, status: "shared" },
      }),
    ).toBeNull();
  });
});

describe("phase", () => {
  const answers = { a: "1", b: "2" };
  const artifact = { summary: "", fingerprint: fingerprint(answers) };
  const approval = { fingerprint: artifact.fingerprint };
  const offered = { kind: "advice", status: "offered" } as const;
  /** One case in each phase, in the order a case goes through them. */
  const each: [(typeof PHASES)[number], Case][] = [
    ["intake", base],
    ["proposing", { ...base, intake: { goal: "Do it", version: 1 } }],
    ["pack", confirmed({ processPack: { ...pack, status: "proposed" } })],
    ["reading", confirmed({ suggested: { goalVersion: 1 } })],
    ["answers", confirmed({ suggested: { goalVersion: 1, answers: {} } })],
    ["filling", confirmed({ answers })],
    ["approval", confirmed({ answers, artifact })],
    ["consent", confirmed({ answers, artifact, approval, referral: offered })],
    ["finishing", confirmed({ answers, artifact, approval })],
    ["failed", confirmed({ run: failed })],
    ["done", confirmed({ status: "done" })],
    ["stopped", confirmed({ status: "stopped" })],
    ["canceled", confirmed({ status: "canceled" })],
  ];

  test("names every situation, including the ones nobody is asked in", () => {
    expect(each.map(([name]) => name)).toEqual([...PHASES]);
    for (const [name, c] of each) expect(phase(c)).toBe(name);
  });

  test("says what the person is asked for, and `waitingFor` follows it", () => {
    for (const [name, c] of each) {
      expect(waitingFor(c)).toBe(WAITS[name] ?? null);
    }
  });

  test("goes back: a rejected pack to intake, a changed answer to filling", () => {
    const rejected = confirmed({
      processPack: { status: "rejected", goalVersion: 1, reason: "person" },
    });
    expect(phase(rejected)).toBe("intake");
    const edited = confirmed({ answers: { ...answers, b: "3" }, artifact });
    expect(phase(edited)).toBe("filling");
  });
});
