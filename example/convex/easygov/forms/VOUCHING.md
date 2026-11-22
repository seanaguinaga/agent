# Vouched sites

How EasyGov decides, in any country, that a form is the government's own, and is
shown to the person as confirmed. This is the plan being built, stage by stage.
Each stage's status is kept here, so the work can be picked up where it stopped.

## Why

The first rule (commits d931d64f, 99e7a84e) came from the US `.gov` register.
The page linking a form and the file had to be on one registered domain, of the
packet's level of government and state. Domains outside it came from a hand-kept
list. That can't work internationally:

- most countries have no register;
- many governments use open names (`canada.ca`, `gov.ie`, `bund.de`, `dgid.sn`);
- a per-domain list never ends.

## What was measured (2026-11-21)

- **US:** all 272 PDF links on 21 official pages were on the same site as the
  page linking them.
- **Keyword crawl, 15 forms in 10 countries:** from each national portal, 4/15
  forms were reached within 4 links, and 8/15 within 5.
- **A strong model picking each link, with a hosted browser:** 12/15 were
  reached in 3–8 links, and every successful chain stayed on government hosts.
  - Germany failed: the results render partly.
  - Mexico failed: gob.mx is search-only and never links SAT.
  - Australia failed: NAT 1432 is paper-order only, through iorder.com.au.
- **Government pages link third parties.** usa.gov links taxadmin.org and
  careeronestop.org, the ATO links auspost.com.au and iorder.com.au, and
  india.gov.in carries an affiliate link.
- **Blocked to plain requests:** SSA, gov.ie, india.gov.in and ato.gov.au. The
  browser gets through.
- **The app's browser missed script-built pages.** It read `outerHTML` at
  readyState "complete", so it missed links that scripts add and links inside
  shadow roots. bund.de gave it 0 links, against 51 when the browser waited and
  read the shadow roots.
- **Senegal** mixes `.gouv.sn` (finances, cour suprême) and open `.sn`
  (primature.sn, presidence.sn, dgid.sn). servicepublic.gouv.sn didn't load.
  finances.gouv.sn links dgid.sn, but dgid.sn links back to no `.gouv.sn` site.

## The design

**Trust a government, not a site.** Every vouched site records its owner:
national, a region (ISO 3166-2), or a local body. A restricted suffix proves a
site is a government's, never which one: `.gov.uk`, `.gob.mx` and `.gov.au` each
hold several levels.

**Vouch at the edge, on demand.** A domain is vouched the first time a vouched
page links to it or redirects to it, and the vouch is saved. A country's
government web is never crawled.

**A site is vouched by one of these:**

- **register:** an official register of the country's government domains, such
  as CISA's `.gov` list. It gives the owner with no model call.
- **suffix:** a suffix the country restricts to government, cited from the
  registry's own policy page. A model still judges the owner.
- **link:** a vouched page of that government links the domain. Needed: the
  model is sure it's the government's own (≥ 0.8), there is structural support,
  and it is at most 2 steps from a register, suffix or hand site. Support is one
  of: the site links back, a second vouched domain links it, or a vouched host
  redirects to it.
- **hand:** one line in git, with the evidence. For what nothing else vouches.

Model and support are both required: neither is enough alone. iorder.com.au, a
vendor, links back to the ATO; dgid.sn, the real tax office, links back to
nothing.

**A form is confirmed when all of these hold:**

1. The authority's page links the file as the form, and the file prints no
   expiry that has passed.
2. The page and the file are both on vouched sites.
3. Each owner is the packet's government, or one above it on its jurisdiction
   chain.
4. If both owners are local, they are the same body.

Same domain is no longer required, so `www.gov.uk` →
`assets.publishing.service.gov.uk` passes. A county packet accepts the state's
file, but never another state's.

**What may be read is looser than what confirms.** A site may be read if it is
vouched, or reached by one link or redirect from a vouched page. That is what
vouching itself must read, and what lets a form be found but shown unconfirmed.
Addresses only a search cited, with no vouched link to them, are never read:
that keeps out copy sites like dmv.org. An address must be https, on a public
name, with no credentials and the default port.

