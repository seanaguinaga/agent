/// <reference types="vite/client" />
// Completeness checks: they fail when a stage is half-added. Each message
// says which step is missing.
import { getFunctionName } from "convex/server";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import {
  caseFields,
  EVENTS,
  eventShapes,
  FIELDS,
  type CaseEvent,
} from "../case/schema";
import { bootstrapPlan, validatePlanStep } from "../plans/steps";
import type { Case } from "../case/data";
import { eventHandler, STAGES } from "./registry";
import type { StageEvents } from "./shared";

vi.mock("../../modelsForDemo", async () =>
  (await import("../case/cases.testkit")).mockModels(),
);

type Module = Record<string, unknown>;
const files = import.meta.glob<Module>(["./*/*.ts", "!./*/*.test.ts"], {
  eager: true,
});

const stages = Object.entries(STAGES);
const names = Object.keys(STAGES);

/** The `type` literal an event shape declares. */
const typeOf = (shape: unknown) =>
  (shape as { fields: { type: { value: string } } }).fields.type.value;

describe("every stage is whole", () => {
  test("every stage folder is registered, and nothing else is", () => {
    const folders = new Set(
      Object.keys(files).map((path) => path.split("/")[1]),
    );
    expect([...folders].sort(), "registry.ts").toEqual([...names].sort());
    const { core: _core, ...stageFields } = FIELDS;
    expect(Object.keys(stageFields).sort(), "FIELDS in case/schema.ts").toEqual(
      [...names].sort(),
    );
  });

  test.each(stages)("%s has params, events and a workflow", (name, stage) => {
    // `stages/<name>/workflow.ts` exports `params`, `chats` and `run`, and the
    // registry lists those very values.
    const workflowFile = files[`./${name}/workflow.ts`];
    expect(workflowFile, `${name}/workflow.ts is missing`).toBeDefined();
    expect(workflowFile?.params, "workflow.ts must export params").toBe(
      stage.params,
    );
    expect(stage.params.safeParse, "params: a zod schema").toBeTypeOf(
      "function",
    );
    expect(workflowFile?.chats, "workflow.ts must export chats").toBe(
      stage.chats,
    );
    expect(stage.chats).toBeTypeOf("boolean");
    expect(workflowFile?.run, "workflow.ts must export run").toBeTypeOf(
      "function",
    );
    expect(getFunctionName(stage.workflow)).toBe(
      `easygov/stages/${name}/workflow:run`,
    );

    // `stages/<name>/events.ts` exists exactly when the stage owns events,
    // and the registry lists its `events`.
    const eventsFile = files[`./${name}/events.ts`];
    if (Object.keys(stage.events).length === 0) {
      expect(
        eventsFile,
        `${name}/events.ts has nothing to hold`,
      ).toBeUndefined();
    } else {
      expect(eventsFile?.events, `${name}/events.ts must export events`).toBe(
        stage.events,
      );
    }
  });

  test("stage files are named for their job", () => {
    const roles = ["workflow", "events", "data", "agent"];
    for (const path of Object.keys(files)) {
      const [, , file] = path.split("/");
      expect(roles, path).toContain(file.replace(/\.ts$/, ""));
    }
  });
});

describe("events", () => {
  const rows: [string, { owner: string; alsoDuring?: readonly string[] }][] =
    Object.entries(EVENTS);
  const ownedBy = (owner: string) =>
    rows.filter(([, row]) => row.owner === owner).map(([type]) => type);

  test("the core events are the three the case itself takes", () => {
    expect(ownedBy("core").sort()).toEqual(
      ["case.cancel", "step.cancel", "step.retry"].sort(),
    );
  });

  test("there is one event shape per row, carrying the row's type", () => {
    expect(eventShapes.map(typeOf)).toEqual(Object.keys(EVENTS));
    const event = { type: "intake.submit", goal: "I moved" } as const;
    expectTypeOf(event).toExtend<CaseEvent>();
  });

  test("every row names a real owner and real stages", () => {
    for (const [type, { owner, alsoDuring = [] }] of rows) {
      expect(Object.keys(FIELDS), type).toContain(owner);
      for (const stage of alsoDuring) expect(names, type).toContain(stage);
      expect(alsoDuring, type).not.toContain(owner);
    }
  });

  test.each(stages)("%s handles exactly the events it owns", (name, stage) => {
    expect(Object.keys(stage.events).sort()).toEqual(ownedBy(name).sort());
  });

  test("a handler gets its own event, typed, and returns its own fields", () => {
    const confirm = STAGES.selectProcessPack.events["processPack.confirm"];
    expectTypeOf(confirm).parameter(1).toEqualTypeOf<{
      type: "processPack.confirm";
      reviewedPackIds?: Id<"processPacks">[];
    }>();
    expectTypeOf(confirm).returns.resolves.toEqualTypeOf<
      Partial<Pick<Case, "processPack">>
    >();
    // A handler that writes another stage's field doesn't compile.
    const crossWrite: StageEvents<"intake"> = {
      // @ts-expect-error `processPack` is selectProcessPack's.
      "intake.submit": () => ({ processPack: undefined }),
    };
    expect(crossWrite).toBeDefined();
  });

  test("a stage takes its own events, and those that list it", () => {
    // Review takes collect's event, and collect still does the writing.
    expect(eventHandler("review", "answers.set")).toMatchObject({
      owner: "collect",
      handle: STAGES.collect.events["answers.set"],
    });
    expect(eventHandler("review", "review.approve")?.owner).toBe("review");
    expect(eventHandler("collect", "review.approve")).toBeUndefined();
    expect(eventHandler("intake", "answers.set")).toBeUndefined();
    expect(eventHandler("intake", "case.cancel")).toBeUndefined();
  });
});

describe("case fields", () => {
  test("each field has exactly one owner: core or one stage", () => {
    const owners: Record<string, string[]> = {};
    for (const [owner, fields] of Object.entries(FIELDS)) {
      for (const key of Object.keys(fields)) (owners[key] ??= []).push(owner);
    }
    for (const [field, owner] of Object.entries(owners)) {
      expect(owner, `owners of "${field}"`).toHaveLength(1);
    }
    expect(Object.keys(caseFields).sort()).toEqual(Object.keys(owners).sort());
    // The pipeline owns where a case is; selection owns the confirmed process pack.
    for (const field of ["plan", "currentStep", "visits", "failure", "seq"]) {
      expect(owners[field], field).toEqual(["core"]);
    }
    expect(owners.processPack).toEqual(["selectProcessPack"]);
  });
});

describe("plans", () => {
  test("the bootstrap plan uses registered stages with valid params", () => {
    const taken: string[] = [];
    for (const step of bootstrapPlan) {
      expect(validatePlanStep(step, taken)).toBeNull();
      taken.push(step.id);
    }
  });
});
