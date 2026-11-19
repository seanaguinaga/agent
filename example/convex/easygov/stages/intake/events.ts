// What a person can send to intake, besides chat messages.
import { ConvexError } from "convex/values";
import type { StageEvents } from "../shared";
import { newGoal } from "./data";

export const events: StageEvents<"intake"> = {
  // Lets the person (or a test) state the goal without chatting.
  "intake.submit": (found, { goal }) => {
    const text = goal.trim();
    if (!text) throw new ConvexError("Say what you want to get done.");
    return { intake: newGoal(found, text) };
  },
};
