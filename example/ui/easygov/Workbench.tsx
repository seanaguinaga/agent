// One case, as every easygov test page shows it: where it is, what a person
// can do there, and everything underneath (the row, its history, any event).
import { useMutation, useQuery } from "convex/react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import Transcript from "../chat/Transcript";
import { Result } from "../components/Example";
import type { CaseEvent, CaseView } from "../../convex/easygov/autopilot";
import {
  chosen,
  definitionOf,
  draftOf,
} from "../../convex/easygov/case/schema";
import { Phases, phaseLine } from "./Phases";
import { AskAhead, FactEditor, Proposals } from "./Profile";
import { useAct, type CaseSession } from "./session";

const cases = api.easygov.case.public;

export function Page({
  title,
  description,
  wide,
  children,
}: {
  title: string;
  description: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`mx-auto space-y-6 p-4 sm:p-8 ${wide ? "max-w-7xl" : "max-w-4xl"}`}
    >
      <div>
        <Link className="link-text text-sm" to="/">
          ← All examples
        </Link>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-gray-600">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function Refusal({ error }: { error?: string }) {
  return error ? (
    <p
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    >
      {error}
    </p>
  ) : null;
}

export function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: string;
}) {
  const tones: Record<string, string> = {
    blue: "border-blue-200 bg-blue-50 text-blue-800",
    green: "border-green-200 bg-green-50 text-green-800",
    red: "border-red-200 bg-red-50 text-red-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone ?? ""] ?? "bg-gray-50 text-gray-700"}`}
    >
      {children}
    </span>
  );
}

function Where({ c }: { c: CaseView }) {
  return (
    <div className="demo-panel" aria-label="Where the case is">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Chip
          tone={
            c.status === "done"
              ? "green"
              : c.status === "active"
                ? "blue"
                : "red"
          }
        >
          {c.status}
        </Chip>
        <Chip>{c.phase}</Chip>
        <span data-testid="waiting">{phaseLine(c)}</span>
        <span className="text-gray-500">
          seq {c.seq}
          {c.source && ` · from ${c.source}`}
          {c.userId.startsWith("guest:") && " · guest"}
        </span>
      </p>
      {c.deadline && (
        <p className="text-sm">
          <strong>{c.deadline.label}</strong> by {c.deadline.date}
        </p>
      )}
      <Phases c={c} />
    </div>
  );
}

// --- What the person can do now ---------------------------------------------

function Goal({ session }: { session: CaseSession }) {
  const c = session.c!;
  const [text, setText] = useState("");
  const [goal, setGoal] = useState("");
  const act = useAct();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Say what you want to get done</h2>
      <Transcript threadId={c.threadId} />
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act.run(() => session.chat(text).then(() => setText("")));
        }}
      >
        <input
          className="input-field"
          aria-label="Message to intake"
          placeholder="Chat with intake (a model call)"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button className="demo-button" disabled={act.pending || !text.trim()}>
          Send
        </button>
      </form>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act.run(() =>
            session.send({ type: "intake.submit", goal }, c.seq),
          );
        }}
      >
        <input
          className="input-field"
          aria-label="Goal"
          placeholder="Or state the goal outright (intake.submit)"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        <button className="demo-secondary" disabled={act.pending}>
          Submit goal
        </button>
      </form>
      <AttachFiles
        session={session}
        id="file-start"
        label="Or start from the letter or notice you received (a model reads it, and intake answers)"
      />
      <FileList session={session} files={c.files} />
      <Refusal error={act.error} />
    </div>
  );
}

