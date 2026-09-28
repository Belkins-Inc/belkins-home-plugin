---
name: providers
description: How to call the paid data providers (Apollo, Generect, BetterContact, FullEnrich, Bouncer, Scrubby, Firecrawl, Bright Data) through `bh call`, what each costs and which one answers which question. Use before any provider call, when choosing a provider, or when reading what a call cost.
---

# Providers through `bh call`

Every paid provider is reached through the engine: `bh call <provider> <METHOD> <path?query>`.
The keys live on the server only — never curl a provider, never ask for a key. The engine adds the
key, forwards the request as written, records the call in `provider_calls` and its cost in `spend`.

## Before the first call of a session

1. `bh use <project>` (once per session) — `bh call` refuses a call with no project, so spend
   always lands on one.
2. `bh providers` — which providers this engine has a key for (`configured`), the priced endpoints,
   `perCallUsd` / `perResultUsd`, which ones guard repeats, and for a provider priced by credits
   (BetterContact) `usdPerCredit` and the `creditsLeft` its latest answer reported.
3. Look for earlier work before paying for it again:

   ```sh
   bh sql "select c.at, c.provider, c.endpoint, c.params->'body' as body, c.results, c.cost_usd
           from provider_calls c
           where c.project_id = @project and c.provider = 'generect' and c.at > now() - interval '30 days'
           order by c.at desc" --limit 50
   bh sql "select ran_at, provider, query, cursor, results, new_records, cost_usd
           from searches where source_id = '<source-id>' order by ran_at desc"
   ```

   `bh sql` is not scoped to a project: filter by `@project` (replaced with the current project's id)
   or by an id.

## The call

```sh
bh call generect POST /search/database/companies/count/ --body '{"locations":["United Kingdom"]}'
bh call bouncer GET "/email/verify?email=anna%40acme.com&timeout=20" --contact <contact-id>
bh call bettercontact POST / --body-file batch.json
```

- **Path** is relative to the provider's base URL (see `bh providers` or the reference file); the
  query goes in the path. URL-encode values (`%20`, `%40`): a path with a space is refused.
- **Body**: `--body '<json>'` or `--body-file <path|->`. JSON only — multipart uploads are not
  possible through `bh call`.
- **stdout** is the provider's answer, untouched. Pipe it to a scratch file and read it with `jq`.
- **stderr** is one line: `# <provider> <status> · $<cost> · <n> results · call <call-id>`. Keep the
  call id — `bh search record` needs it. Capture both:
  `bh call … > /tmp/p/page1.json 2> /tmp/p/page1.meta`.
- A provider answer ≥ 400 still prints the body and exits 1. A 4xx/5xx is recorded at $0 (these
  providers do not charge refusals). `provider_unreachable` means nothing was charged; try again.

### Tie the call to what it was for

Pass the refs you know, so spend lands on the right segment, company or contact:
`--strategy <id> --segment <id> --source <id> --search <id> --company <id> --contact <id>`.

- A company search: `--segment` and `--source`; then `bh search record` with the call ids (it sets
  `search_id` on the calls and their spend afterwards, so `--search` is rarely needed).
- A contact search: `--strategy` (and `--company` when searching inside one company).
- Enrichment, email finding, verification of one record: `--company` or `--contact`.

### The repeat guard

Paid endpoints marked `guardRepeats` refuse the **same request** (method, path, query, body) that
already succeeded in the last 30 days: `409 repeated_request`, naming the earlier call. Use what
the earlier call produced — it should already be in `companies` / `contacts` / `searches`, and
`bh call show <call-id>` prints the provider's answer again for free. Add `--again` (and pay again)
only when the data itself must be fresh.

The ledger keeps answers up to 1 MB (`provider_calls.response`); a larger answer is not kept. Upsert
what you need from an answer in the same session anyway — a lost large answer costs a second call.

### Unknown prices

A few endpoints have no known rate (Scrubby submission, Apollo people search). Their calls print `cost unknown` and write no `spend` row; the `results` count is still
kept. Never invent a cost. If an invoice for such a provider arrives, a person records it with
`bh spend add --provider <p> --operation data_purchase --usd <n> --note <what>`.

BetterContact and FullEnrich state the credits a batch used in the answer, and the engine books
those at the plan's price per credit (BetterContact $0.05, FullEnrich $0.055; `usdPerCredit` in
`bh providers`). When a plan changes, an admin sets the new price with
`bh providers price <provider> --usd <n>`; it applies from then on.

