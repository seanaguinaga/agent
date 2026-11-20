// The pack library on its own: the landing pages, what search finds, and
// what saving does about look-alikes and new versions.
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Result } from "../components/Example";
import { SeedBar, useLandings } from "./Launch";
import { useAct } from "./session";
import { Chip, Page, Refusal } from "./Workbench";

const dev = api.easygov.dev;
type PackId = Id<"processPacks">;
type SaveArgs = FunctionArgs<typeof dev.createPack>;

function Landings() {
  const landings = useLandings();
  const [open, setOpen] = useState<PackId>();
  const landing = useQuery(
    api.easygov.packs.public.getLanding,
    open ? { packId: open } : "skip",
  );
  const startCase = useMutation(api.easygov.case.public.createCase);
  const navigate = useNavigate();
  const act = useAct();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Landing pages (shared, current packs)</h2>
      <div className="flex flex-wrap gap-2">
        {landings?.map((row) => (
          <button
            key={row.id}
            className="demo-secondary"
            aria-pressed={open === row.id}
            onClick={() => setOpen(row.id)}
          >
            {row.title}
          </button>
        ))}
      </div>
      {landing && (
        <>
          <Result value={landing} />
          <button
            className="demo-button"
            disabled={act.pending}
            onClick={() =>
              void act.run(async () => {
                const caseId = await startCase({
                  packId: landing.id,
                  source: "test:packs",
                });
                void navigate(`/easygov-collect?case=${caseId}`);
              })
            }
          >
            Start a case on this page
          </button>
        </>
      )}
      <Refusal error={act.error} />
    </div>
  );
}

function Search() {
  const [jurisdiction, setJurisdiction] = useState("us/ca/alameda");
  const [terms, setTerms] = useState("my employer owes me my final paycheck");
  const [mine, setMine] = useState(true);
  const found = useQuery(dev.searchPacks, { jurisdiction, terms, mine });
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">What selection's search finds</h2>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <input
          className="input-field"
          aria-label="Jurisdiction"
          value={jurisdiction}
          onChange={(event) => setJurisdiction(event.target.value)}
        />
        <input
          className="input-field"
          aria-label="Search terms"
          value={terms}
          onChange={(event) => setTerms(event.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={mine}
          onChange={(event) => setMine(event.target.checked)}
        />
        Include the test user's own packs
      </label>
      {found === null ? (
        <Refusal error="That isn't a jurisdiction path." />
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {found?.map((pack) => (
            <li key={pack.id}>
              {pack.title}{" "}
              <span className="text-gray-500">
                ({pack.jurisdiction}
                {pack.forms.length ? `, ${pack.forms.join(", ")}` : ""})
              </span>
            </li>
          ))}
          {found?.length === 0 && (
            <p className="text-gray-500">No candidates.</p>
          )}
        </ol>
      )}
    </div>
  );
}

function Save() {
  const fixtures = useQuery(dev.fixtures, {});
  const rows = useQuery(dev.packs, {});
  const save = useMutation(dev.createPack);
  const [json, setJson] = useState("");
  const [owned, setOwned] = useState(false);
  const [supersedes, setSupersedes] = useState<PackId | "">("");
  const [reviewed, setReviewed] = useState<PackId[]>([]);
  const [result, setResult] =
    useState<FunctionReturnType<typeof dev.createPack>>();
  const act = useAct();
  function submit(reviewedPackIds: PackId[]) {
    setResult(undefined);
    return act.run(async () => {
      const definition = JSON.parse(json) as SaveArgs;
      const saved = await save({
        ...definition,
        ownerId: owned ? "test user" : undefined,
        supersedes: supersedes || undefined,
        reviewedPackIds,
      });
      setResult(saved);
      setReviewed(
        saved.kind === "reviewDuplicates"
          ? [...reviewedPackIds, ...saved.packs.map((pack) => pack.id)]
          : [],
      );
    });
  }
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Save a pack</h2>
      <div className="flex flex-wrap gap-2">
        {Object.entries(fixtures ?? {}).map(([name, definition]) => (
          <button
            key={name}
            className="demo-secondary"
            onClick={() => {
              setJson(JSON.stringify(definition, null, 2));
              setReviewed([]);
              setResult(undefined);
            }}
          >
            Load {name}
          </button>
        ))}
      </div>
      <textarea
        className="input-field font-mono text-xs"
        aria-label="Pack definition JSON"
        rows={12}
        value={json}
        onChange={(event) => setJson(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={owned}
            onChange={(event) => setOwned(event.target.checked)}
          />
          Owned by the test user (not shared)
        </label>
        <select
          className="input-field max-w-xs"
          aria-label="New version of"
          value={supersedes}
          onChange={(event) => setSupersedes(event.target.value as PackId | "")}
        >
          <option value="">A new pack</option>
          {rows
            ?.filter((row) => row.status === "current")
            .map((row) => (
              <option key={row.id} value={row.id}>
                New version of: {row.title}
                {row.ownerId ? " (owned)" : ""}
              </option>
            ))}
        </select>
      </div>
      <div className="flex gap-2">
        <button
          className="demo-button"
          disabled={act.pending || !json.trim()}
          onClick={() => void submit([])}
        >
          Save
        </button>
        {result?.kind === "reviewDuplicates" && (
          <button
            className="demo-secondary"
            disabled={act.pending}
            onClick={() => void submit(reviewed)}
          >
            They're different: save anyway
          </button>
        )}
      </div>
      <Result value={result} />
      <Refusal error={act.error} />
    </div>
  );
}

function Rows() {
  const rows = useQuery(dev.packs, {});
  const [open, setOpen] = useState<PackId>();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Every pack row ({rows?.length ?? "…"})</h2>
      {rows?.map((row) => (
        <div key={row.id} className="text-sm">
          <button
            className="flex w-full flex-wrap items-center gap-2 text-left"
            onClick={() => setOpen(open === row.id ? undefined : row.id)}
          >
            <Chip tone={row.status === "current" ? "green" : "amber"}>
              {row.status}
            </Chip>
            <span>{row.title}</span>
            <span className="text-gray-500">{row.jurisdiction}</span>
            <Chip>{row.ownerId ? `owned by ${row.ownerId}` : "shared"}</Chip>
            {row.supersedes && (
              <span className="text-gray-500">
                replaces{" "}
                {rows.find((other) => other.id === row.supersedes)?.title}
              </span>
            )}
          </button>
          {open === row.id && <Result value={row.definition} />}
        </div>
      ))}
    </div>
  );
}

export default function Packs() {
  return (
    <Page
      title="easygov slice: pack library"
      description="Packs on their own, with no case: the landing pages, search within a jurisdiction and the ones containing it, look-alike review on save, and versions."
    >
      <SeedBar />
      <Landings />
      <Search />
      <Save />
      <Rows />
    </Page>
  );
}
