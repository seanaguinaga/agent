// Finding a packet's forms.
//
// The authority says "complete form X". This binds that name to one file:
// form X itself, its current edition, in the person's language. What holds:
//
// 1. A form is one thing: looked up once, and one entry, however many
//    spellings or addresses lead to it.
// 2. A file is one thing: its bytes, read and kept once.
// 3. An address is asked once in a packet. Between cases a file is asked
//    for again only so the server can say it hasn't changed.
// 4. A packet has one allowance for the fetching and model calls that find
//    its forms (see `PACKET_LIMITS`).
// 5. What makes the binding is the authority's own page linking a file as
//    the form, chosen with confidence: looked for on the pages research read
//    and, failing that, one link further on, and no further.
// 6. A file that prints an expiry that has passed is never given as
//    confirmed, and is chosen only when no current file serves the form.
import { type Infer } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { researchModel } from "../../modelsForDemo";
import { decide } from "../decisions";
import type { vProcessPackDefinition } from "../packs/schema";
import type { FileAnswer, LinksAnswer } from "../forms/actions";
import { budget, type Budget, type Limits } from "../forms/budget";
import { rankForms, type FormFacts } from "../forms/facts";
import type { FormQuestion } from "../forms/mapping";
import {
  addressKey,
  isOfficialHost,
  leadsFrom,
  looseKey,
  shortlist,
  type LabelledLink,
  type PageLink,
} from "../forms/sources";
import {
  citedIn,
  groupsOf,
  onePerForm,
  sameEntry,
  type Subject,
} from "./draft";
import { noStorage, selectionAgent } from "./selection";

/** What finding one packet's forms may spend, in all. See `budget.ts`. */
const PACKET_LIMITS: Limits = {
  downloads: 12,
  browser: 10,
  searches: 4,
  decisions: 10,
  pages: 12,
};

/** The finding of one packet's forms: its allowance, and what it has asked. */
export type Finder = {
  spend: Budget;
  /** Names the packet, so an address knows what this packet asked it. */
  id: string;
  /**
   * The last ask of each address, in any letter case: the spelling asked,
   * what it was asked as, and the answer.
   */
  asked: Map<string, Promise<{ url: string; as: string; answer: Answer }>>;
};

export const newFinder = (limits: Limits = PACKET_LIMITS): Finder => ({
  spend: budget(limits),
  id: crypto.randomUUID(),
  asked: new Map(),
});

type Answer = FileAnswer | LinksAnswer;
type No = Extract<Answer, { ok: false }>;

/** What an address is asked as when it is read for its links. */
const PAGE = "page";

/**
 * Why an ask got nothing that says anything about the address: the asking
 * failed, not the address. Such an answer is never reused.
 */
const passing = (answer: Answer) =>
  !answer.ok &&
  (answer.why === "refused" ||
    answer.why === "busy" ||
    answer.why === "unspent");

/**
 * Asks an address, once in a packet: after whoever asked it last, whose
 * answer is this one's if it was for the same thing and either served it or
 * was for the same spelling. (Two spellings of one address are usually one
 * place, so the second is asked only if the first gave nothing.) The cheap way first,
 * and the browser only if that was turned away. Each way is paid for from
 * the packet's allowance, and the payment is taken back if it cost nothing.
 */
