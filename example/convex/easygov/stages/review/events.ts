// What a person can send that review owns: approval.
import { ConvexError } from "convex/values";
import { fingerprint } from "../../case/answers";
import type { StageEvents } from "../shared";

export const events: StageEvents<"review"> = {
  "review.approve": (found) => {
    const current = fingerprint(found.answers);
    if (found.artifact?.fingerprint !== current) {
      throw new ConvexError("The answers changed. Review the new version.");
    }
    return { approval: { fingerprint: current } };
  },
};
