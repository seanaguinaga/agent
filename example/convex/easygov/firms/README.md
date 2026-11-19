# firms/

**Who may take a case the person agreed to share?**

When a person says yes to a referral, a copy of what they approved is saved as a
row in `referrals`. One law firm that covers it accepts it, and only that firm
reads it.

| File            | Touches the database? | Job                                                 |
| --------------- | --------------------- | --------------------------------------------------- |
| `schema.ts`     | no                    | Firms, referrals, declines, charges, and `covers`   |
| `data.ts`       | yes                   | `save`: add a reviewed firm                         |
| `public.ts`     | yes                   | What a firm calls: preview, accept, decline, packet |
| `firms.test.ts` | (tests)               | Previews, coverage, accepting, withdrawing          |

## How a referral moves

1. **Shared.** `referral.share` (in `case/events.ts`) saves the referral as
   `open`, with where it applies and a fixed price.
2. **Previewed.** `previews` shows a firm the open referrals it covers: the
   kind, the place, the process, the deadline, which questions were answered,
   which asked-for files were attached and how many files there are in all.
   Nothing the person wrote is in a preview.
3. **Accepted.** `accept` gives the referral to the first firm that takes it and
   records what the firm owes in `referralCharges`. `decline` hides it from that
   firm only, and only while it's `open`. A firm that declined can still accept:
   that undoes its decline.
4. **Read.** `packet` returns the goal, the answers, and every file the person
   attached before approving (a link, its name, and what reading it found) to
   the firm that accepted, and to no one else.

The person can take an `open` referral back with `case/public:withdrawReferral`:
the referral and the case's own `referral.status` both become `withdrawn`. Once
a firm has accepted it, they can't.

## Coverage

A firm lists the kinds of referral it takes and where:
`{ kind: "employment", jurisdiction: "us/ca" }`. A place covers itself and
everything inside it, so `us/ca` covers `us/ca/alameda`, and `us` covers every
state. A referral with no jurisdiction matches no firm.

A referral's jurisdiction is its pack's. A request for legal advice has no pack,
so it uses the place the selection agent read from the request.

## The parts that are hard to follow

- **Firms aren't self-serve.** `save` is internal: someone checks who the firm
  is and where it may practice, then adds it. `userId` is the account that acts
  for it.
- **The price is fixed when the case is shared**: the pack's
  `referral.priceCents`, or `DEFAULT_PRICE_CENTS`. It doesn't depend on what
  comes of the case.
- **`referralCharges` is a record, not a payment.** Nothing is charged here.
- **A firm that doesn't cover a referral gets "not found"**, the same as for one
  that doesn't exist, so it can't probe for referrals outside its coverage.
- **The `previews` index range.** `us/ca` and everything inside it sorts from
  `us/ca` up to `us/ca0`. So does `us/ca-x`, another place, which `covers` then
  drops.