function ask<A extends Answer>(
  finder: Finder,
  url: string,
  as: string,
  how: (way: "request" | "browser", spend: boolean) => Promise<A>,
): Promise<A | No> {
  const { spend } = finder;
  const pay = async (way: "request" | "browser") => {
    const kind =
      way === "browser" ? "browser" : as === PAGE ? "pages" : "downloads";
    const paid = spend.take(kind);
    let used = 0;
    try {
      const answer = await how(way, paid);
      used = answer.cost[kind];
      const { bytes, reused, unchanged } = answer.cost;
      spend.add({ bytes, reused, unchanged });
      if (!answer.ok && answer.why === "unspent") spend.add({ refused: 1 });
      return answer;
    } finally {
      if (paid && !used) spend.giveBack(kind);
    }
  };
  const key = looseKey(url);
  const earlier = finder.asked.get(key);
  const run = (async () => {
    const before = await earlier;
    if (
      before?.as === as &&
      (before.answer.ok ||
        (addressKey(before.url) === addressKey(url) && !passing(before.answer)))
    ) {
      return before;
    }
    try {
      const plain = await pay("request");
      const answer =
        plain.ok || plain.why !== "refused" ? plain : await pay("browser");
      return { url, as, answer };
    } catch (error) {
      console.error("Address unavailable", url, error);
      const answer: No = {
        ok: false,
        why: "unusable",
        note: `${error}`.slice(0, 200),
        cost: {
          downloads: 0,
          browser: 0,
          pages: 0,
          bytes: 0,
          held: 0,
          reused: 0,
          unchanged: 0,
        },
      };
      return { url, as, answer };
    }
  })();
  finder.asked.set(key, run);
  // The same `as` is always asked the same way, so its answer is an `A`.
  return run.then(({ answer }) => answer as A | No);
}

/** The file at an address, as a form. */
export async function fileAt(
  ctx: ActionCtx,
  finder: Finder,
  form: {
    jurisdiction: string;
    code: string;
    /** The page's words for its link to the address, if it links it as the form. */
    linkedAs?: string;
  },
  url: string,
): Promise<FileAnswer> {
  return await ask(
    finder,
    url,
    `${form.code}\n${form.linkedAs ?? ""}`,
    (way, spend) =>
      ctx.runAction(internal.easygov.forms.actions.fetchFile, {
        ...form,
        url,
        way,
        spend,
        packet: finder.id,
      }),
  );
}

/** The links an official page carries, each saying whose page it is on. */
async function linksAt(
  ctx: ActionCtx,
  finder: Finder,
  page: string,
): Promise<PageLink[]> {
  const answer = await ask(finder, page, PAGE, (way, spend) =>
    ctx.runAction(internal.easygov.forms.actions.readLinks, {
      url: page,
      way,
      spend,
      packet: finder.id,
    }),
  );
  if (!answer.ok) return [];
  const on = new URL(page).hostname;
  return answer.links.map((link) => ({ ...link, on }));
}

/** As many of the pages research read as are read for their links. */
const MAX_PAGES = 8;

/** As many pages one link further on as are read for one form. */
const MAX_FURTHER = 2;

/** Items with an address, each address once. */
function eachOnce<T extends { url: string }>(items: T[]): T[] {
  return groupsOf(items, (a, b) => addressKey(a.url) === addressKey(b.url)).map(
    ([first]) => first,
  );
}

/** The links on official pages, with their words, as read now. */
async function linksOn(
  ctx: ActionCtx,
  finder: Finder,
  pages: string[],
): Promise<PageLink[]> {
  const found = await Promise.all(
    pages
      // A PDF among the pages is itself a lead, tried as one: not a page.
      .filter(
        (page) => isOfficialHost(page) && !/pdf/i.test(page.split("?")[0]),
      )
      .slice(0, MAX_PAGES)
      .map((page) => linksAt(ctx, finder, page)),
  );
  return eachOnce(found.flat());
}

/** The link an authority's pages give for a form, and how sure the choice is. */
type Designated = {
  url: string;
  label: string;
  /** The heading the link sits under on the page, if it has one. */
  under?: string;
  /** From `SURE` to 1. */
  confidence: number;
  /** The site of the page the link was on. */
  on?: string;
  /** True if it was found one link further on than the pages research read. */
  further: boolean;
};

/** Who owns a host: the authority's site it is on, and the organization. */
type Owner = { site: string; organization: string };

