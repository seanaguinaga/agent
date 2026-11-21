// What the person is told about where a packet form's file came from.
// `backed` says only whether an official page links the file as the form:
// never that the form is current or will be accepted.

export type BackedForm = { code: string; sourceUrl: string; backed?: boolean };

export type BackingNote =
  | { kind: "unconfirmed"; headline: string; detail: string; action: string }
  | { kind: "linked"; text: string };

/** Nothing for a form that doesn't say (a pack made before it was recorded). */
export function backingNote({ code, backed }: BackedForm): BackingNote | null {
  if (backed === undefined) return null;
  if (backed)
    return {
      kind: "linked",
      text: `An official page of the authority links this file as ${code}.`,
    };
  return {
    kind: "unconfirmed",
    headline: `${code}: not confirmed by the authority’s own page`,
    detail:
      `This file was found under the name ${code}, but no page of the authority that was read links it as this form. ` +
      `It may be an older edition or a copy.`,
    action: `Before you file it, check on the authority’s site that it is the current edition of ${code}.`,
  };
}

/** `pages` are the official pages the process was written from, if known. */
export function FormBacking({
  form,
  pages,
}: {
  form: BackedForm;
  pages?: string[];
}) {
  const note = backingNote(form);
  if (!note) return null;
  if (note.kind === "linked")
    return <p className="text-sm text-gray-600">{note.text}</p>;
  return (
    <div className="text-sm text-amber-800" role="note">
      <p className="font-medium">{note.headline}</p>
      <p>
        {note.detail} {note.action}
      </p>
      <ul className="list-disc break-all pl-5">
        <li>
          <a
            className="link-text"
            href={form.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            The file that was found
          </a>
        </li>
        {pages?.map((url) => (
          <li key={url}>
            Authority page read:{" "}
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
