// The profile: the person's own facts, kept apart from any one case and read
// by every form. Its editors are used on the profile page, and inside a case
// wherever the pack reads a fact the person hasn't given yet.
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type {
  Address,
  FactValue,
  Name,
} from "../../convex/easygov/profile/vocabulary";
import { useAct } from "./session";
import { Chip, Page, Refusal } from "./Workbench";

const profile = api.easygov.profile.public;
type Profile = FunctionReturnType<typeof profile.get>;
type FactRow = Profile["facts"][number];

function Field({
  label,
  value,
  onChange,
  width,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  width?: string;
  placeholder?: string;
}) {
  return (
    <label className={`block text-sm ${width ?? "grow"}`}>
      <span className="text-gray-600">{label}</span>
      <input
        className="input-field"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NameEditor({
  value,
  onSave,
}: {
  value?: Name;
  onSave: (value: Name) => void;
}) {
  const [given, setGiven] = useState(value?.given ?? "");
  const [middle, setMiddle] = useState(value?.middle ?? "");
  // "None" is something they tell us; an empty box is just not said yet.
  const [none, setNone] = useState(value?.middle === null);
  const [family, setFamily] = useState(value?.family ?? "");
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          given,
          family,
          middle: none ? null : middle.trim() || undefined,
        });
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Field label="Given name" value={given} onChange={setGiven} />
        {!none && (
          <Field label="Middle name" value={middle} onChange={setMiddle} />
        )}
        <Field label="Family name" value={family} onChange={setFamily} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={none}
          onChange={(event) => setNone(event.target.checked)}
        />
        I have no middle name
      </label>
      <button className="demo-secondary">Save name</button>
    </form>
  );
}

const BLANK: Address = {
  street: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
};

export function AddressEditor({
  value,
  startText,
  canFollowHome,
  onSave,
}: {
  value?: Address;
  /** An address as one line, to split into parts when the editor opens. */
  startText?: string;
  canFollowHome?: boolean;
  onSave: (value: FactValue) => void;
}) {
  const parse = useAction(api.easygov.profile.agents.parseAddress);
  const [parts, setParts] = useState<Address>(value ?? BLANK);
  const [text, setText] = useState(startText ?? "");
  const act = useAct();
  const set = (patch: Partial<Address>) =>
    setParts((current) => ({ ...current, ...patch }));
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          className="input-field"
          aria-label="Address as one line"
          placeholder="Paste the whole address, then split it (a model call)"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="button"
          className="demo-secondary shrink-0"
          disabled={act.pending || !text.trim()}
          onClick={() =>
            void act.run(async () => {
              const found = await parse({ text });
              if (!found) throw new Error("That doesn't look like an address.");
              setParts(found);
            })
          }
        >
          {act.pending ? "Splitting…" : "Split into parts"}
        </button>
      </div>
      <Refusal error={act.error} />
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(parts);
        }}
      >
        <div className="flex flex-wrap gap-2">
          <Field
            label="Street"
            value={parts.street}
            onChange={(street) => set({ street })}
          />
          <Field
            label="Unit type"
            width="w-24"
            placeholder="Apt"
            value={parts.unitType ?? ""}
            onChange={(unitType) => set({ unitType: unitType || undefined })}
          />
          <Field
            label="Unit no."
            width="w-24"
            value={parts.unitNumber ?? ""}
            onChange={(unitNumber) =>
              set({ unitNumber: unitNumber || undefined })
            }
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Field
            label="City"
            value={parts.city}
            onChange={(city) => set({ city })}
          />
          <Field
            label="State"
            width="w-20"
            placeholder="CA"
            value={parts.state}
            onChange={(state) => set({ state })}
          />
          <Field
            label="ZIP"
            width="w-28"
            value={parts.postalCode}
            onChange={(postalCode) => set({ postalCode })}
          />
          <Field
            label="Country"
            width="w-20"
            value={parts.country}
            onChange={(country) => set({ country })}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="demo-secondary">Save address</button>
          {canFollowHome && (
            <button
              type="button"
              className="demo-secondary"
              onClick={() => onSave({ sameAs: "homeAddress" })}
            >
              Same as my home address
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function TextEditor({
  fact,
  value,
  onSave,
}: {
  fact: FactRow;
  value?: string;
  onSave: (value: string) => void;
}) {
  const [text, setText] = useState(value ?? "");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text);
      }}
    >
      <input
        className="input-field"
        aria-label={fact.label}
        type={fact.kind === "date" ? "date" : "text"}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button className="demo-secondary shrink-0">Save</button>
    </form>
  );
}

/** Shows a fact as the person gave it. */
function show(
  value: FactValue | undefined,
  readings: Profile["readings"],
  key: string,
) {
  if (value === undefined) return "Not given yet";
  if (typeof value === "string") return value;
  if ("sameAs" in value) return "Same as home address";
  return (readings[key] ?? readings.fullName ?? "").replaceAll("\n", ", ");
}

/**
 * One fact: what's held, and an editor to give or change it. Saving needs no
 * case: whatever form reads this fact picks it up.
 */