## Decisions (owner, 2026-11-21)

1. A national government is one owner: an IRS page linking an SSA file confirms.
2. A packet accepts its own government and the governments above it.
3. dgid.sn gets a hand line. No vouch rests on the model alone.
4. Whoever adds a country cites the registry's policy page for each suffix. No
   citation, no suffix. `.gouv.sn` stays out until someone cites it.
5. A contractor-run site is never vouched.
6. Forms that only a search found, on unvouched sites, are not shown, and not
   read.
7. The Public Suffix List is used to find a host's registrable domain. Taking
   the last two labels is wrong for `finances.gouv.sn`.

## What it replaces

Each item is replaced, never kept beside the new one:

- `officialSites`, `Registered`, `levelsOf`, `domainOf`, `sitesOf` and
  `Finder.owners` become the `sites` table and one lookup. The CISA register
  stays, as one importer writing `register` rows.
- `ownSite` and its GSA SF/OF exception become `confirms`. GSA is national, so
  the exception goes.
- `UNREGISTERED` becomes `hand` entries. acgov.org should need none:
  alamedacountyca.gov is in the register, and the two link each other.
- `isOfficialHost` becomes `mayRead` at every call site.

## Not built, on purpose

- a crawl of any country's government web;
- ownership by agency within a government, or rules by path;
- trust scores, WHOIS or certificate checks;
- an admin screen: the review queue is a query, and approval is a line in git;
- vouching vendors, or reading closed shadow roots;
- a second finder for unvouched sites.

## Known limits

- A compromised government domain isn't detected, as with `.gov` today.
- A government page linking an old copy on its own site isn't caught by the
  host. Expiry and latest-revision ranking remain the defence.
- Unverified: whether `.gouv.sn` is restricted, and whether the UK publishes its
  `.gov.uk` names.
- A public name that resolves to a private address isn't detected.

## Stages

Each stage is one commit, with its proof.

- [x] **0. Reshape.** `Owner`, `Site`, the `sites` table, one lookup,
      `confirms`. Register rows become `register`, and acgov.org becomes `hand`.
      _Proof:_ tests pass, and the 272 US links give the same confirmed set as
      before: each is confirmed for its page's own government, as it was, and
      nothing confirmed before is lost.
  - _Changed from the plan:_
    - `Site` has only the `vouched` shape and the `register` and `hand` vias so
      far. The rest arrive with the stages that write them.
    - `Site` carries a `name` (the agency, in words), because the link chooser
      is told whose each site is.
    - `.mil` is a `hand` line until stage 2 makes it a suffix.
    - Which local body a packet is for can't be told from its name, so a local
      packet accepts any local body of its region, as before. Page and file must
      still be the same body.
    - The registrable domain comes from `tldts`, which carries the Public Suffix
      List.
  - _Newly confirmed, on purpose:_
    - a page and a file on two sites of one national government (decision 1),
      which covers what the GSA exception did, and any two `.mil` sites;
    - a state or local packet whose page or file is on a government above it
      (decision 2);
    - acgov.org with alamedacountyca.gov, as one body's two sites.
  - _No longer confirmed:_ a tribal or interstate body's site for a state
    packet. Those are local bodies now.
  - _To run once after deploying:_
    `npx convex run easygov/forms/sites:importSites`, or nothing is confirmed
    until Monday's import. The old `officialSites` table is then unused, and can
    be deleted.
- [x] **1. Browser.** Read `getHTML({ shadowRoots })` once the link count holds
      on two polls. _Proof:_ a fixture test with a shadow root, and bund.de
      gives ≥ 51 links.
  - _Measured:_ bund.de gives 50 links through `openViaBrowser` and
    `labelledLinks`, where it gave 0. They are the same 50 addresses as the
    measurement's. Its 51st was the page itself, from a close button's
    `href="#"`, which `labelledLinks` leaves out as no link at all.
  - _Changed from the plan:_ a page is taken when everything it says of itself
    (where it is, that it has loaded, its link count) is the same on two polls,
    or when the time is up. Each page read through the browser so waits one poll
    longer, 2 seconds.
