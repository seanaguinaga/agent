// The processes the pipeline can run. Packs are code for now; `getPack` and
// `listPacks` are the only readers, so moving packs into a table later
// changes only this file.
import type { StageType } from "../stages/stages.registry";
import type { PlanStep } from "../validators";
import { irs8822 } from "./irs8822";
import { ssaAppeal } from "./ssaAppeal";

/** A process the pipeline knows how to run: what to ask, and the plan. */
export type Pack = {
  key: string;
  title: string;
  /** The answers `collect` waits for. */
  inputs: string[];
  plan: (PlanStep & { type: StageType })[];
};

const PACKS: Record<string, Pack> = { irs8822, ssaAppeal };

export function getPack(key: string | undefined): Pack | undefined {
  return key !== undefined && Object.hasOwn(PACKS, key)
    ? PACKS[key]
    : undefined;
}

/** Every pack the route agent may choose from. */
export function listPacks(): Pack[] {
  return Object.values(PACKS);
}