/** Who owns each of these hosts, where the register says. */
async function ownersOf(
  ctx: ActionCtx,
  hosts: string[],
): Promise<Map<string, Owner>> {
  const found = await ctx.runQuery(internal.easygov.forms.sites.sitesOf, {
    hosts: hosts.filter(Boolean),
  });
  return new Map(found.map(({ host, ...owner }) => [host, owner]));
}

const hostOf = (url: string) => new URL(url).hostname;

/** What a choice of link considered, when it wasn't acted on. */
type Considered = { choice: string; confidence?: number };

/** Below this, a choice of link is a guess, and isn't acted on. */
const SURE = 0.5;

/**
 * Which of an authority's own links is the form. The choice is among links
 * that exist, so no address can be made up, and it has to come with a
 * confidence of at least `SURE`. Where the decision model can't be reached,
 * no link is chosen: the form is then found, if at all, by its other leads,
 * and isn't given as confirmed.
 */
async function chooseLink(
  ctx: ActionCtx,
  code: string,
  subject: Pick<Subject, "jurisdiction" | "authority">,
  links: LabelledLink[],
  spend: Budget,
): Promise<{
  designated?: Omit<Designated, "further">;
  considered?: Considered;
}> {
  if (!links.length) return {};
  if (!spend.take("decisions")) {
    spend.add({ refused: 1 });
    return {};
  }
  // The page's words for the link: its own, and the heading it sits under.
  // Then who owns the file's site and the page's: any government's page can
  // link a form, and only the authority's own says which file is its form.
  const owners = await ownersOf(ctx, [
    ...links.map(({ url }) => hostOf(url)),
    ...links.map(({ on }) => on ?? ""),
  ]);
  const whose = (host: string) => {
    const owner = owners.get(host)?.organization;
    return owner ? `${owner} (${host})` : host;
  };
  const describe = ({ url, label, under, on }: LabelledLink) => {
    const { hostname, pathname } = new URL(url);
    return (
      `${label || "(no words)"}` +
      (under ? `, under the heading "${under}"` : "") +
      ` [a file of ${whose(hostname)}: …/${decodeURI(pathname.split("/").pop() ?? "")}` +
      (on ? `, linked from a page of ${whose(on)}]` : "]")
    );
  };
  const decided = await decide(ctx, {
    state: {
      form: code,
      authority: subject.authority ?? "",
      jurisdiction: subject.jurisdiction,
    },
    instructions:
      `Which link is the blank form ${code} itself, in English, for a person to fill in? ` +
      "Failing that, the authority's own page for that form. " +
      `It has to be published by ${subject.authority ?? "the authority"} itself: ` +
      "not a copy, or another government's version, on some other site. " +
      "Not its instructions, not a translation, and not another form with a similar name. " +
      "Go by the link's words and the heading it is under before its file name: " +
      "a form that was renamed can keep its old file name. " +
      "Choose none if no link is that form.",
    criteria: {
      ...Object.fromEntries(
        links.map((link, i) => [`link${i + 1}`, describe(link)]),
      ),
      none: "No link here is that form.",
    },
  });
  if (!decided) return {};
  const link = links[Number(decided.choice.replace(/^link/, "")) - 1];
  const { confidence } = decided;
  if (!link || confidence === undefined || confidence < SURE) {
    const choice = link
      ? `${link.label} [${link.url.split("/").pop()}]`
      : "none";
    return { considered: { choice, confidence } };
  }
  const { url, label, under, on } = link;
  return { designated: { url, label, under, on, confidence } };
}

/** How an address for a form was come by, most trusted first. */
type Via = "linked" | "given" | "variant" | "known" | "search";
type Lead = { url: string; via: Via };

/** A file fetched for a form, and what it says about itself. */
type FormFile = {
  url: string;
  editionId: Id<"formEditions">;
  via: Via;
  facts: FormFacts;
  /** Whether it is the file the authority's own link gives. */
  designated: boolean;
};

type Failure = { url: string; via: Via; why: string; note: string };

