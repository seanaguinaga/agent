// What the search model reports about a process, and the notes kept of it.
// Pure, so everything here can be tested without a search.
//
// The report comes back as data: the ways of filing the authority offers,
// and the forms each one needs. Code reads that data to ask which way the
// person wants and to route each form, so neither is left for a second model
// to work out again from prose. The notes are the same report written out as
// plain text: what the drafting model reads, and what a case stores.
import { z } from "zod/v4";
import { sameAddress, sameFormCode } from "../forms/sources";

/** The ways of filing a process, as answers to `FILING_METHOD`. */
export const METHODS = ["online", "mail", "in_person"] as const;
export type Method = (typeof METHODS)[number];

/** The input that says which way the person is filing. */
export const FILING_METHOD = "filingMethod";

export const METHOD_LABEL: Record<Method, string> = {
  online: "Online",
  mail: "By mail",
  in_person: "In person",
};

const zForm = z.object({
  code: z
    .string()
    .describe("The form's printed code, or its title if it has none."),
  pdfUrl: z
    .string()
    .describe('The form\'s direct official PDF URL, or "" if not found.'),
  requiredBy: z
    .string()
    .describe("The URL of the official page that requires the form."),
});

const FORM =
  "A form is a document with a printed code or title that the applicant fills in. " +
  "An account, a payment, a letter, a notice they were sent or an online service is not a form.";

export const zResearch = z.object({
  findings: z
    .string()
    .describe(
      "What the site says, as plain text under 400 words: the steps in order, and the documents, " +
        "fees, time limits, signature instructions and packet order it states. " +
        "Say so where the site doesn't state something.",
    ),
  methods: z
    .array(
      z.object({
        method: z.enum(METHODS),
        eligibility: z
          .string()
          .describe('Who may use this way, as the site states it, or "".'),
        forms: z
          .array(zForm)
          .describe(`The forms only this way of filing needs. ${FORM}`),
        portalUrl: z
          .string()
          .describe(
            'For online: the official application or portal URL, or "".',
          ),
      }),
    )
    .describe(
      "Each way of filing the authority offers, once each. Empty if the site doesn't say how to file.",
    ),
  forms: z
    .array(zForm)
    .describe(`The forms needed whichever way the person files. ${FORM}`),
  sources: z.array(z.string()).describe("The full URL of each page used."),
});

export type ResearchForm = z.infer<typeof zForm>;
export type Research = z.infer<typeof zResearch>;

/** A form to prepare, and the way of filing it belongs to, if only one. */
export type FormLead = ResearchForm & { method?: Method };