- [x] **2. Suffixes, owner judgment, `mayRead`.** `forms/governments.ts` holds
      each country's suffixes, root and hand lines. _Proof:_ the 12 measured
      chains as fixtures, counting how many confirm with no link vouch.
  - _Measured (`chains.test.ts`):_ 11 of the 12 chains are read to the end and
    confirmed. Ireland's is not: gov.ie links revenue.ie, an open name nothing
    vouches for yet, so only its front page is read (one link from gov.ie) and
    the form, three links further on, is neither reached nor confirmed. Four
    sites were judged, once each: `www.gov.uk`, `service.gov.uk`, `ird.govt.nz`
    and `passportindia.gov.in`.
  - _Suffixes cited:_ `.gov`, `.mil`, `.gov.uk`, `.gov.au`, `.govt.nz`,
    `.gouv.fr`, `.gov.in` and `.gob.mx`, each with its page in `governments.ts`.
    `.mil` and `.gouv.fr` have one owner, and are never judged. Two citations
    are weaker than the rest:
    - `.mil`: the registry's policy as RFC 1956, written by the DoD NIC. DoD
      Instruction 8410.01, on esd.whs.mil, refuses plain requests.
    - `.govt.nz`: the government's moderation policy refuses plain requests, so
      it was read as the Wayback Machine's copy of 2021. InternetNZ's .nz Rules
      of March 2026, read directly, say the government's moderator decides who
      may use `.govt.nz`.
  - _Not cited, so not listed:_ `.gouv.sn` (nic.sn serves no text to a plain
    request). Not looked for: `.gc.ca`, `.gov.ie`, and the German states'.
  - _Changed from the plan:_
    - `Site` has a third shape beside vouched and declined: `unjudged`, a site
      on a government's suffix that nobody has judged yet. It is never kept: it
      is what a lookup gives. It may be read, and it confirms nothing.
    - Whose a site is is judged when a form's link is to be confirmed: the site
      of the page and the site of the file, not every site passed through. A
      judgment below 0.8 is declined as unsure. Where the model gives no answer
      nothing is kept, and the site is asked about again.
    - A local body is judged without its region, and its body is its domain. So
      a suffix site judged local confirms nothing yet: a local packet needs the
      region. The register's local bodies are unaffected.
    - A country's regions are listed in `governments.ts` as ISO 3166-2 codes.
      The US has none: the register says whose each `.gov` domain is, so a
      `.gov` site it doesn't list can only be judged national or local.
    - `root` is only recorded, and checked to be a national hand line. Nothing
      starts from it until stage 3.
    - The site's title and footer come from one plain request for its front
      page, paid for by the vouch. A site that refuses plain requests is judged
      on its name and the linking page's words alone.
    - The register's row for a domain is never replaced by a judgment, and only
      register rows are forgotten when the register drops a domain.
  - _Looser than before, on purpose:_ every link on a government's page is kept,
    and one redirect off a government's site is followed. Both were refused
    before. Nothing reached that way confirms.
  - _Tighter than before:_ an address on a private or local name, or an IP
    address, is never read. A file an earlier case chose on nobody's site is not
    read again as a remembered lead: only as a page links it.
  - _To do once before deploying:_ the `sites` rows written by stage 0 have no
    `state`, and the `by_at` index is replaced. Clear the `sites` table, deploy,
    then run `npx convex run easygov/forms/sites:importSites`.
- [ ] **3. Measure.** Run the 15 forms through the app's own link chooser (the
      decision model), with the browser. This is paid. If the small model
      reaches few forms, finding is the bottleneck, not confirming.
- [ ] **4. Link vouching.** _Proof:_ acgov.org and formulare-bfinv.de are
      vouched; iorder.com.au, taxadmin.org, careeronestop.org and auspost.com.au
      are declined; the hand list shrinks to dgid.sn.
- [ ] **5. Re-check and revoke.** Link vouches expire after 90 days and the
      weekly job re-checks them. Evidence gone twice means revoked. _Proof:_ a
      test with a removed link.