/** What asking some leads for a form gave. */
type Tried = { files: FormFile[]; pages: string[]; failed: Failure[] };

/** The file chosen for a form. */
type ChosenFile = {
  url: string;
  /** The PDF as fetched from `url`. */
  editionId: Id<"formEditions">;
  via: Via;
  facts: FormFacts;
  /**
   * Whether an official page links this file as the form, and it hasn't
   * expired: the binding itself, not a file that only names the form.
   */
  backed: boolean;
};

/** What finding a form gave: its file, if any, and how it was come by. */
type Located = {
  file?: ChosenFile;
  /** The other files that named the form, which this one was chosen over. */
  others: Omit<FormFile, "editionId" | "designated">[];
  /** The authority's own link to the form, where it gave one of the files. */
  designated?: Designated;
  /** Why there is or isn't one: how many links there were to choose from. */
  links: {
    onPages: number;
    shortlisted: number;
    /** Pages read one link further on, looking for the form's own. */
    further: number;
    chose: string;
    considered?: Considered;
  };
  /** The leads that gave no file for the form, each with why. */
  failed: Failure[];
};

/** Asks each lead as the form, and sorts what came back. */
async function tryLeads(
  ctx: ActionCtx,
  finder: Finder,
  form: { jurisdiction: string; code: string; linkedAs?: string },
  leads: Lead[],
): Promise<Tried> {
  const answers = await Promise.all(
    eachOnce(leads.filter(({ url }) => url)).map(async (lead) => ({
      lead,
      answer: await fileAt(ctx, finder, form, lead.url),
    })),
  );
  return {
    files: answers.flatMap(({ lead, answer }) =>
      answer.ok
        ? [
            {
              url: lead.url,
              via: lead.via,
              editionId: answer.editionId,
              facts: answer.facts,
              designated: lead.via === "linked",
            },
          ]
        : [],
    ),
    pages: answers.flatMap(({ lead, answer }) =>
      !answer.ok && answer.why === "page" ? [lead.url] : [],
    ),
    failed: answers.flatMap(({ lead, answer }) =>
      answer.ok ? [] : [{ ...lead, why: answer.why, note: answer.note }],
    ),
  };
}

/**
 * The files several tries gave, each file once: the same bytes reached by
 * two addresses are one file, linked if either address was the link.
 */
function filesOf(tries: Tried[]): FormFile[] {
  return groupsOf(
    tries.flatMap(({ files }) => files),
    (a, b) => a.editionId === b.editionId,
  ).map((same) => ({
    ...same[0],
    designated: same.some(({ designated }) => designated),
  }));
}

/**
 * Whether a file settles the form, so no other lead is asked: the file the
 * authority's own link gives, current, in English, with places to write in.
 * No other lead could be chosen over it (see `rankForms`).
 */
function settles(files: FormFile[]): boolean {
  return files.some(
    ({ designated, facts }) =>
      designated &&
      !facts.expired &&
      facts.places > 0 &&
      (facts.language === "en" || facts.language === "both"),
  );
}

/**
 * The file to use for a form. Every address is only a lead: all of them are
 * asked, each file that names the form is known by its facts, and the best
 * is chosen by those facts (see `rankForms`), not by which was found first.
 * The leads are the authority's own link to the form, where its pages have
 * one; the addresses research gave and their English editions; and the
 * addresses earlier cases chose.
 *
 * Where the pages research read don't link the form, its own page is usually
 * one link further on: a lead that turned out to be a page. Those are read
 * for the link, and no page beyond them. Only if no lead serves the form is
 * the search model asked for it alone.
 */
