// What a person can send to collect: one answer at a time. Review takes this
// event too (its row in `EVENTS` says `alsoDuring`), and this handler still
// runs.
import { ConvexError } from "convex/values";
import type { StageEvents } from "../shared";
import { requiredInputs } from "./data";

export const events: StageEvents<"collect"> = {
  "answers.set": (found, { key, value }) => {
    if (!requiredInputs(found)?.includes(key)) {
      throw new ConvexError(`"${key}" isn't one of this case's inputs.`);
    }
    return { answers: { ...found.answers, [key]: value } };
  },
};
