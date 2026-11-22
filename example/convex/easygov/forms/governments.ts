// What each country's names say of its governments' sites: kept here, in
// git, one entry a country (see VOUCHING.md). Pure.
//
// A suffix is listed only with the page where its registry, or the
// government, says it is kept for government: no citation, no suffix. It
// proves a site is a government's, never which one, unless `owner` says the
// suffix has only one. A site on an open name is a `hand` line, with the
// evidence that the government publishes from it: never a site that only
// looks official, such as dmv.org.
import { getDomain } from "tldts";
import type { Owner, Site } from "./sites";

type Government = {
  /** ISO 3166-1, in lower case. */
  country: string;
  /** Its regions' ISO 3166-2 codes, without the country: "nsw vic". */
  regions?: string;
  suffixes: { suffix: string; owner?: Owner; policy: string }[];
  /** The national portal, where its name is an open one. */
  root?: string;
  hand: { domain: string; name: string; owner: Owner; note: string }[];
};

const national = (country: string): Owner => ({ level: "national", country });

export const GOVERNMENTS: Government[] = [
  {
    country: "us",
    // No regions: CISA's register says whose each .gov domain is.
    suffixes: [
      { suffix: "gov", policy: "https://get.gov/domains/eligibility/" },
      {
        suffix: "mil",
        owner: national("us"),
        policy: "https://www.rfc-editor.org/rfc/rfc1956.txt",
      },
    ],
    hand: [
      {
        domain: "acgov.org",
        name: "Alameda County",
        owner: {
          level: "local",
          country: "us",
          region: "us-ca",
          body: "Alameda County",
        },
        note: "alamedacountyca.gov, the county's registered site, and acgov.org link each other.",
      },
    ],
  },
  {
    country: "gb",
    regions: "eng nir sct wls",
    suffixes: [
      {
        suffix: "gov.uk",
        policy:
          "https://www.gov.uk/guidance/check-if-your-organisation-can-get-a-govuk-domain-name",
      },
    ],
    hand: [],
  },
  {
    country: "au",
    regions: "act nsw nt qld sa tas vic wa",
    suffixes: [
      {
        suffix: "gov.au",
        policy:
          "https://www.auda.org.au/au-domain-names/the-different-au-domain-names/gov-au-domain-names/",
      },
    ],
    hand: [],
  },
  {
    country: "nz",
    suffixes: [
      {
        suffix: "govt.nz",
        policy:
          "https://www.dns.govt.nz/standards-and-guidance/technology-and-architecture/domain-names/apply-for-a-domain/moderation-policy",
      },
    ],
    hand: [],
  },
  {
    country: "fr",
    suffixes: [
      {
        suffix: "gouv.fr",
        owner: national("fr"),
        policy:
          "https://www.afnic.fr/wp-media/uploads/2026/07/afnic-charte-de-nommage-06-07-2026.pdf",
      },
    ],
    hand: [],
  },
  {
    country: "in",
    regions:
      "an ap ar as br cg ch dh dl ga gj hp hr jh jk ka kl la ld mh ml mn mp mz nl od pb py rj sk tn tr ts uk up wb",
    suffixes: [{ suffix: "gov.in", policy: "https://registry.gov.in/" }],
    hand: [],
  },
  {
    country: "mx",
    regions:
      "agu bcn bcs cam chh chp cmx coa col dur gro gua hid jal mex mic mor nay nle oax pue que roo sin slp son tab tam tla ver yuc zac",
    suffixes: [
      { suffix: "gob.mx", policy: "https://www.dominios.mx/dominios-gob-mx/" },
    ],
    hand: [],
  },
  {
    country: "ca",
    suffixes: [],
    root: "canada.ca",
    hand: [
      {
        domain: "canada.ca",
        name: "Government of Canada",
        owner: national("ca"),
        note: "www.gc.ca, the federal government's own name, redirects to it.",
      },
    ],
  },
  {
    country: "ie",
    suffixes: [],
    root: "gov.ie",
    hand: [
      {
        domain: "gov.ie",
        name: "Government of Ireland",
        owner: national("ie"),
        note: "The Department of the Taoiseach publishes from it: www.taoiseach.gov.ie lands on www.gov.ie.",
      },
    ],
  },
  {
    country: "de",
    suffixes: [],
    root: "bund.de",
    hand: [
      {
        domain: "bund.de",
        name: "Bundesportal",
        owner: national("de"),
        note: "The federal portal: bundesregierung.de, the federal government's site, links social.bund.de.",
      },
    ],
  },
  {
    country: "sn",
    // .gouv.sn stays out until someone cites its registry's policy.
    suffixes: [],
    root: "primature.sn",
    hand: [
      {
        domain: "primature.sn",
        name: "Primature du Sénégal",
        owner: national("sn"),
        note: "www.sec.gouv.sn, the government secretariat's name, redirects to it.",
      },
      {
        domain: "dgid.sn",
        name: "Direction générale des impôts et des domaines",
        owner: national("sn"),
        note: "www.finances.gouv.sn, the finance ministry's site, links it as its tax office.",
      },
    ],
  },
];

/**
 * What a host's name alone says of its site: a hand-kept line, or a suffix
 * its country keeps for government. On such a suffix the site is the
 * registrable domain (the Public Suffix List tells it), and whose it is has
 * yet to be judged unless the suffix has one owner.
 */
export function governed(host: string): Site | undefined {
  const name = host.toLowerCase();
  for (const { country, suffixes, hand } of GOVERNMENTS) {
    const line = hand.find(
      ({ domain }) => name === domain || name.endsWith(`.${domain}`),
    );
    if (line) {
      const { note, ...site } = line;
      return { state: "vouched", ...site, via: { kind: "hand", note } };
    }
    const kept = suffixes.find(({ suffix }) => name.endsWith(`.${suffix}`));
    const domain = kept && getDomain(name);
    if (!domain) continue;
    const { suffix, owner } = kept;
    return owner
      ? {
          state: "vouched",
          domain,
          name: domain,
          owner,
          via: { kind: "suffix", suffix },
        }
      : { state: "unjudged", domain, country, suffix };
  }
  return undefined;
}
