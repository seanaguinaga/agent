import type { Pack } from ".";

/** SSA request for reconsideration of a denied claim. */
export const ssaAppeal: Pack = {
  key: "ssaAppeal",
  title: "Social Security appeal (reconsideration)",
  inputs: ["fullName", "denialDate", "reasonForAppeal", "wantsRepresentation"],
  plan: [
    { id: "collect", type: "collect" },
    { id: "fill", type: "fill" },
    { id: "review", type: "review", params: { backTo: "collect" } },
    {
      id: "legalReferral",
      type: "legalReferral",
      params: { kind: "representation" },
      when: { input: "wantsRepresentation", equals: "yes" },
    },
    { id: "deliver", type: "deliver", params: { channel: "online" } },
  ],
};