export async function locateForm(
  ctx: ActionCtx,
  threadId: string,
  form: { code: string; leads: string[] },
  subject: Pick<Subject, "jurisdiction" | "authority">,
  finder: Finder,
  options: {
    /** The links on the pages research read, with their words. */
    links?: () => Promise<PageLink[]>;
    /**
     * The authority's own sites: those of the pages research read. Only a
     * link on one of them, to a file on one of them, confirms a file.
     */
    authority?: () => Promise<Set<string>>;
    /** False to stop before asking the search model. */
    search?: boolean;
  } = {},
): Promise<Located> {
  const { jurisdiction, authority } = subject;
  const { code } = form;
  const asForm = (linkedAs?: string) => ({ jurisdiction, code, linkedAs });
  const as = (via: Via) => (url: string) => ({ url, via });

  /** Chooses the form's link among these, and asks it as the form. */
  const follow = async (links: LabelledLink[]) => {
    const short = shortlist(links, code);
    const chosen = await chooseLink(ctx, code, subject, short, finder.spend);
    const tried = chosen.designated
      ? await tryLeads(
          ctx,
          finder,
          asForm(`${chosen.designated.label} ${chosen.designated.under ?? ""}`),
          leadsFrom(chosen.designated.url).map(as("linked")),
        )
      : undefined;
    return { short, ...chosen, tried };
  };

  // The authority's own link to the form, if its pages have one: the only
  // lead that states which form a file is. A link isn't taken for a file or
  // a page by how its address looks: it is asked, and says which it is.
  const onPages = options.links ? await options.links() : [];
  const first = await follow(onPages);

  // What earlier cases chose for this form, so a search that misses it this
  // time doesn't lose it. Not needed once the linked file settles the form.
  const given = form.leads.filter(Boolean);
  const leads = settles(filesOf(first.tried ? [first.tried] : []))
    ? undefined
    : await tryLeads(ctx, finder, asForm(), [
        ...given.map(as("given")),
        ...given.flatMap(leadsFrom).map(as("variant")),
        ...(
          await ctx.runQuery(internal.easygov.forms.data.knownSources, {
            jurisdiction,
            code,
          })
        ).map(as("known")),
      ]);

  // One link further on: where the link chosen, or a lead, was the form's
  // own page and not its file, that page's links are chosen among. No
  // further than that.
  const sofar = [first.tried, leads].filter((tried) => tried !== undefined);
  const beyond = filesOf(sofar).some(({ designated }) => designated)
    ? []
    : eachOnce(sofar.flatMap(({ pages }) => pages.map((url) => ({ url }))))
        .slice(0, MAX_FURTHER)
        .map(({ url }) => url);
  const further = beyond.length
    ? await follow(
        eachOnce(
          (
            await Promise.all(beyond.map((url) => linksAt(ctx, finder, url)))
          ).flat(),
        ),
      )
    : undefined;

  // The search model, for this form alone, only if no lead gave a file.
  const before = [...sofar, ...(further?.tried ? [further.tried] : [])];
  const searched =
    filesOf(before).length || options.search === false
      ? undefined
      : await searchFor(ctx, threadId, finder, asForm(), authority, given);
  const tries = [...before, ...(searched ? [searched] : [])];
  const files = filesOf(tries);

  // Which link the chosen file came by: the one followed further on, where
  // that one was.
  const linked = files.some(({ designated }) => designated)
    ? further?.designated
      ? { ...further.designated, further: true }
      : first.designated && { ...first.designated, further: false }
    : undefined;
  const links = {
    onPages: onPages.length,
    shortlisted: first.short.length,
    further: beyond.length,
    chose: linked
      ? "a link"
      : !onPages.length
        ? "no links on the pages"
        : !first.short.length
          ? "no link shares the code"
          : "none of the shortlist",
    considered: further?.considered ?? first.considered,
  };
  const failed = eachOnce(tries.flatMap((tried) => tried.failed));

  const [best, ...rest] = rankForms(files);
  if (!best) return { others: [], links, failed };
  await ctx.runMutation(internal.easygov.forms.data.rememberChosen, {
    jurisdiction,
    code,
    url: best.url,
  });
  const { url, editionId, via, facts } = best;
  return {
    file: {
      url,
      editionId,
      via,
      facts,
      backed:
        best.designated &&
        // A file that prints a date it expired on isn't given as confirmed,
        // whoever links it: an authority's page can link an edition it
        // replaced.
        !facts.expired &&
        (await onAuthoritySites(ctx, options.authority, [
          linked?.on,
          hostOf(url),
        ])),
    },
    others: rest.map(({ url, via, facts }) => ({ url, via, facts })),
    designated: linked,
    links,
    failed,
  };
}