/** The official pages a drafted checklist was written from. */
function Sources({ urls }: { urls?: string[] }) {
  if (!urls?.length) {
    return (
      <p className="text-amber-800">
        No official pages were read for this checklist.
      </p>
    );
  }
  return (
    <div>
      <p className="font-medium">Written from:</p>
      <ul className="list-disc break-all pl-5">
        {urls.map((url) => (
          <li key={url}>
            <a
              className="link-text"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Proposal({ session }: { session: CaseSession }) {
  const c = session.c!;
  const selection = chosen(c.processPack)!;
  const draft = draftOf(selection);
  const saveCase = useMutation(api.easygov.evals.runner.saveDraftCase);
  const [saved, setSaved] = useState(false);
  const act = useAct();
  const send = (event: CaseEvent) => act.run(() => session.send(event, c.seq));
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">
        {draft
          ? "No saved pack fits: a process drafted for this goal"
          : selection.kind === "referral"
            ? "No process fits: a legal referral instead"
            : "A saved process pack fits this goal"}
      </h2>
      <p className="text-sm text-gray-600">Goal: {c.intake?.goal}</p>
      {draft && (
        <div className="space-y-2 text-sm">
          <p className="font-medium">{draft.output?.title ?? draft.title}</p>
          <ul className="list-disc pl-5">
            {draft.output?.checklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <Sources urls={draft.output?.sources} />
          <p className="text-gray-600">
            {draft.inputs.length
              ? `It will ask: ${draft.inputQuestions?.map(({ question }) => question).join(" · ")}`
              : "It asks nothing: confirming goes straight to review."}{" "}
            A draft runs on this case only and is never saved as a pack.
          </p>
        </div>
      )}
      <Result
        value={
          selection.kind === "draft"
            ? selection.draft
            : selection.kind === "pack"
              ? selection.definition
              : { jurisdiction: selection.jurisdiction }
        }
      />
      <div className="flex gap-2">
        <button
          className="demo-button"
          disabled={act.pending}
          onClick={() => void send({ type: "processPack.confirm" })}
        >
          Confirm
        </button>
        <button
          className="demo-secondary"
          disabled={act.pending}
          onClick={() => void send({ type: "processPack.reject" })}
        >
          Reject
        </button>
        {draft && (
          <button
            className="demo-secondary ml-auto"
            disabled={act.pending || saved}
            onClick={() =>
              void act.run(async () => {
                await saveCase({ caseId: c._id });
                setSaved(true);
              })
            }
          >
            {saved ? "Saved as eval case" : "Save as eval case"}
          </button>
        )}
      </div>
      <Refusal error={act.error} />
    </div>
  );
}

function AnswerRow({
  session,
  name,
  question,
  caseOnly,
}: {
  session: CaseSession;
  name: string;
  question: string;
  /** Keep the answer to this case: don't save it for other forms. */
  caseOnly?: boolean;
}) {
  const c = session.c!;
  const saved = c.answers[name] ?? "";
  // A suggestion fills the box, but it's only an answer once it's saved.
  const suggested = c.suggestions[name];
  const [value, setValue] = useState(saved || suggested || "");
  const act = useAct();
  const asked = definitionOf(c.processPack)?.inputQuestions?.find(
    (q) => q.key === name,
  );
  if (asked?.choices) {
    // A set of tick boxes: pick one, or every one that applies.
    const picked = value.split(",").filter(Boolean);
    const toggle = (option: string) =>
      setValue(
        asked.multiple
          ? (picked.includes(option)
              ? picked.filter((other) => other !== option)
              : [...picked, option]
            ).join(",")
          : option,
      );
    return (
      <fieldset className="space-y-1">
        <legend className="demo-label">
          {question} <code>({name})</code>
        </legend>
        {asked.choices.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2 text-sm">
            <input
              type={asked.multiple ? "checkbox" : "radio"}
              name={`answer-${name}`}
              className="mt-1"
              checked={picked.includes(choice.value)}
              onChange={() => toggle(choice.value)}
            />
            {choice.label}
          </label>
        ))}
        <button
          className="demo-secondary"
          disabled={act.pending || value === saved}
          onClick={() =>
            void act.run(() =>
              session.send(
                { type: "answers.set", key: name, value, caseOnly },
                c.seq,
              ),
            )
          }
        >
          {saved ? "Change" : "Save"}
        </button>
        <Refusal error={act.error} />
      </fieldset>
    );
  }
  return (
    <form
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        void act.run(() =>
          session.send(
            { type: "answers.set", key: name, value, caseOnly },
            c.seq,
          ),
        );
      }}
    >
      <label className="demo-label" htmlFor={`answer-${name}`}>
        {question} {question !== name && <code>({name})</code>}
      </label>
      <div className="flex gap-2">
        <input
          id={`answer-${name}`}
          className="input-field"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          className="demo-secondary"
          disabled={act.pending || value === saved}
        >
          {saved ? "Change" : "Save"}
        </button>
      </div>
      <Refusal error={act.error} />
    </form>
  );
}

function Answers({ session }: { session: CaseSession }) {
  const c = session.c!;
  const pack = definitionOf(c.processPack)!;
  const questions =
    pack.inputQuestions ?? pack.inputs.map((key) => ({ key, question: key }));
  const act = useAct();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Answers and files</h2>
      {Object.keys(c.suggestions).length > 0 && (
        <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          <p className="font-medium">
            From what you said, your files, your profile, or last time:
          </p>
          <ul className="list-disc pl-5">
            {Object.entries(c.suggestions).map(([key, value]) => (
              <li key={key}>
                <code>{key}</code>: {value}
              </li>
            ))}
          </ul>
          <button
            className="demo-button"
            disabled={act.pending}
            onClick={() =>
              void act.run(() =>
                session.send({ type: "answers.accept" }, c.seq),
              )
            }
          >
            Use these
          </button>
        </div>
      )}
      {[...new Set(Object.values(c.profileInputs))].map((fact) => (
        <FactEditor
          key={fact}
          factKey={fact}
          guestKey={session.guestKey}
          note={
            <span className="text-gray-500">
              · read as{" "}
              {Object.entries(c.profileInputs)
                .filter(([, of]) => of === fact)
                .map(([input]) => input)
                .join(", ")}
            </span>
          }
        />
      ))}
      {questions
        .filter(({ key }) => !(key in c.profileInputs))
        .map(({ key, question }) => (
          // Remounts when a suggestion arrives or is taken, to refill the box.
          <AnswerRow
            key={`${key}:${c.suggestions[key] ?? ""}:${c.answers[key] ?? ""}`}
            session={session}
            name={key}
            question={question}
          />
        ))}
      {Object.keys(c.profileInputs).length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-600">
            Use something different on this form only
          </summary>
          <p className="py-2 text-gray-600">
            These stay on this case and don't change your profile.
          </p>
          {questions
            .filter(({ key }) => key in c.profileInputs)
            .map(({ key, question }) => (
              <AnswerRow
                key={`${key}:${c.answers[key] ?? ""}`}
                session={session}
                name={key}
                question={question}
                caseOnly
              />
            ))}
        </details>
      )}
      {pack.documents?.map((document) => (
        <div key={document.key} className="space-y-1">
          <AttachFiles
            session={session}
            id={`file-${document.key}`}
            fileKey={document.key}
            label={
              <>
                {document.label} <code>({document.key})</code>
                {document.required ? "" : " — optional"}
              </>
            }
          />
          <FileList
            session={session}
            files={c.files.filter((file) => file.key === document.key)}
          />
        </div>
      ))}
      <AttachFiles
        session={session}
        id="file-evidence"
        label="Anything else that supports it: letters, records, photos"
      />
      <FileList
        session={session}
        files={c.files.filter((file) => !file.key && !file.followUp)}
      />
      <Refusal error={act.error} />
    </div>
  );
}