### Spend

`bh spend` (this month by provider and operation) or `bh spend --from 2026-09-01 --to 2026-10-01`.
Its `balances` are the credits left on each provider account that reports them — the account's, not
the project's.
Check it before a large order and mention it in `bh session end`.

## Which provider for which question

| Question | Provider | Reference |
| --- | --- | --- |
| How many companies / people match (free) | Generect database `…/count/` | [generect](references/generect.md) |
| Companies in a market (LinkedIn data) | Generect database companies, $0.0045/row | [generect](references/generect.md) |
| People inside a company, or off a segment | Generect database leads, $0.0045/row | [generect](references/generect.md) |
| Which LinkedIn profile is this named person | Apollo `people/match` first, Generect realtime leads only when Apollo is silent | [apollo](references/apollo.md) |
| A company's LinkedIn page from its name | Generect realtime companies with `keywords`, $0.007/row | [generect](references/generect.md) |
| A person's email address | BetterContact (async, up to 100 per batch), $0.05 per address found | [bettercontact](references/bettercontact.md) |
| A second try, or a phone number (when a person asks) | FullEnrich (async), $0.055 per credit | [fullenrich](references/fullenrich.md) |
| Is this address deliverable, is the domain catch-all | Bouncer, $0.0056/address | [bouncer](references/bouncer.md) |
| Settle a catch-all / unknown address, confirm a guess | Scrubby deep check (24–72 h) | [scrubby](references/scrubby.md) |
| A web page as text, a site's page list | Firecrawl scrape / map, $0.0009 each | [firecrawl](references/firecrawl.md) |
| Companies with bad (or good) Trustpilot reviews | Bright Data Trustpilot dataset, $2.50 / 1,000 rows | [brightdata](references/brightdata.md) |

Rules that cut across providers:

- **Count before you page.** Generect counts are free; a count tells you whether the filter means
  what you think before a single row is bought.
- **Page small first.** Ask for 10–25 rows, read them, check they are the market you meant, then
  go wider.
- **An address from a search or profile provider is not an address.** Apollo and Generect addresses
  are ignored; addresses come from BetterContact/FullEnrich and are verified with Bouncer.
- **Nothing sends to an unverified address.** See the `email-finding` skill.
- **A scheduled agent may call only Bouncer and Scrubby** (for address checks after a bounce); every
  other provider refuses its token with 403. Sourcing is a person's session.
- A 402 / 429 / 5xx is the provider saying "not now" (balance, rate, outage) — wait and retry; it
  is not a verdict on the data. A 401/403 from the provider is the engine's key — tell a person.

## What to record

- Every company or contact search: `bh search record` with `callIds` (see `sourcing-linkedin`).
- Anything learned about a provider that the next session needs (a filter that did not narrow, a
  price seen in `meta.amount_charged`): `bh note add --kind insight --title "<provider>: …"`.
- In `bh session end --summary`, say what was spent and on what.

## Common mistakes

- Paying again with `--again` for an answer `bh call show <call-id>` still has.
- Re-running page 1 of a query in a new session instead of reading `searches.cursor`.
- Sending Apollo search filters as a JSON body (ignored — the search becomes "everybody").
- Ordering a Bright Data snapshot without `records_limit`.
- Taking `email_not_unlocked@…` or an incidental provider email as a contact's address.
- Using `--again` to "retry" a call that failed: a failed call is not guarded, so `--again` is only
  needed to repeat a call that succeeded.
