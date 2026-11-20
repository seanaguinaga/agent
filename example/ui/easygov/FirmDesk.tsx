// The firm side: what one firm is shown, takes, passes on and reads, next to
// every referral there is.
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Result } from "../components/Example";
import { useAct } from "./session";
import { Chip, Refusal } from "./Workbench";

const firmApi = api.easygov.firms.public;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function Packet({
  firmId,
  referralId,
}: {
  firmId: Id<"firms">;
  referralId: Id<"referrals">;
}) {
  return <Result value={useQuery(firmApi.getPacket, { firmId, referralId })} />;
}

function Desk({ firmId }: { firmId: Id<"firms"> }) {
  const previews = useQuery(firmApi.listPreviews, { firmId });
  const accepted = useQuery(firmApi.listAccepted, { firmId });
  const accept = useMutation(firmApi.acceptReferral);
  const reject = useMutation(firmApi.rejectReferral);
  const [reading, setReading] = useState<Id<"referrals">>();
  const act = useAct();
  return (
    <>
      <h3 className="text-sm font-semibold">
        Open referrals this firm is shown ({previews?.length ?? "…"})
      </h3>
      {previews?.length === 0 && (
        <p className="text-sm text-gray-500">
          None. Share a case whose kind and place this firm covers.
        </p>
      )}
      {previews?.map((preview) => (
        <div
          key={preview.id}
          className="space-y-2 rounded-lg border p-3 text-sm"
        >
          <p className="flex flex-wrap items-center gap-2">
            <Chip tone="blue">{preview.kind}</Chip>
            <span>{preview.jurisdiction}</span>
            <span className="text-gray-500">{preview.process}</span>
            <span className="ml-auto font-medium">
              {dollars(preview.priceCents)}
            </span>
          </p>
          <p className="text-gray-600">
            Answered: {preview.answered.join(", ") || "nothing"} · Files:{" "}
            {preview.evidence}
            {preview.attached.length > 0 && ` (${preview.attached.join(", ")})`}
            {preview.deadline && ` · Act by ${preview.deadline}`}
          </p>
          <div className="flex gap-2">
            <button
              className="demo-button"
              disabled={act.pending}
              onClick={() =>
                void act.run(() => accept({ firmId, referralId: preview.id }))
              }
            >
              Accept
            </button>
            <button
              className="demo-secondary"
              disabled={act.pending}
              onClick={() =>
                void act.run(() => reject({ firmId, referralId: preview.id }))
              }
            >
              Pass
            </button>
          </div>
        </div>
      ))}
      <Refusal error={act.error} />
      <h3 className="text-sm font-semibold">
        Accepted ({accepted?.length ?? "…"})
      </h3>
      {accepted?.map((row) => (
        <div key={row.id} className="rounded-lg border p-3 text-sm">
          <button
            className="flex w-full flex-wrap items-center gap-2 text-left"
            onClick={() => setReading(reading === row.id ? undefined : row.id)}
          >
            <Chip tone="green">{row.kind}</Chip>
            {row.deadline && <span>Act by {row.deadline}</span>}
            <span className="ml-auto">owes {dollars(row.priceCents)}</span>
            <span className="link-text">
              {reading === row.id ? "Hide" : "Read the packet"}
            </span>
          </button>
          {reading === row.id && <Packet firmId={firmId} referralId={row.id} />}
        </div>
      ))}
    </>
  );
}

export function FirmDesk() {
  const firms = useQuery(api.easygov.dev.firms, {});
  const [picked, setPicked] = useState<Id<"firms">>();
  const firm = firms?.find((row) => row.id === picked) ?? firms?.[0];
  return (
    <div className="demo-panel" aria-label="Firm desk">
      <h2 className="font-semibold">Firm desk</h2>
      {firms?.length === 0 && (
        <p className="text-sm text-gray-500">No firm yet: seed one above.</p>
      )}
      {firm && (
        <>
          <select
            className="input-field"
            aria-label="Firm"
            value={firm.id}
            onChange={(event) => setPicked(event.target.value as Id<"firms">)}
          >
            {firms?.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
          <p className="text-sm text-gray-600">
            Covers:{" "}
            {firm.coverage
              .map((entry) => `${entry.kind} in ${entry.jurisdiction}`)
              .join("; ")}
          </p>
          <Desk key={firm.id} firmId={firm.id} />
        </>
      )}
    </div>
  );
}

/** Every referral row, whoever it's for: what the firm desk is checked against. */
export function AllReferrals({ caseId }: { caseId?: Id<"cases"> }) {
  const all = useQuery(api.easygov.dev.referrals, {});
  const rows = caseId ? all?.filter((row) => row.caseId === caseId) : all;
  return (
    <div className="demo-panel" aria-label="All referrals">
      <h2 className="font-semibold">
        {caseId ? "This case's referral rows" : "Every referral row"}
      </h2>
      {rows?.length === 0 && <p className="text-sm text-gray-500">None.</p>}
      {rows?.map((row) => (
        <p key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Chip
            tone={
              row.status === "open"
                ? "blue"
                : row.status === "accepted"
                  ? "green"
                  : "amber"
            }
          >
            {row.status}
          </Chip>
          <span>{row.kind}</span>
          <span>{row.jurisdiction ?? "no jurisdiction: no firm sees it"}</span>
          <span className="text-gray-500">{row.source}</span>
          <span className="ml-auto">
            {row.firm
              ? `${row.firm}${row.owed ? ` owes ${dollars(row.priceCents)}` : ""}`
              : dollars(row.priceCents)}
          </span>
        </p>
      ))}
    </div>
  );
}

/** Adds a firm for the test user, or changes one's coverage. */
export function FirmForm() {
  const save = useMutation(api.easygov.dev.createFirm);
  const [name, setName] = useState("Bay Wage Lawyers");
  const [coverage, setCoverage] = useState("employment@us/ca/alameda");
  const act = useAct();
  return (
    <form
      className="demo-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void act.run(() =>
          save({
            name,
            coverage: coverage
              .split(",")
              .map((entry) => entry.trim().split("@"))
              .map(([kind, jurisdiction]) => ({
                kind: kind ?? "",
                jurisdiction: jurisdiction ?? "",
              })),
          }),
        );
      }}
    >
      <h2 className="font-semibold">Add a firm</h2>
      <label className="demo-label" htmlFor="firm-name">
        Name
      </label>
      <input
        id="firm-name"
        className="input-field"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="demo-label" htmlFor="firm-coverage">
        Coverage, as kind@jurisdiction, comma-separated
      </label>
      <input
        id="firm-coverage"
        className="input-field"
        value={coverage}
        onChange={(event) => setCoverage(event.target.value)}
      />
      <button className="demo-button" disabled={act.pending}>
        Save firm
      </button>
      <Refusal error={act.error} />
    </form>
  );
}