/**
 * Uploads the chosen files, one after another, and attaches each: as the
 * pack's document `fileKey`, or without one as other evidence.
 */
function AttachFiles({
  session,
  id,
  label,
  fileKey,
}: {
  session: CaseSession;
  id: string;
  label: ReactNode;
  fileKey?: string;
}) {
  const c = session.c!;
  const act = useAct();
  return (
    <div className="space-y-1">
      <label className="demo-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="file"
        multiple
        disabled={act.pending}
        onChange={(event) => {
          const input = event.currentTarget;
          const files = [...(input.files ?? [])];
          void act
            .run(async () => {
              for (const file of files) {
                await session.upload(file, c.seq, fileKey);
              }
            })
            .then(() => {
              input.value = "";
            });
        }}
      />
      <Refusal error={act.error} />
    </div>
  );
}

/** Attached files: a link to each, what reading it found, and what it is. */
function FileList({
  session,
  files,
}: {
  session: CaseSession;
  files: CaseView["files"];
}) {
  const c = session.c!;
  const act = useAct();
  const asked = definitionOf(c.processPack)?.documents ?? [];
  // A case's own files until it's approved; a follow-up once it's done.
  const open = c.status === "done" || c.approval === undefined;
  if (!files.length) return null;
  return (
    <ul className="space-y-2 text-sm">
      {files.map((file) => (
        <li key={file.storageId} className="space-y-1 rounded-lg border p-2">
          <p className="flex flex-wrap items-center gap-2">
            <a
              className="link-text"
              href={c.fileUrls[file.storageId]}
              target="_blank"
              rel="noreferrer"
            >
              {file.name}
            </a>
            <span className="text-gray-500">
              {file.mediaType} · {Math.ceil(file.size / 1024)} KB
            </span>
            {file.read.status === "reading" && (
              <Chip tone="blue">reading…</Chip>
            )}
            {open && (
              <button
                className="ml-auto text-red-700 underline"
                disabled={act.pending}
                onClick={() =>
                  void act.run(() =>
                    session.send(
                      { type: "document.remove", storageId: file.storageId },
                      c.seq,
                    ),
                  )
                }
              >
                Remove
              </button>
            )}
          </p>
          {file.read.status === "read" && (
            <p className="text-gray-600">{file.read.summary}</p>
          )}
          {file.read.status === "unread" && (
            <p className="text-gray-500">{file.read.reason}</p>
          )}
          {open && !file.followUp && asked.length > 0 && (
            <select
              className="input-field"
              aria-label={`What ${file.name} is`}
              value={file.key ?? ""}
              disabled={act.pending}
              onChange={(event) =>
                void act.run(() =>
                  session.send(
                    {
                      type: "document.label",
                      storageId: file.storageId,
                      key: event.target.value || undefined,
                    },
                    c.seq,
                  ),
                )
              }
            >
              <option value="">Other evidence</option>
              {asked.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </li>
      ))}
      <Refusal error={act.error} />
    </ul>
  );
}

/** The official form, filled in: a link to it, and what it leaves out. */
function FilledForm({
  session,
  document,
}: {
  session: CaseSession;
  document: NonNullable<NonNullable<CaseView["artifact"]>["document"]>;
}) {
  const url = useQuery(api.easygov.forms.data.documentUrl, {
    caseId: session.c!._id,
    guestKey: session.guestKey,
  });
  return (
    <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
      {url && (
        <a
          className="link-text font-medium"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open the official form, filled in
        </a>
      )}
      <p>
        {document.omissions.length === 0
          ? "Every value on it was read back from the PDF."
          : "These weren't written. They're left out, not cut short:"}
      </p>
      {document.omissions.length > 0 && (
        <ul className="list-disc pl-5">
          {document.omissions.map((omission) => (
            <li key={omission.label}>
              {omission.label}: {omission.reason}
            </li>
          ))}
        </ul>
      )}
      {document.toComplete.length > 0 && (
        <>
          <p className="font-medium">Left for you to complete:</p>
          <ul className="list-disc pl-5">
            {document.toComplete.map(({ why, note }) => (
              <li key={note}>
                {note}{" "}
                <span className="text-gray-600">
                  {why === "confidential"
                    ? "(confidential: we don't hold this)"
                    : "(your signature)"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Review({ session }: { session: CaseSession }) {
  const c = session.c!;
  const act = useAct();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">Review the document</h2>
      {c.artifact?.letter && (
        <pre className="whitespace-pre-wrap rounded-xl border bg-amber-50 p-4 text-sm">
          {c.artifact.letter}
        </pre>
      )}
      {c.artifact?.document && (
        <FilledForm session={session} document={c.artifact.document} />
      )}
      {c.artifact?.checklist && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">
            The steps that apply to you ({c.artifact.checklist.length} of the
            checklist's steps):
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            {c.artifact.checklist.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      <Result value={c.artifact && JSON.parse(c.artifact.summary)} />
      <button
        className="demo-button"
        disabled={act.pending}
        onClick={() =>
          void act.run(() => session.send({ type: "review.approve" }, c.seq))
        }
      >
        Approve
      </button>
      <Refusal error={act.error} />
    </div>
  );
}

function Consent({
  session,
  onClaimed,
}: {
  session: CaseSession;
  onClaimed?: () => void;
}) {
  const c = session.c!;
  const claim = useMutation(cases.claimCase);
  const act = useAct();
  const guest = c.userId.startsWith("guest:");
  const send = (event: CaseEvent) => act.run(() => session.send(event, c.seq));
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">
        Share this case with a lawyer? ({c.referral?.kind})
      </h2>
      <p className="text-sm text-gray-600">
        Nothing is copied to <code>referrals</code> unless the person says yes.
        {guest && " A guest has to claim the case before sharing it."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className="demo-button"
          disabled={act.pending}
          onClick={() => void send({ type: "referral.share" })}
        >
          Share
        </button>
        <button
          className="demo-secondary"
          disabled={act.pending}
          onClick={() => void send({ type: "referral.decline" })}
        >
          Don't share
        </button>
        {guest && session.guestKey && (
          <button
            className="demo-secondary"
            disabled={act.pending}
            onClick={() =>
              void act.run(async () => {
                await claim({
                  caseId: c._id,
                  guestKey: session.guestKey!,
                });
                onClaimed?.();
              })
            }
          >
            Claim the case (sign in)
          </button>
        )}
      </div>
      <Refusal error={act.error} />
    </div>
  );
}

function Ended({ session }: { session: CaseSession }) {
  const c = session.c!;
  const withdraw = useMutation(cases.withdrawReferral);
  const [withdrawn, setWithdrawn] = useState<boolean>();
  const act = useAct();
  return (
    <div className="demo-panel">
      <h2 className="font-semibold">The case is {c.status}</h2>
      <ul className="list-disc pl-5 text-sm">
        {c.endReason && <li>Reason: {c.endReason}</li>}
        <li>
          Delivery:{" "}
          {c.delivery ? `${c.delivery.status} (${c.delivery.channel})` : "none"}
        </li>
        <li>
          Referral:{" "}
          {c.referral ? `${c.referral.kind}, ${c.referral.status}` : "none"}
        </li>
      </ul>
      {c.referral?.status === "shared" && (
        <button
          className="demo-secondary"
          disabled={act.pending}
          onClick={() =>
            void act.run(async () =>
              setWithdrawn(
                await withdraw({ caseId: c._id, guestKey: session.guestKey }),
              ),
            )
          }
        >
          Take the referral back
        </button>
      )}
      {c.status === "done" && (
        <>
          <AttachFiles
            session={session}
            id="file-follow-up"
            label="What came afterwards: the receipt, or what the authority sent back"
          />
          <FileList
            session={session}
            files={c.files.filter((file) => file.followUp)}
          />
        </>
      )}
      {withdrawn !== undefined && (
        <p className="text-sm" role="status">
          {withdrawn
            ? "Withdrawn: no firm can take it now."
            : "Nothing to take back: it's already withdrawn, or a firm has it."}
        </p>
      )}
      <Refusal error={act.error} />
    </div>
  );
}

function Failed({ session }: { session: CaseSession }) {
  const c = session.c!;
  const act = useAct();
  const send = (event: CaseEvent) => act.run(() => session.send(event, c.seq));
  return (
    <div className="demo-panel border-red-200">
      <h2 className="font-semibold">The workflow failed</h2>
      <Result value={c.run?.state === "failed" ? c.run.error : undefined} />
      <div className="flex gap-2">
        <button
          className="demo-button"
          disabled={act.pending}
          onClick={() => void send({ type: "step.retry" })}
        >
          Retry from the top
        </button>
        <button
          className="demo-secondary"
          disabled={act.pending}
          onClick={() => void send({ type: "step.cancel" })}
        >
          Give up
        </button>
      </div>
      <Refusal error={act.error} />
    </div>
  );
}

function Now({
  session,
  onClaimed,
}: {
  session: CaseSession;
  onClaimed?: () => void;
}) {
  const c = session.c!;
  if (c.phase === "failed") return <Failed session={session} />;
  if (c.status !== "active") {
    return (
      <>
        <Ended session={session} />
        <Proposals guestKey={session.guestKey} />
      </>
    );
  }
  switch (c.waitingFor) {
    case "goal":
      return <Goal session={session} />;
    case "pack":
      return <Proposal session={session} />;
    case "answers":
      return <Answers session={session} />;
    case "approval":
      return (
        <>
          <Review session={session} />
          {(definitionOf(c.processPack)?.inputs.length ?? 0) > 0 && (
            <details className="demo-panel">
              <summary className="cursor-pointer font-medium">
                Change an answer (sends the case back around)
              </summary>
              <Answers session={session} />
            </details>
          )}
        </>
      );
    case "consent":
      return <Consent session={session} onClaimed={onClaimed} />;
    case null:
      return (
        <>
          <AskAhead caseId={c._id} guestKey={session.guestKey} />
          <Busy />
        </>
      );
  }
}

function Busy() {
  return (
    <p className="demo-panel text-sm text-gray-600" role="status">
      Nothing for the person to do: the workflow is working. If it stays here,
      check the Convex logs.
    </p>
  );
}

// --- Underneath -------------------------------------------------------------

const TEMPLATES: CaseEvent[] = [
  { type: "intake.submit", goal: "I moved and need to tell the IRS" },
  { type: "processPack.confirm" },
  { type: "processPack.reject" },
  { type: "answers.set", key: "fullName", value: "Ada Lovelace" },
  { type: "answers.accept" },
  { type: "document.label", storageId: "<storage id>" as Id<"_storage"> },
  { type: "document.remove", storageId: "<storage id>" as Id<"_storage"> },
  { type: "review.approve" },
  { type: "referral.share" },
  { type: "referral.decline" },
  { type: "step.retry" },
  { type: "step.cancel" },
  { type: "case.cancel" },
];

/** Sends any event with any `seq`, to see what the case takes and refuses. */
function AnyEvent({ session }: { session: CaseSession }) {
  const c = session.c!;
  const [json, setJson] = useState(JSON.stringify(TEMPLATES[0]));
  const [stale, setStale] = useState(false);
  const [taken, setTaken] = useState<string>();
  const act = useAct();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {TEMPLATES.map((template) => (
          <button
            key={template.type}
            className="rounded border px-2 py-0.5 text-xs hover:bg-gray-50"
            onClick={() => setJson(JSON.stringify(template))}
          >
            {template.type}
          </button>
        ))}
      </div>
      <textarea
        className="input-field font-mono text-sm"
        aria-label="Event JSON"
        rows={3}
        value={json}
        onChange={(event) => setJson(event.target.value)}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={stale}
          onChange={(event) => setStale(event.target.checked)}
        />
        Send with a stale seq ({c.seq - 1} instead of {c.seq})
      </label>
      <button
        className="demo-secondary"
        disabled={act.pending}
        onClick={() => {
          setTaken(undefined);
          void act.run(async () => {
            const event = JSON.parse(json) as CaseEvent;
            await session.send(event, stale ? c.seq - 1 : c.seq);
            setTaken(event.type);
          });
        }}
      >
        Send event
      </button>
      {taken && (
        <p className="text-sm text-green-700" role="status">
          Taken: {taken}
        </p>
      )}
      <Refusal error={act.error} />
    </div>
  );
}

function History({ session }: { session: CaseSession }) {
  const events = useQuery(api.easygov.dev.history, { caseId: session.c!._id });
  return (
    <ol className="space-y-1 text-sm" aria-label="Case history">
      {events?.map((event, i) => (
        <li key={i} className="flex gap-3">
          <span className="w-20 shrink-0 text-gray-400">
            {new Date(event.at).toLocaleTimeString()}
          </span>
          <code>{event.kind}</code>
          <span className="text-gray-600">{event.detail}</span>
        </li>
      ))}
    </ol>
  );
}

function Drawer({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="demo-panel">
      <summary className="cursor-pointer font-medium">{title}</summary>
      {children}
    </details>
  );
}

export function CaseWorkbench({
  session,
  onClaimed,
}: {
  session: CaseSession;
  onClaimed?: () => void;
}) {
  const { c } = session;
  const act = useAct();
  if (!c) return <p role="status">Loading the case…</p>;
  return (
    <div className="space-y-4">
      <Where c={c} />
      <Now session={session} onClaimed={onClaimed} />
      <Drawer title="History (caseEvents), in order">
        <History session={session} />
      </Drawer>
      <Drawer title="The case row (getCase)">
        <Result value={c} />
      </Drawer>
      {c.waitingFor !== "goal" && (
        <Drawer title="Conversation">
          <Transcript threadId={c.threadId} />
        </Drawer>
      )}
      {c.status === "active" && (
        <Drawer title="Send any event">
          <AnyEvent session={session} />
        </Drawer>
      )}
      {c.status === "active" && (
        <div>
          <button
            className="text-sm text-red-700 underline"
            disabled={act.pending}
            onClick={() =>
              void act.run(() => session.send({ type: "case.cancel" }, c.seq))
            }
          >
            Cancel this case
          </button>
          <Refusal error={act.error} />
        </div>
      )}
    </div>
  );
}
