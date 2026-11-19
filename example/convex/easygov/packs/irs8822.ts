import type { Pack } from ".";

/** IRS Form 8822: change of address. */
export const irs8822: Pack = {
  key: "irs8822",
  title: "IRS change of address (Form 8822)",
  inputs: ["fullName", "oldAddress", "newAddress"],
  plan: [
    { id: "collect", type: "collect" },
    { id: "fill", type: "fill" },
    { id: "review", type: "review", params: { backTo: "collect" } },
    { id: "deliver", type: "deliver", params: { channel: "mail" } },
  ],
};