/** Whether every one of these hosts is on one of the authority's own sites. */
async function onAuthoritySites(
  ctx: ActionCtx,
  authority: (() => Promise<Set<string>>) | undefined,
  hosts: (string | undefined)[],
): Promise<boolean> {
  const own = authority ? await authority() : new Set<string>();
  if (!own.size || hosts.some((host) => !host)) return false;
  const owners = await ownersOf(ctx, hosts as string[]);
  return hosts.every((host) => own.has(owners.get(host!)?.site ?? ""));
}

/** Asks the search model for a form's official file, and tries what it cites. */
async function searchFor(
  ctx: ActionCtx,
  threadId: string,
  finder: Finder,
  form: { jurisdiction: string; code: string },
  authority: string | undefined,
  given: string[],
): Promise<Tried | undefined> {
  const { code, jurisdiction } = form;
  if (!finder.spend.take("searches")) {
    finder.spend.add({ refused: 1 });
    return undefined;
  }
  try {
    const result = await selectionAgent.generateText(
      ctx,
      { threadId },
      {
        model: researchModel,
        prompt: [
          `Find the current official blank PDF for ${code}, published by ${authority ?? jurisdiction}.`,
          given.length &&
            `That address could not supply the PDF: ${given[0]}. Look for another official publication location, including the authority's own forms service.`,
          "Return direct official file URLs only. Omit instruction booklets and application portals.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      { contextOptions: { recentMessages: 0 }, ...noStorage },
    );
    return await tryLeads(
      ctx,
      finder,
      form,
      citedIn(result.text)
        .slice(0, 3)
        .flatMap(leadsFrom)
        .map((url) => ({ url, via: "search" as const })),
    );
  } catch (error) {
    console.error("Official form lookup unavailable", code, error);
    return undefined;
  }
}

/** A form of a packet, as research named it. */
type NamedForm = {
  code: string;
  sourceUrl: string;
  when?: { key: string; equals: string };
};

/**
 * Each of a packet's forms with the file found for it. A form is looked up
 * once, however many entries name it; and entries that turn out to be one
 * file are one form (see `onePerForm`).
 */
export async function locateForms<T extends NamedForm>(
  ctx: ActionCtx,
  threadId: string,
  forms: T[],
  subject: Pick<Subject, "jurisdiction" | "authority">,
  /** The official pages research read. */
  pages: string[],
  finder: Finder,
): Promise<{ form: T; located: Located }[]> {
  // The pages are read for their links once, and only if a form needs it.
  let reading: ReturnType<typeof linksOn> | undefined;
  const links = () => (reading ??= linksOn(ctx, finder, pages));
  // The authority's own sites: those of the pages research read.
  let owning: Promise<Set<string>> | undefined;
  const authority = () =>
    (owning ??= ownersOf(ctx, pages.filter(isOfficialHost).map(hostOf)).then(
      (owners) => new Set([...owners.values()].map(({ site }) => site)),
    ));
  const lookups = groupsOf(forms, sameEntry);
  const located = await Promise.all(
    lookups.map((members) =>
      locateForm(
        ctx,
        threadId,
        {
          // A printed code is what a file is checked against.
          code: (members.find(({ code }) => /\d/.test(code)) ?? members[0])
            .code,
          leads: members.map(({ sourceUrl }) => sourceUrl),
        },
        subject,
        finder,
        { links, authority },
      ),
    ),
  );
  const entries = lookups.flatMap((members, i) =>
    members.map((form) => ({
      code: form.code,
      when: form.when,
      form,
      located: located[i],
    })),
  );
  return onePerForm(
    entries,
    (a, b) =>
      a.located === b.located ||
      (!!a.located.file &&
        a.located.file.editionId === b.located.file?.editionId),
  ).map(({ form, when, located }) => ({
    form: { ...form, when },
    located,
  }));
}

type Draft = Infer<typeof vProcessPackDefinition>;
type PacketForm = NonNullable<Draft["packetForms"]>[number];

/**
 * The draft with each packet form bound to its file and made fillable where
 * it can be. A form says it is `backed` only for the file found now: what
 * an earlier draft said of an earlier file is dropped.
 */
export async function compilePacketForms(
  ctx: ActionCtx,
  threadId: string,
  draft: Draft,
  finder: Finder,
): Promise<Draft> {
  if (!draft.packetForms?.length) return draft;
  const found = await locateForms(
    ctx,
    threadId,
    draft.packetForms,
    draft,
    draft.output?.sources ?? [],
    finder,
  );
  // The same file under two ways of filing is compiled once.
  const compiling = new Map<string, Promise<Compiled | undefined>>();
  const compiled = (code: string, file: ChosenFile) => {
    const running =
      compiling.get(file.editionId) ??
      compile(ctx, draft.jurisdiction, code, file);
    compiling.set(file.editionId, running);
    return running;
  };
  const prepared = await Promise.all(
    found.map(async ({ form: entry, located: { file } }) => {
      const { backed: _earlier, ...named } = entry;
      if (!file) {
        // An address nothing came from isn't kept as a source.
        return {
          questions: [],
          form: {
            ...named,
            sourceUrl: "",
            openItem: `Complete ${named.code} manually. EasyGov could not prepare a copy from the official source.`,
          } satisfies PacketForm,
        };
      }
      const form = { ...named, sourceUrl: file.url, backed: file.backed };
      const made = await compiled(form.code, file);
      if (made) {
        return {
          questions: made.questions,
          form: {
            ...form,
            blueprintId: made.blueprintId,
            inputs: made.questions.map((q) => q.key),
            openItem: undefined,
          } satisfies PacketForm,
        };
      }
      // If the PDF is at least there, the person is pointed to it.
      // "Official" is said only of a file the authority's page links.
      return {
        questions: [],
        form: {
          ...form,
          openItem: file.backed
            ? `Complete ${form.code} by hand. EasyGov found the official form but could not fill it in.`
            : `Complete ${form.code} by hand. EasyGov found a file for it but could not fill it in.`,
        } satisfies PacketForm,
      };
    }),
  );
  const questions = new Map(
    [
      ...(draft.inputQuestions ?? []),
      ...prepared.flatMap((result) => result.questions),
    ].map((q) => [q.key, q]),
  );
  // The alert that a packet hit its ceiling: search the logs for this line.
  if (finder.spend.spent.refused) {
    console.warn("easygov packet allowance ran out", {
      jurisdiction: draft.jurisdiction,
      authority: draft.authority,
      spent: finder.spend.spent,
    });
  }
  return {
    ...draft,
    packetForms: prepared.map((result) => result.form),
    inputQuestions: [...questions.values()],
  };
}

type Compiled = {
  blueprintId: Id<"formBlueprints">;
  questions: FormQuestion[];
};

/** A file made fillable as a form: its blueprint and its questions. */
async function compile(
  ctx: ActionCtx,
  jurisdiction: string,
  code: string,
  file: ChosenFile,
): Promise<Compiled | undefined> {
  try {
    const compiled: Compiled = await ctx.runAction(
      internal.easygov.forms.agents.compileSource,
      { jurisdiction, code, sourceUrl: file.url, editionId: file.editionId },
    );
    return compiled;
  } catch (error) {
    console.error("Form could not be made fillable", code, file.url, error);
    return undefined;
  }
}