/** A full https URL, and nothing that would break a line of the notes. */
export const isPage = (url: string) => /^https:\/\/[^\s`"'<>()[\]]+$/.test(url);
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const page = (url: string) => (isPage(url.trim()) ? url.trim() : "");
/** An address that could be a PDF: models often give the page it is on. */
const pdf = (url: string) =>
  /pdf/i.test(page(url).split(/[?#]/)[0]) ? page(url) : "";

/**
 * The form's code out of what a model wrote for it, which is often the code
 * with its title: "DL 410 FO, Renewal by Mail Eligibility Information" or
 * "Application (DL 44)". The code is what the form prints and what it is
 * checked against, so the title is dropped. A bare title is kept whole.
 */
export function codeIn(text: string): string {
  const line = oneLine(text);
  // Two spellings of one code ("SSA-561-U2 / SSA-561") are the first. A
  // comma inside brackets doesn't end it: "SF 180 (Standard Form 180,
  // Military Records Requests)" is one entry.
  const outside = line.replace(/\([^()]*\)/g, (b) => "_".repeat(b.length));
  const cut = outside.search(/\s*[,:;–—]\s*|\s+[-/]\s+/);
  const lead = cut < 0 ? line : line.slice(0, cut);
  if (/\d/.test(lead.replace(/\([^()]*\)/g, ""))) {
    // The code's title in brackets after it: "SF 180 (Standard Form 180)".
    return lead.replace(/\s+\([^()]*\)$/, "");
  }
  // Only a title outside the brackets: the code is what they hold, unless
  // that is a revision date.
  const bracketed = line.match(/\(([^()]*\d[^()]*)\)/)?.[1].trim();
  return bracketed && !/^rev\b/i.test(bracketed) ? bracketed : line;
}

/** Research that is only its notes: no ways of filing and no forms known. */
export function bareResearch(notes: string): Research {
  return { findings: notes, methods: [], forms: [], sources: [] };
}

/**
 * Two entries for one form: the same code however each is written ("VA Form
 * 21-526EZ", "VA-21-526EZ"), the same title, or the same PDF.
 */
export function sameForm(
  a: Pick<ResearchForm, "code" | "pdfUrl">,
  b: Pick<ResearchForm, "code" | "pdfUrl">,
) {
  const key = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (
    key(a.code) === key(b.code) ||
    sameFormCode(a.code, b.code) ||
    sameAddress(a.pdfUrl, b.pdfUrl)
  );
}

function tidyForms(forms: ResearchForm[]): ResearchForm[] {
  return forms
    .map(({ code, pdfUrl, requiredBy }) => ({
      code: codeIn(code),
      pdfUrl: pdf(pdfUrl),
      // The page given as the PDF is at least where the form is asked for.
      requiredBy: page(requiredBy) || (pdf(pdfUrl) ? "" : page(pdfUrl)),
    }))
    .filter(({ code }) => code)
    .reduce<ResearchForm[]>(
      (kept, form) =>
        kept.some((other) => sameForm(other, form)) ? kept : [...kept, form],
      [],
    );
}

/**
 * The report with every way of filing listed once, every form listed once,
 * and only full https addresses. A form listed under every way is one that
 * is needed whichever way the person files.
 */
export function tidy(research: Research): Research {
  const methods = METHODS.flatMap((method) => {
    const entries = research.methods.filter((m) => m.method === method);
    if (!entries.length) return [];
    return [
      {
        method,
        eligibility: oneLine(
          entries.map((m) => m.eligibility).find((text) => text.trim()) ?? "",
        ),
        forms: tidyForms(entries.flatMap((m) => m.forms)),
        portalUrl: entries.map((m) => page(m.portalUrl)).find(Boolean) ?? "",
      },
    ];
  });
  const everywhere = (form: ResearchForm) =>
    methods.length > 1 &&
    methods.every((m) => m.forms.some((other) => sameForm(other, form)));
  const common = tidyForms([
    ...research.forms,
    ...methods.flatMap((m) => m.forms.filter(everywhere)),
  ]);
  return {
    findings: research.findings.trim(),
    methods: methods.map((m) => ({
      ...m,
      forms: m.forms.filter(
        (form) => !common.some((other) => sameForm(other, form)),
      ),
    })),
    forms: common,
    sources: unique(research.sources.map(page).filter(Boolean)),
  };
}

/**
 * The report with the forms a way of filing was asked about on its own.
 * That answer says which way a form belongs to, which a general report often
 * doesn't: so a form it names stops being one needed whichever way.
 */
export function withMethodForms(
  research: Research,
  asked: { method: Method; forms: ResearchForm[] }[],
): Research {
  const claimed = asked.flatMap(({ forms }) => forms);
  return tidy({
    ...research,
    forms: research.forms.filter(
      (form) => !claimed.some((other) => sameForm(other, form)),
    ),
    methods: research.methods.map((entry) => ({
      ...entry,
      forms: [
        ...asked.flatMap((a) => (a.method === entry.method ? a.forms : [])),
        ...entry.forms,
      ],
    })),
  });
}

/** The ways of filing found. A choice only when there is more than one. */
export function methodsOf(research: Research): Method[] {
  return research.methods.map(({ method }) => method);
}

/**
 * Whether a form can be told apart from every other: by a printed code, or
 * by the PDF it was found at. A bare title ("Renewal notice", "Application")
 * is prose, and three titles for one form are three forms to a reader.
 */
export function isIdentified(form: ResearchForm): boolean {
  return !!form.pdfUrl || /\d/.test(form.code);
}

/** Every form reported: those every way needs, then each way's own. */
export function formLeads(research: Research): FormLead[] {
  return [
    ...research.forms,
    ...research.methods.flatMap(({ method, forms }) =>
      forms.map((form) => ({ ...form, method })),
    ),
  ];
}

/**
 * The pages the report rests on: the ones it used, each page that requires
 * a form, and each portal. A form's PDF address is a lead until it has been
 * fetched, so it isn't one of them.
 */
export function pagesOf(research: Research): string[] {
  return unique(
    [
      ...research.sources,
      ...research.methods.map((m) => m.portalUrl),
      ...formLeads(research).map((form) => form.requiredBy),
    ].filter(isPage),
  );
}

/**
 * The research as notes: the findings, each way of filing, each form with
 * its PDF, then every page. Empty if the search found nothing to say.
 */
export function notesOf(research: Research): string {
  const findings = research.findings.trim();
  if (!findings) return "";
  const forms = formLeads(research);
  const pages = pagesOf(research);
  return [
    findings,
    research.methods.length ? "Ways to file:" : "",
    ...research.methods.map(
      ({ method, eligibility, portalUrl }) =>
        `- ${METHOD_LABEL[method]}` +
        (eligibility ? `: ${eligibility}` : "") +
        (portalUrl ? ` Portal: ${portalUrl}` : ""),
    ),
    forms.length ? "Forms:" : "",
    ...forms.map(
      ({ code, pdfUrl, requiredBy, method }) =>
        `- ${code}${method ? ` (${METHOD_LABEL[method].toLowerCase()} only)` : ""}: ` +
        (pdfUrl ? `PDF ${pdfUrl}` : "PDF not located") +
        (requiredBy ? `, required by ${requiredBy}` : ""),
    ),
    pages.length ? `Pages: ${pages.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The way of filing a route's answer names, however it is worded. */
export function methodNamed(answer: string): Method | undefined {
  const text = answer.toLowerCase().replace(/[^a-z]/g, "");
  if (/online|internet|web|portal|electronic/.test(text)) return "online";
  if (/mail|post/.test(text)) return "mail";
  if (/person|office|counter/.test(text)) return "in_person";
  return undefined;
}

/** The question that asks which way of filing, offering the ways found. */
export function filingQuestion(methods: Method[]) {
  const ways = methods.map((m) => METHOD_LABEL[m].toLowerCase());
  return {
    key: FILING_METHOD,
    question: `How do you want to do this: ${ways.slice(0, -1).join(", ")} or ${ways.at(-1)}?`,
    choices: methods.map((value) => ({ value, label: METHOD_LABEL[value] })),
  };
}

/**
 * The addresses a search reports having read: from the call's metadata, not
 * from anything the model wrote. The search model's provider lists them as
 * `url_citation` annotations on the raw response, which the SDK's own
 * `sources` leaves out, so both are read.
 */
export function pagesSearched(result: {
  sources?: readonly unknown[];
  response?: { body?: unknown };
}): string[] {
  const urls: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) return value.forEach((v) => walk(v, depth + 1));
    for (const [key, inner] of Object.entries(value)) {
      if (key === "url" && typeof inner === "string") urls.push(inner);
      else if (key !== "content") walk(inner, depth + 1);
    }
  };
  walk(result.sources ?? [], 0);
  walk(result.response?.body ?? null, 0);
  return [...new Set(urls)];
}
