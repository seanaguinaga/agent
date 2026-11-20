# The profile

A person's own facts, kept apart from any one case: their name, addresses, how
to reach them. A form reads them from here, so a fact given once is there for
every form after it.

## The key is the meaning

`vocabulary.ts` holds a fixed set of **facts** (`name`, `homeAddress`,
`mailingAddress`, `phone`, `email`, `birthDate`), each stored once, in parts. A
**reading** is one way of writing a fact down, worked out by code: `fullName`,
`middleInitial`, `mailingStreet`, `mailingZip`, `homeAddressLine`.

A pack input whose key is a reading is answered from the profile. Nothing else
binds them: two packs that ask for `mailingZip` ask for the same thing. Any
other input is a question about the case itself.

- **Parts, never a rendered string.** An address is street, unit, city, state,
  ZIP and country. Every box a form has is a reading of those.
- **Unknown and "none" are different.** A middle name nobody asked about is
  unknown; `middle: null` is the person saying they have none, and reads as an
  empty, answered, box.
- **An initial is worked out.** `middleInitial` comes from the middle name, so a
  whole name can't end up in a one-letter box.
- **A mailing address can follow the home address**
  (`{ sameAs: "homeAddress" }`): a pointer, so one edit fixes both.
- **It grows by adding entries.** Nothing is renamed: a saved pack keeps the
  keys it was written with.

## Filled in before the form is known

`profile/public:save` needs no case and no pack. A person can give their facts
while their case is still being researched, and whatever form turns up reads
them. `profile/public:askAhead` says what's worth asking now:

- On a case with a confirmed pack: exactly the facts that pack reads.
- Before that: the facts the saved packs read most often, counted from the
  library. It stops guessing as soon as the pack is known.

## How it meets a case

A case's `answers` are always what its document is built from. `following` lists
the ones read from the profile.

- **Until the artifact is accepted, the case follows the profile.** Saving a
  fact re-reads it into the person's open cases (`syncCase` in `data.ts`).
- **After that, it keeps its own.** A later move doesn't rewrite a filed
  document.
- **An answer given on the case is the case's.** With `caseOnly` it stays there;
  without, it's kept for next time (below).
- **An old fact is offered, not filled in.** An address over a year old comes
  back as a suggestion ("still right?"); accepting confirms it.

## What a person answers is kept

`answers.set` and `answers.accept` keep the answer for the person, not only for
the case (`keepAnswer` in `data.ts`):

- **A profile fact typed as text** goes to the profile when there's no doubt
  what it means: a phone number, an email, a date, a two-word name. A longer
  name or a one-line address stays on the case; its parts aren't ours to guess.
- **Anything else is remembered** against the pack that asked, with the
  question's words. The same pack offers it back next time. Another pack's it
  counts as something the person said, and may be suggested for a similar
  question. Suggested, never filled in.

A pack can also link an input to the profile without being a reading (`profile`
on the pack):

```json
[
  { "input": "oldAddress", "reads": "homeAddressLine" },
  { "input": "newAddress", "updates": "homeAddress" }
]
```

`reads` offers a reading as the input's starting answer. `updates` makes a
proposal when the case is done: the person confirms the fact's parts (a model
splits the one-line address for them, `agents.ts`) and it becomes their
profile's.

## The rows

| Table               | Holds                                                           |
| ------------------- | --------------------------------------------------------------- |
| `profileFacts`      | One row per fact per save. Never changed; the latest is current |
| `rememberedAnswers` | Answers that aren't profile facts, with the pack and question   |
| `profileProposals`  | What a finished case suggests for the profile                   |

A guest's facts are kept under their guest key and come along when the case is
claimed. `profile/public:forget` removes everything here for the caller; cases
keep the answers they were built from.

## What isn't here yet

- Facts about anyone but the person (a spouse, a beneficiary). Those stay case
  questions.
- A dated address history. Rows are immutable, so it can be added without
  rewriting anything.
- Social Security numbers. `sensitive` marks facts to keep out of logs and model
  prompts, and only `birthDate` uses it so far.
