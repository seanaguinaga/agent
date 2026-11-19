// Every stage type the pipeline can run, built from the stage folders. To add
// one, declare its fields and events in `case/schema.ts`, write its folder,
// and add a line here.
//
// Stage files must not import this file (or anything in `plans/`, which
// does), since it imports them.
import { makeFunctionReference } from "convex/server";
import type { z } from "zod/v4";
import type { MutationCtx } from "../../_generated/server";
import type { Case } from "../case/data";
import {
  EVENTS,
  type CaseEvent,
  type Owner,
  type StageName,
} from "../case/schema";
import { events as collectEvents } from "./collect/events";
import * as collect from "./collect/workflow";
import * as deliver from "./deliver/workflow";
import * as fill from "./fill/workflow";
import { events as intakeEvents } from "./intake/events";
import * as intake from "./intake/workflow";
import * as legalReferral from "./legalReferral/workflow";
import { events as reviewEvents } from "./review/events";
import * as review from "./review/workflow";
import { events as selectProcessPackEvents } from "./selectProcessPack/events";
import * as selectProcessPack from "./selectProcessPack/workflow";
import type { StageEvents, StageWorkflow } from "./shared";

/** What `stages/<name>/workflow.ts` exports. */
type WorkflowFile = {
  /** Narrows a step's flat string params. */
  params: z.ZodType;
  /** True if the stage answers chat messages, so `sendMessage` nudges it. */
  chats: boolean;
  /** The workflow. */
  run: unknown;
};

type StageEntry<Name extends StageName> = Omit<WorkflowFile, "run"> & {
  /** `stages/<name>/events.ts`: one handler per event the stage owns. */
  events: StageEvents<Name>;
  /** A reference to the workflow file's `run`. */
  workflow: StageWorkflow;
};

/** `events` is `{}` for a stage that owns none, and so has no `events.ts`. */
function stage<Name extends StageName>(
  name: Name,
  { params, chats }: WorkflowFile,
  events: StageEvents<Name>,
): StageEntry<Name> {
  // By name, not through the generated `internal`: its type is made of the
  // stage files, and this list would then depend on itself.
  const workflow = makeFunctionReference<"mutation">(
    `easygov/stages/${name}/workflow:run`,
  ) as unknown as StageWorkflow;
  return { params, events, chats, workflow };
}

// Future work: uploadEvidence, payFee, waitForAgency.
export const STAGES = {
  intake: stage("intake", intake, intakeEvents),
  selectProcessPack: stage(
    "selectProcessPack",
    selectProcessPack,
    selectProcessPackEvents,
  ),
  collect: stage("collect", collect, collectEvents),
  fill: stage("fill", fill, {}),
  review: stage("review", review, reviewEvents),
  deliver: stage("deliver", deliver, {}),
  legalReferral: stage("legalReferral", legalReferral, {}),
  // One entry per stage in `case/schema.ts`, under its own name.
} satisfies { [Name in StageName]: StageEntry<Name> };
export type StageType = StageName;

export function stageTypeOf(type: string): StageType | undefined {
  return Object.hasOwn(STAGES, type) ? (type as StageType) : undefined;
}

/** The stage type of the step the case is at, if it's at one. */
export function currentStageType(found: Case): StageType | undefined {
  const type = found.plan.find((step) => step.id === found.currentStep)?.type;
  return type === undefined ? undefined : stageTypeOf(type);
}

/** Whether this stage answers chat messages. */
export function stageChats(stage: StageType | undefined): boolean {
  return stage !== undefined && STAGES[stage].chats;
}

type Handler = (
  found: Case,
  event: CaseEvent,
  ctx: MutationCtx,
) => Partial<Case> | Promise<Partial<Case>>;

/**
 * The handler for this event while `stage` is the current step, and the stage
 * that owns it and so does the writing. Undefined if the stage doesn't take
 * the event: it takes its own, plus any whose row lists it in `alsoDuring`.
 * Handlers are keyed by event type, so calling one with the event that found
 * it is safe.
 */
export function eventHandler(
  stage: StageType | undefined,
  type: CaseEvent["type"],
): { owner: StageType; handle: Handler } | undefined {
  const row: { owner: Owner; alsoDuring?: readonly StageName[] } = EVENTS[type];
  const { owner, alsoDuring } = row;
  if (stage === undefined || owner === "core") return undefined;
  if (owner !== stage && !alsoDuring?.includes(stage)) return undefined;
  const events: Record<string, unknown> = STAGES[owner].events;
  return { owner, handle: events[type] as Handler };
}
