// Getting a case onto a test page: seed the fixtures, start a case (from a
// landing page or from chat, signed in or as a guest), or reopen a recent one.
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { PilotOptions } from "../../convex/easygov/autopilot";
import { useAct, useAutopilot } from "./session";
import { Refusal } from "./Workbench";

/** The shared packs: one landing page each. */
export function useLandings() {
  return useQuery(api.easygov.packs.public.landings, {
    paginationOpts: { numItems: 50, cursor: null },
  })?.page;
}

export function SeedBar() {
  const landings = useLandings();
  const firms = useQuery(api.easygov.dev.firms, {});
  const seed = useMutation(api.easygov.dev.seed);
  const act = useAct();
  if (!landings || !firms) return null;
  const seeded = landings.length >= 3 && firms.length > 0;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
      <span>
        {landings.length} shared pack{landings.length === 1 ? "" : "s"},{" "}
        {firms.length} firm{firms.length === 1 ? "" : "s"}.
        {!seeded && " Seed the fixtures to use these pages."}
      </span>
      <button
        className="demo-secondary"
        disabled={act.pending}
        onClick={() => void act.run(() => seed({}))}
      >
        {seeded
          ? "Seed again (does nothing twice)"
          : "Seed fixture packs and a firm"}
      </button>
      <Refusal error={act.error} />
    </div>
  );
}

/** `fresh` when the case was just started here, not reopened. */
export type Opened = (
  caseId: Id<"cases">,
  guestKey: string | undefined,
  fresh: boolean,
) => void;

/**
 * Starts a case. `entry` fixes how: "chat" starts blank (stage 1 runs, with
 * model calls), "pack" starts on a landing page (no model), "any" asks.
 * Each of `prompts` starts a blank case with that first chat message.
 */
export function Launcher({
  entry,
  source,
  onOpen,
  prompts,
}: {
  entry: "any" | "chat" | "pack";
  source: string;
  onOpen: Opened;
  prompts?: { label: string; text: string }[];
}) {
  const landings = useLandings();
  const recent = useQuery(api.easygov.dev.cases, {});
  const startCase = useMutation(api.easygov.case.public.startCase);
  const sendMessage = useMutation(api.easygov.case.public.sendMessage);
  const [packId, setPackId] = useState<Id<"processPacks"> | "">("");
  const [guest, setGuest] = useState(false);
  const act = useAct();
  const chosen =
    entry === "chat"
      ? ""
      : packId || (entry === "pack" ? landings?.[0]?.id : "");

  function start(first?: string) {
    return act.run(async () => {
      const guestKey = guest
        ? crypto.randomUUID() + crypto.randomUUID()
        : undefined;
      const caseId = await startCase({
        packId: chosen || undefined,
        source,
        guestKey,
      });
      if (first) {
        await sendMessage({
          caseId,
          guestKey,
          text: first,
          messageKey: crypto.randomUUID(),
        });
      }
      onOpen(caseId, guestKey, true);
    });
  }

  return (
    <div className="demo-panel">
      <div className="flex flex-wrap items-end gap-3">
        {entry !== "chat" && (
          <div>
            <label className="demo-label" htmlFor="launch-pack">
              Start on
            </label>
            <select
              id="launch-pack"
              className="input-field"
              value={chosen ?? ""}
              onChange={(event) =>
                setPackId(event.target.value as Id<"processPacks"> | "")
              }
            >
              {entry === "any" && (
                <option value="">No pack: chat with intake first</option>
              )}
              {landings?.map((landing) => (
                <option key={landing.id} value={landing.id}>
                  {landing.title} ({landing.jurisdiction})
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={guest}
            onChange={(event) => setGuest(event.target.checked)}
          />
          As a guest
        </label>
        <button
          className="demo-button"
          disabled={act.pending || (entry === "pack" && !chosen)}
          onClick={() => void start()}
        >
          Start a case
        </button>
        <div className="ml-auto">
          <label className="demo-label" htmlFor="launch-recent">
            Or reopen
          </label>
          <select
            id="launch-recent"
            className="input-field"
            value=""
            onChange={(event) =>
              onOpen(event.target.value as Id<"cases">, undefined, false)
            }
          >
            <option value="">Recent cases…</option>
            {recent?.map((row) => (
              <option key={row.id} value={row.id}>
                {new Date(row.startedAt).toLocaleTimeString()} · {row.phase}
                {row.goal ? ` · ${row.goal.slice(0, 40)}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      {prompts && (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            Or start a blank case with a first message:
          </p>
          <div className="flex flex-wrap gap-2">
            {prompts.map((prompt) => (
              <button
                key={prompt.label}
                className="demo-secondary"
                title={prompt.text}
                disabled={act.pending}
                onClick={() => void start(prompt.text)}
              >
                {prompt.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <Refusal error={act.error} />
    </div>
  );
}

const UNTIL: { value: PilotOptions["until"]; label: string }[] = [
  { value: "pack", label: "a pack is proposed" },
  { value: "answers", label: "it asks for answers" },
  { value: "approval", label: "the document is ready to review" },
  { value: "approved", label: "it's approved" },
  { value: "consent", label: "it asks to share with a lawyer" },
  { value: "end", label: "the case ends" },
];

/** Lets the autopilot play the person, up to a chosen point. */
export function PilotBar({
  pilot,
  initial,
}: {
  pilot: ReturnType<typeof useAutopilot>;
  initial?: Partial<PilotOptions>;
}) {
  const [options, setOptions] = useState<PilotOptions>({
    until: "end",
    referral: "trigger",
    consent: "share",
    goal: "I moved and need to tell the IRS my new address",
    ...initial,
  });
  const set = (patch: Partial<PilotOptions>) =>
    setOptions((current) => ({ ...current, ...patch }));
  return (
    <div className="demo-panel">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="demo-label" htmlFor="pilot-until">
            Autopilot: play the person until
          </label>
          <select
            id="pilot-until"
            className="input-field"
            value={options.until}
            onChange={(event) =>
              set({ until: event.target.value as PilotOptions["until"] })
            }
          >
            {UNTIL.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="demo-label" htmlFor="pilot-referral">
            Referral check
          </label>
          <select
            id="pilot-referral"
            className="input-field"
            value={options.referral}
            onChange={(event) =>
              set({ referral: event.target.value as PilotOptions["referral"] })
            }
          >
            <option value="trigger">answer so it passes</option>
            <option value="avoid">answer so it doesn't</option>
          </select>
        </div>
        <div>
          <label className="demo-label" htmlFor="pilot-consent">
            If asked to share
          </label>
          <select
            id="pilot-consent"
            className="input-field"
            value={options.consent}
            onChange={(event) =>
              set({ consent: event.target.value as PilotOptions["consent"] })
            }
          >
            <option value="share">share</option>
            <option value="decline">decline</option>
          </select>
        </div>
        {pilot.running ? (
          <button className="demo-secondary" onClick={pilot.stop}>
            Stop autopilot
          </button>
        ) : (
          <button className="demo-button" onClick={() => pilot.start(options)}>
            Run
          </button>
        )}
      </div>
      <div>
        <label className="demo-label" htmlFor="pilot-goal">
          Goal to state if the case asks for one (then model calls follow)
        </label>
        <input
          id="pilot-goal"
          className="input-field"
          value={options.goal ?? ""}
          onChange={(event) => set({ goal: event.target.value || undefined })}
        />
      </div>
      {pilot.running && (
        <p className="text-sm text-blue-800" role="status">
          Autopilot is playing the person…
        </p>
      )}
      <Refusal error={pilot.error} />
    </div>
  );
}
