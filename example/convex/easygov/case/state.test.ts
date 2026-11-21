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
  evidence: [],
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

/** A case with a goal and an accepted pack asking for `a` and `b`. */
function withPack(extra: Partial<Case> = {}): Case {
  return {
    ...base,
    goal: { text: "Do it", version: 1 },
    selection: {
      status: "accepted",
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
    const rejected = withPack({
      selection: { status: "rejected", goalVersion: 1, reason: "person" },
    });
    expect(waitingFor(rejected)).toBe("goal");
  });

  test("the pack, while one is proposed for the current goal", () => {
    const proposed = withPack({
      selection: { ...pack, status: "proposed" },
    });
    expect(waitingFor(proposed)).toBe("pack");
    // Made for an earlier goal: nothing to decide yet; a proposal is coming.
    const stale = withPack({
      goal: { text: "Something else", version: 2 },
      selection: { ...pack, status: "proposed" },
    });
    expect(waitingFor(stale)).toBeNull();
  });

  test("answers, then accepted once the document matches them", () => {
    expect(waitingFor(withPack())).toBe("answers");
    const answers = { a: "1", b: "2" };
    // All answered, document not built yet: the workflow is busy.
    expect(waitingFor(withPack({ answers }))).toBeNull();
    const artifact = { summary: "", fingerprint: fingerprint(answers) };
    expect(waitingFor(withPack({ answers, artifact }))).toBe("review");
    const accepted = { fingerprint: artifact.fingerprint };
    expect(waitingFor(withPack({ answers, artifact, accepted }))).toBeNull();
    // An answer changed in review: the document is out of date, so busy.
    const edited = { ...answers, b: "3" };
    expect(waitingFor(withPack({ answers: edited, artifact }))).toBeNull();
  });

  test("nothing after a failure, for a referral, or once ended", () => {
    expect(waitingFor(withPack({ run: failed }))).toBeNull();
    expect(waitingFor(withPack({ status: "done" }))).toBeNull();
  });

  test("a required file, along with the answers", () => {
    const answers = { a: "1", b: "2" };
    const needsFile = withPack({
      answers,
      selection: {
        status: "accepted",
        kind: "pack",
        goalVersion: 1,
        definition: {
          id: packId,
          inputs: ["a", "b"],
          evidence: [
            { key: "notice", label: "The notice", required: true },
            { key: "extra", label: "Anything else", required: false },
          ],
        },
      },
    });
    expect(waitingFor(needsFile)).toBe("answers");
    const file = {
      storageId: "file" as Id<"_storage">,
      name: "notice.pdf",
      mediaType: "application/pdf",
      size: 1,
      read: { status: "reading" as const },
    };
    // Other evidence isn't the notice, and neither is a follow-up.
    expect(waitingFor({ ...needsFile, evidence: [file] })).toBe("answers");
    expect(
      waitingFor({
        ...needsFile,
        evidence: [{ ...file, key: "notice", followUp: true as const }],
      }),
    ).toBe("answers");
    // All in, document not built yet: the workflow is busy.
    expect(
      waitingFor({ ...needsFile, evidence: [{ ...file, key: "notice" }] }),
    ).toBeNull();
  });

  test("consent, while a referral is offered", () => {
    const offered = { kind: "advice", status: "offered" } as const;
    const advice = withPack({
      selection: { status: "accepted", kind: "referral", goalVersion: 1 },
    });
    expect(waitingFor({ ...advice, referral: offered })).toBe("consent");
    expect(
      waitingFor({ ...advice, referral: { ...offered, status: "rejected" } }),
    ).toBeNull();

    // With a pack, only once the document is accepted.
    const answers = { a: "1", b: "2" };
    const artifact = { summary: "", fingerprint: fingerprint(answers) };
    const inReview = withPack({ answers, artifact, referral: offered });
    expect(waitingFor(inReview)).toBe("review");
    const accepted = { fingerprint: artifact.fingerprint };
    expect(waitingFor({ ...inReview, accepted })).toBe("consent");
    expect(
      waitingFor({
        ...inReview,
        accepted,
        referral: { ...offered, status: "shared" },
      }),
    ).toBeNull();
  });
});

