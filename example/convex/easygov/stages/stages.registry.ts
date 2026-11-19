// Every stage type the pipeline can run. To add one, write its folder and add
// an entry here: its params schema, its workflow, and the events it accepts.
//
// The extra dot in this filename is on purpose: Convex codegen skips it. If
// this were a normal module, the generated `internal` type would include
// `STAGES`, which itself refers to `internal`, and TypeScript gives up.
// Stage files must not import this file, or the two would import each other.
import type { z } from "zod/v4";
import { internal } from "../../_generated/api";
import type {
  Case,
  StageEvents,
  StageEventType,
  StageWorkflow,
} from "../stage";
import type { CaseEvent } from "../validators";
import { collectEvents, collectParams } from "./collect/collect";
import { deliverParams } from "./deliver/deliver";
import { fillParams } from "./fill/fill";
import { intakeEvents, intakeParams } from "./intake/intake";
import { legalReferralParams } from "./legalReferral/legalReferral";
import { reviewEvents, reviewParams } from "./review/review";
import { routeEvents, routeParams } from "./route/route";

const stages = internal.easygov.stages;

// Future work: uploadEvidence, payFee, waitForAgency.
export const STAGES = {
  intake: {
    params: intakeParams,
    workflow: stages.intake.intake.run,
    events: intakeEvents,
  },
  route: {
    params: routeParams,
    workflow: stages.route.route.run,
    events: routeEvents,
  },
  collect: {
    params: collectParams,
    workflow: stages.collect.collect.run,
    events: collectEvents,
  },
  fill: { params: fillParams, workflow: stages.fill.fill.run },
  review: {
    params: reviewParams,
    workflow: stages.review.review.run,
    events: reviewEvents,
  },
  deliver: { params: deliverParams, workflow: stages.deliver.deliver.run },
  legalReferral: {
    params: legalReferralParams,
    workflow: stages.legalReferral.legalReferral.run,
  },
} satisfies Record<
  string,
  { params: z.ZodType; workflow: StageWorkflow; events?: StageEvents }
>;
export type StageType = keyof typeof STAGES;

export function isStageType(type: string): type is StageType {
  return Object.hasOwn(STAGES, type);
}

type Handler = (found: Case, event: CaseEvent) => Partial<Case>;

/**
 * The handler for this event in this stage, or undefined if the stage doesn't
 * take it. Handlers are keyed by event type, so calling one with the event
 * that found it is safe.
 */
export function eventHandler(
  stage: string | undefined,
  type: CaseEvent["type"],
): Handler | undefined {
  if (stage === undefined || !isStageType(stage)) return undefined;
  const events: StageEvents =
    ("events" in STAGES[stage] && STAGES[stage].events) || {};
  return events[type as StageEventType] as Handler | undefined;
}
