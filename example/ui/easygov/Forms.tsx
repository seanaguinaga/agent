// Official forms on their own: fetch one from its authority, see what was
// read from it, map its places to the profile, and try filling it.
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Result } from "../components/Example";
import { useAct } from "./session";
import { Chip, Page, Refusal } from "./Workbench";

const forms = api.easygov.forms.data;
type EditionId = Id<"formEditions">;
type Filled = FunctionReturnType<typeof api.easygov.forms.actions.testFill>;

function Register() {
  const register = useMutation(forms.register);
  const [code, setCode] = useState("IRS-8822");
  const [title, setTitle] = useState("Change of Address");
  const [jurisdiction, setJurisdiction] = useState("us");
  const [sourceUrl, setSourceUrl] = useState(
    "https://www.irs.gov/pub/irs-pdf/f8822.pdf",
  );
  const act = useAct();
  return (
    <form
      className="demo-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void act.run(() => register({ code, title, jurisdiction, sourceUrl }));
      }}
    >
      <h2 className="font-semibold">Add a form to the registry</h2>
      <div className="grid gap-2 sm:grid-cols-[8rem_1fr_6rem]">
        <input
          className="input-field"
          aria-label="Code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <input
          className="input-field"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          className="input-field"
          aria-label="Jurisdiction"
          value={jurisdiction}
          onChange={(e) => setJurisdiction(e.target.value)}
        />
      </div>
      <input
        className="input-field"
        aria-label="Source URL"
        value={sourceUrl}
        onChange={(e) => setSourceUrl(e.target.value)}
      />
      <p className="text-sm text-gray-600">
        A form is fetched only from its authority's own https site.
      </p>
      <button className="demo-button" disabled={act.pending}>
        Save
      </button>
      <Refusal error={act.error} />
    </form>
  );
}

