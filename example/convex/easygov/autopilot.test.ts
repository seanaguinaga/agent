import { expect, test } from "vitest";
import {
  answerFor,
  pilot,
  shiftDate,
  type CaseView,
  type PilotOptions,
} from "./autopilot";

const TODAY = "2026-11-19";
const run: PilotOptions = {
  until: "end",
  referral: "trigger",
  consent: "share",
};
const wagePack = {
  id: "pack1",
  inputs: ["fullName", "amountOwed", "lastWorkDate"],
  documents: [
    { key: "payStub", label: "Pay stub", required: true },
    { key: "contract", label: "Offer letter", required: false },
  ],
  deadline: { label: "File", fromInput: "lastWorkDate", days: 1095 },
  referral: {
    kind: "employment",
    when: { input: "amountOwed", atLeast: 5000 },
  },
};
function view(fields: Partial<CaseView>): CaseView {
  return {
    status: "active",
    seq: 1,
    userId: "test user",
    answers: {},
    documents: {},
    waitingFor: null,
    deadline: null,
    suggestions: {},
    profileInputs: {},
    ...fields,
  } as CaseView;
}
const onPack = (fields: Partial<CaseView>) =>
  view({
    intake: { goal: "wages", version: 1 },
    processPack: {
      status: "confirmed",
      goalVersion: 1,
      definition: wagePack,
    } as CaseView["processPack"],
    ...fields,
  });

test("answers steer the referral check and satisfy date inputs", () => {
  const pack = wagePack as Parameters<typeof answerFor>[0];
  expect(answerFor(pack, "amountOwed", "trigger", TODAY)).toBe("5000");
  expect(answerFor(pack, "amountOwed", "avoid", TODAY)).toBe("4999");
  expect(answerFor(pack, "lastWorkDate", "trigger", TODAY)).toBe("2026-10-20");
  expect(answerFor(pack, "fullName", "trigger", TODAY)).toBe("Ada Lovelace");
  expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
});

test("fills inputs in order, then required files, then waits for the workflow", () => {
  expect(pilot(onPack({ waitingFor: "answers" }), run, TODAY)).toEqual({
    event: { type: "answers.set", key: "fullName", value: "Ada Lovelace" },
  });
  const answered = {
    fullName: "Ada",
    amountOwed: "5000",
    lastWorkDate: "2026-10-20",
  };
  expect(
    pilot(onPack({ waitingFor: "answers", answers: answered }), run, TODAY),
  ).toEqual({ upload: "payStub" });
  expect(pilot(onPack({ waitingFor: null }), run, TODAY)).toBe("wait");
});

test("hands the case back where it was told to", () => {
  expect(
    pilot(
      onPack({ waitingFor: "answers" }),
      { ...run, until: "answers" },
      TODAY,
    ),
  ).toBe("stop");
  expect(
    pilot(
      onPack({ waitingFor: "consent", approval: { fingerprint: "f" } }),
      { ...run, until: "approved" },
      TODAY,
    ),
  ).toBe("stop");
  expect(pilot(view({ waitingFor: "goal" }), run, TODAY)).toBe("stop");
  expect(pilot(view({ status: "done" }), run, TODAY)).toBe("stop");
  expect(
    pilot(view({ failure: { error: "x" } } as Partial<CaseView>), run, TODAY),
  ).toBe("stop");
});

test("a guest is not made to share, but can decline", () => {
  const guest = onPack({ waitingFor: "consent", userId: "guest:key" });
  expect(pilot(guest, run, TODAY)).toBe("stop");
  expect(pilot(guest, { ...run, consent: "decline" }, TODAY)).toEqual({
    event: { type: "referral.decline" },
  });
});

test("accepts what the case offers back, unless this run is steering that answer", () => {
  const offered = onPack({
    waitingFor: "answers",
    suggestions: { fullName: "Ada Lovelace" },
  });
  expect(pilot(offered, run, TODAY)).toEqual({
    event: { type: "answers.accept" },
  });
  // Last time's amount would decide the referral: answer it afresh instead.
  const steered = onPack({
    waitingFor: "answers",
    suggestions: { amountOwed: "5000" },
  });
  expect(pilot(steered, { ...run, referral: "avoid" }, TODAY)).toEqual({
    event: { type: "answers.set", key: "fullName", value: "Ada Lovelace" },
  });
});
