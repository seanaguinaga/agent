// The review of recent cases: what people corrected, beside the spans the
// agents' calls saved.
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { resetCases, send, start } from "./case/cases.testkit";

vi.mock("../modelsForDemo", async () =>
  (await import("./case/cases.testkit")).mockModels(),
);

afterEach(resetCases);

test("a week's review counts corrections and shows the agents' steps", async () => {
  const { t, caseId } = await start();
  await send(t, caseId, { type: "goal.set", goal: "Something" });
  await send(t, caseId, { type: "pack.reject" });
  const eval_ = await start();
  await eval_.t.run((ctx) =>
    ctx.db.patch("cases", eval_.caseId, { unmetered: true }),
  );
  await send(eval_.t, eval_.caseId, { type: "goal.set", goal: "Something" });
  await send(eval_.t, eval_.caseId, { type: "pack.reject" });

  const review = await t.query(internal.easygov.review.lastDays, {});
  const threadId = (await t.run((ctx) => ctx.db.get("cases", caseId)))!
    .threadId;
  // The eval's case isn't a person's.
  expect(review.corrections).toEqual([
    {
      kind: "pack.rejected",
      count: 1,
      examples: [{ caseId, threadId, detail: undefined }],
    },
  ]);
  // Proposing read the request with the model, on the case's thread.
  const read = review.agents.steps.find(
    (step) =>
      step.agent === "easygov/readRequest" &&
      step.name === "invoke_agent easygov/readRequest",
  );
  expect(read?.examples.map((e) => e.threadId)).toContain(threadId);
});