function Registry({
  open,
  onOpen,
}: {
  open?: EditionId;
  onOpen: (id: EditionId) => void;
}) {
  const list = useQuery(forms.list, {});
  const fetchForm = useAction(api.easygov.forms.actions.fetchForm);
  const act = useAct();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Registry</h2>
      {list?.length === 0 && (
        <p className="text-sm text-gray-500">No forms yet.</p>
      )}
      {list?.map((form) => (
        <div key={form.id} className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <strong>{form.code}</strong>
            <span>{form.title}</span>
            <span className="break-all text-gray-500">{form.sourceUrl}</span>
            <button
              className="demo-secondary ml-auto"
              disabled={act.pending}
              onClick={() =>
                void act.run(async () => {
                  const { editionId } = await fetchForm({ formId: form.id });
                  onOpen(editionId);
                })
              }
            >
              {act.pending ? "Fetching…" : "Fetch from source"}
            </button>
          </p>
          {form.lastFetch && (
            <div className="space-y-1">
              <p
                className={form.lastFetch.ok ? "" : "font-medium text-red-700"}
              >
                {form.lastFetch.ok
                  ? "Last fetch worked."
                  : "Last fetch couldn't reach the form."}{" "}
                <span className="font-normal text-gray-500">
                  {new Date(form.lastFetch.at).toLocaleString()}
                </span>
              </p>
              <ol className="list-decimal pl-5 text-gray-700">
                {form.lastFetch.attempts.map((attempt, i) => (
                  <li key={i}>
                    {attempt.via === "browser"
                      ? "A real browser"
                      : "A plain request"}
                    : {attempt.ok ? "got it" : "no"} ({attempt.note})
                  </li>
                ))}
              </ol>
              {!form.lastFetch.ok && !form.browser && (
                <p className="text-gray-600">
                  No hosted browser is set up to try next. Set{" "}
                  <code>BROWSERBASE_API_KEY</code> and{" "}
                  <code>BROWSERBASE_PROJECT_ID</code> on the deployment.
                </p>
              )}
            </div>
          )}
          {form.editions.map((edition) => (
            <button
              key={edition.id}
              className="flex w-full flex-wrap items-center gap-2 text-left"
              aria-pressed={open === edition.id}
              onClick={() => onOpen(edition.id)}
            >
              <code>{edition.sha256.slice(0, 12)}</code>
              <span>{edition.edition ?? "no edition printed"}</span>
              <Chip>{edition.fillable ? "fillable" : "flat"}</Chip>
              {edition.opened && <Chip tone="blue">protection removed</Chip>}
              {edition.via && (
                <Chip tone={edition.via === "browser" ? "blue" : undefined}>
                  got by {edition.via}
                </Chip>
              )}
              <span>
                {edition.targets} places, {edition.mapped} mapped
              </span>
              <Chip
                tone={
                  edition.mappingStatus === "reviewed"
                    ? "green"
                    : edition.mappingStatus === "drafted"
                      ? "amber"
                      : undefined
                }
              >
                mapping {edition.mappingStatus}
              </Chip>
              <Chip tone={edition.currency === "confirmed" ? "green" : "amber"}>
                currency {edition.currency}
              </Chip>
              <span className="ml-auto text-gray-500">
                checked {new Date(edition.checkedAt).toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      ))}
      <Refusal error={act.error} />
    </div>
  );
}

function Edition({ editionId }: { editionId: EditionId }) {
  const edition = useQuery(forms.edition, { editionId });
  const profile = useQuery(api.easygov.profile.public.get, {});
  const draft = useAction(api.easygov.forms.agents.draftMapping);
  const save = useMutation(forms.saveMapping);
  const fill = useAction(api.easygov.forms.actions.testFill);
  const publish = useMutation(forms.publishPack);
  const [json, setJson] = useState<string>();
  const [answers, setAnswers] = useState<string>();
  const [filled, setFilled] = useState<Filled>();
  const [published, setPublished] = useState<string>();
  const act = useAct();
  if (!edition) return null;
  const mappingText = json ?? JSON.stringify(edition.mapping, null, 1);
  // What a person would have answered: the profile, and a word for the rest.
  const answersText =
    answers ??
    JSON.stringify(
      Object.fromEntries(
        edition.inputs.map((key) => [
          key,
          profile?.readings[key]?.replaceAll("\n", ", ") ?? `Test ${key}`,
        ]),
      ),
      null,
      1,
    );
  const mapped = new Map(edition.mapping.map((entry) => [entry.target, entry]));
  const saveAs = (reviewed: boolean) =>
    act.run(async () => {
      await save({ editionId, mapping: JSON.parse(mappingText), reviewed });
      setJson(undefined);
    });
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">
        {edition.code} {edition.title}{" "}
        <span className="font-normal text-gray-500">
          {edition.edition} · {edition.fillable ? "fillable" : "flat"} · mapping{" "}
          {edition.mappingStatus}
        </span>
      </h2>
      {edition.url && (
        <a
          className="link-text text-sm"
          href={edition.url}
          target="_blank"
          rel="noreferrer"
        >
          Open the blank form as fetched
        </a>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          The {edition.targets.length} places a value can go
        </summary>
        <table className="mt-2 w-full text-left text-xs">
          <thead>
            <tr className="text-gray-500">
              <th className="pr-2">Place</th>
              <th className="pr-2">Kind</th>
              <th className="pr-2">Printed beside it</th>
              <th>Gets</th>
            </tr>
          </thead>
          <tbody>
            {edition.targets.map((target) => {
              const entry = mapped.get(target.id);
              return (
                <tr key={target.id} className="border-t align-top">
                  <td className="pr-2">
                    <code>{target.id}</code>
                  </td>
                  <td className="pr-2">{target.kind}</td>
                  <td className="pr-2">{target.label || <em>nothing</em>}</td>
                  <td>
                    {entry?.input ? (
                      <code>
                        {entry.input}
                        {entry.equals !== undefined && ` = ${entry.equals}`}
                        {entry.includes !== undefined &&
                          ` includes ${entry.includes}`}
                      </code>
                    ) : entry?.constant ? (
                      "always"
                    ) : entry?.leave ? (
                      <em>left for the person: {entry.leave.why}</em>
                    ) : (
                      <span className="text-gray-400">blank</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
      <div className="space-y-2">
        <p className="text-sm font-medium">
          Mapping: each entry gives one place an <code>input</code> (a profile
          reading or a case question), a <code>constant</code>, or a reason to{" "}
          <code>leave</code> it for the person. A tick box also takes{" "}
          <code>equals</code> (pick one) or <code>includes</code> (check all
          that apply)
        </p>
        <textarea
          className="input-field font-mono text-xs"
          aria-label="Mapping JSON"
          rows={10}
          value={mappingText}
          onChange={(event) => setJson(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            className="demo-secondary"
            disabled={act.pending}
            onClick={() =>
              void act.run(async () => {
                await draft({ editionId });
                setJson(undefined);
              })
            }
          >
            Draft with a model
          </button>
          <button
            className="demo-secondary"
            disabled={act.pending}
            onClick={() => void saveAs(false)}
          >
            Save as draft
          </button>
          <button
            className="demo-button"
            disabled={act.pending}
            onClick={() => void saveAs(true)}
          >
            I've checked it against the form: mark reviewed
          </button>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Try filling it with these answers</p>
        <textarea
          className="input-field font-mono text-xs"
          aria-label="Answers JSON"
          rows={6}
          value={answersText}
          onChange={(event) => setAnswers(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            className="demo-secondary"
            disabled={act.pending}
            onClick={() =>
              void act.run(async () =>
                setFilled(
                  await fill({ editionId, answers: JSON.parse(answersText) }),
                ),
              )
            }
          >
            Fill and check
          </button>
          <button
            className="demo-secondary"
            disabled={act.pending || edition.mappingStatus !== "reviewed"}
            onClick={() =>
              void act.run(async () =>
                setPublished(await publish({ editionId })),
              )
            }
          >
            Publish a pack for this form
          </button>
        </div>
        {filled && (
          <div className="space-y-1 text-sm">
            {filled.url && (
              <a
                className="link-text"
                href={filled.url}
                target="_blank"
                rel="noreferrer"
              >
                Open the filled form
              </a>
            )}
            <p>
              {filled.omissions.length === 0
                ? "Everything written was read back from the form."
                : "Not written, or not found on reading back:"}
            </p>
            <Result
              value={filled.omissions.length ? filled.omissions : undefined}
            />
            {filled.toComplete.length > 0 && (
              <p>
                Left for the person:{" "}
                {filled.toComplete
                  .map(({ why, note }) => `${note} (${why})`)
                  .join(" ")}
              </p>
            )}
          </div>
        )}
        {published && (
          <p className="text-sm text-green-700" role="status">
            Published. Start a case on it from the stage 2 page.
          </p>
        )}
      </div>
      <Refusal error={act.error} />
    </div>
  );
}

export default function Forms() {
  const [open, setOpen] = useState<EditionId>();
  return (
    <Page
      title="easygov slice: forms"
      description="An official form, fetched from its authority and known by its bytes. Its places are read from the PDF (fields, or blanks found on a flat page), mapped to the profile, filled by code, and read back."
    >
      <Register />
      <Registry open={open} onOpen={setOpen} />
      {open && <Edition key={open} editionId={open} />}
    </Page>
  );
}
