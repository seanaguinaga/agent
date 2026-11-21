// The selection agent: the model calls that choose a process and its forms.
// It saves nothing to its thread (`noStorage`): the workflow's mutations
// decide what to keep, so a retried call can't leave a duplicate.
import { Agent } from "@convex-dev/agent";
import { components } from "../../_generated/api";
import { defaultConfig } from "../../agents/config";
import { chargeTokens } from "../limits";

export const selectionAgent = new Agent(components.agent, {
  name: "Select process pack",
  instructions:
    "Identify the process pack that fits a person's goal. " +
    "Only select a pack for the same task, in a jurisdiction that covers the person's. " +
    "Authorities are named in many ways; compare what they do, not their labels.",
  ...defaultConfig,
  usageHandler: chargeTokens,
});

export const noStorage = { storageOptions: { saveMessages: "none" } } as const;