describe("phase", () => {
  const answers = { a: "1", b: "2" };
  const artifact = { summary: "", fingerprint: fingerprint(answers) };
  const accepted = { fingerprint: artifact.fingerprint };
  const offered = { kind: "advice", status: "offered" } as const;
  /** One case in each phase, in the order a case goes through them. */
  const each: [(typeof PHASES)[number], Case][] = [
    ["intake", base],
    ["proposing", { ...base, goal: { text: "Do it", version: 1 } }],
    ["pack", withPack({ selection: { ...pack, status: "proposed" } })],
    ["suggesting", withPack({ chatSuggestions: { goalVersion: 1 } })],
    ["answers", withPack({ chatSuggestions: { goalVersion: 1, answers: {} } })],
    ["filling", withPack({ answers })],
    ["review", withPack({ answers, artifact })],
    ["consent", withPack({ answers, artifact, accepted, referral: offered })],
    ["finishing", withPack({ answers, artifact, accepted })],
    ["failed", withPack({ run: failed })],
    ["done", withPack({ status: "done" })],
    ["stopped", withPack({ status: "stopped" })],
    ["canceled", withPack({ status: "canceled" })],
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
    const rejected = withPack({
      selection: { status: "rejected", goalVersion: 1, reason: "person" },
    });
    expect(phase(rejected)).toBe("intake");
    const edited = withPack({ answers: { ...answers, b: "3" }, artifact });
    expect(phase(edited)).toBe("filling");
  });
});

test("a route change keeps common inputs and replaces route-specific form and letter inputs",async()=>{
  const {requiredInputs,conflictingSuggestions,suggestions}=await import("./state");
  const c=withPack({selection:{...pack,status:"accepted",definition:{inputs:["method"],packetForms:[{code:"X",sourceUrl:"",inputs:["caseNumber"],when:{key:"method",equals:"mail"}}],letterRoute:{key:"method",equals:"letter",inputs:["letterDate"]}}},answers:{method:"mail"},profileSuggestions:{caseNumber:"A"},chatSuggestions:{goalVersion:1,answers:{caseNumber:"B"}}});
  expect(requiredInputs(c)).toEqual(["method","caseNumber"]);
  expect(conflictingSuggestions(c)).toEqual({caseNumber:["A","B"]});
  expect(suggestions(c)).toEqual({});
  expect(requiredInputs({...c,answers:{method:"letter"}})).toEqual(["method","letterDate"]);
});

describe("a form no official page links", () => {
  const form = {
    code: "X-1",
    sourceUrl: "https://example.org/x-1.pdf",
    inputs: [],
  };
  const mail = { key: "method", equals: "mail" };
  const holding = (packetForms: object[], answers = {}) =>
    withPack({
      answers,
      selection: {
        ...pack,
        status: "accepted",
        definition: { inputs: [], packetForms: packetForms as never },
      },
    });

  test("is left for the person to check, by name and file", async () => {
    const { unbackedForms, editionCheck } = await import("./state");
    const c = holding([{ ...form, backed: false }]);
    expect(unbackedForms(c).map(({ code }) => code)).toEqual(["X-1"]);
    const item = editionCheck(form);
    expect(item).toContain("X-1");
    expect(item).toContain(form.sourceUrl);
    expect(item).toMatch(/current edition on the authority’s own site/);
  });

  test("a backed form, and one that doesn't say, leave nothing", async () => {
    const { unbackedForms } = await import("./state");
    expect(unbackedForms(holding([{ ...form, backed: true }, form]))).toEqual(
      [],
    );
  });

  test("only counts on the route the person takes", async () => {
    const { unbackedForms } = await import("./state");
    const forms = [{ ...form, backed: false, when: mail }];
    expect(unbackedForms(holding(forms, { method: "online" }))).toEqual([]);
    expect(unbackedForms(holding(forms, { method: "mail" }))).toHaveLength(1);
  });
});