export function FactEditor({
  factKey,
  guestKey,
  open: startOpen,
  startText,
  onSaved,
  note,
}: {
  factKey: string;
  guestKey?: string;
  open?: boolean;
  startText?: string;
  onSaved?: () => void;
  note?: ReactNode;
}) {
  const data = useQuery(profile.get, { guestKey });
  const save = useMutation(profile.save);
  const [open, setOpen] = useState(startOpen ?? false);
  const act = useAct();
  const fact = data?.facts.find((row) => row.key === factKey);
  if (!data || !fact) return null;
  const { value } = fact;
  const onSave = (next: FactValue) =>
    void act.run(async () => {
      await save({ key: factKey, value: next, guestKey });
      setOpen(false);
      onSaved?.();
    });
  const editing = open || value === undefined;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <strong>{fact.label}</strong>
        {fact.stale && <Chip tone="amber">worth checking</Chip>}
        <span className="text-gray-600">
          {show(
            value,
            data.readings,
            factKey === "name" ? "fullName" : factKey,
          )}
        </span>
        {note}
        {value !== undefined && (
          <button className="link-text ml-auto" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Change"}
          </button>
        )}
      </p>
      {editing &&
        (fact.kind === "name" ? (
          <NameEditor
            value={
              typeof value === "object" && "family" in value ? value : undefined
            }
            onSave={onSave}
          />
        ) : fact.kind === "address" ? (
          <AddressEditor
            value={
              typeof value === "object" && "street" in value ? value : undefined
            }
            startText={startText}
            canFollowHome={factKey === "mailingAddress"}
            onSave={onSave}
          />
        ) : (
          <TextEditor
            fact={fact}
            value={typeof value === "string" ? value : undefined}
            onSave={onSave}
          />
        ))}
      <Refusal error={act.error} />
    </div>
  );
}

/**
 * What to ask while a case is still being worked out: exactly what its pack
 * reads once that's known, and before then what most packs read.
 */
export function AskAhead({
  caseId,
  guestKey,
}: {
  caseId?: Id<"cases">;
  guestKey?: string;
}) {
  const asks = useQuery(profile.askAhead, { caseId, guestKey });
  if (!asks?.length) return null;
  const needed = asks[0].why === "needed";
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">
        {needed
          ? "This form reads these from your profile"
          : "While we work on this"}
      </h2>
      <p className="text-sm text-gray-600">
        {needed
          ? "Give them once: every later form that asks reads them from here."
          : "Most forms and letters use these. They're optional, and whatever you give is kept for any form that asks."}
      </p>
      {asks.map((ask) => (
        <FactEditor key={ask.fact} factKey={ask.fact} guestKey={guestKey} />
      ))}
    </div>
  );
}

/** What finished cases suggest for the profile, for the person to accept. */
export function Proposals({ guestKey }: { guestKey?: string }) {
  const data = useQuery(profile.get, { guestKey });
  const settle = useMutation(profile.settleProposal);
  if (!data?.proposals.length) return null;
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Update your profile?</h2>
      {data.proposals.map((proposal) => (
        <div key={proposal.id} className="space-y-2">
          <p className="text-sm">
            A finished case gave a new{" "}
            <strong>{proposal.label.toLowerCase()}</strong>: {proposal.text}
          </p>
          <FactEditor
            factKey={proposal.fact}
            guestKey={guestKey}
            open
            startText={proposal.text}
            onSaved={() =>
              void settle({ id: proposal.id, accept: true, guestKey })
            }
          />
          <button
            className="text-sm text-gray-600 underline"
            onClick={() =>
              void settle({ id: proposal.id, accept: false, guestKey })
            }
          >
            No, leave my profile as it is
          </button>
        </div>
      ))}
    </div>
  );
}

export default function ProfilePage() {
  const data = useQuery(profile.get, {});
  const forget = useMutation(profile.forget);
  const act = useAct();
  return (
    <Page
      title="easygov slice: profile"
      description="The person's own facts, kept apart from any case. A pack input named after a reading (fullName, mailingCity) is answered from here, so a fact given once is there for every form."
    >
      <Proposals />
      <div className="demo-panel">
        <h2 className="font-semibold">Facts</h2>
        {data?.facts.map((fact) => (
          <FactEditor key={fact.key} factKey={fact.key} />
        ))}
      </div>
      <div className="demo-panel">
        <h2 className="font-semibold">
          Readings ({Object.keys(data?.readings ?? {}).length})
        </h2>
        <p className="text-sm text-gray-600">
          Every way a fact can be written down. A pack or form uses these as its
          input keys.
        </p>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[14rem_1fr]">
          {Object.entries(data?.readings ?? {}).map(([key, value]) => (
            <div key={key} className="contents">
              <dt>
                <code>{key}</code>
              </dt>
              <dd className="whitespace-pre-line text-gray-700">
                {value || <em>none</em>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <button
          className="text-sm text-red-700 underline"
          disabled={act.pending}
          onClick={() =>
            void act.run(async () => {
              while (await forget({})) {
                // Removed in batches: keep going until nothing is left.
              }
            })
          }
        >
          Forget everything kept about me
        </button>
        <Refusal error={act.error} />
      </div>
    </Page>
  );
}
