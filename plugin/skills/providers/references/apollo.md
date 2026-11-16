# Apollo

Base `https://api.apollo.io/api/v1`; the engine sends the key as `x-api-key` (the only form Apollo
reads — anything else answers `422 Api key required`).

Apollo answers these questions here: **which LinkedIn profile is this named person**, **the first
try for a work email**, **the first try for a phone number**, **how many people with a title a
company or a market holds** (the free people search), and **which companies are hiring for a role
now** (company search with job titles). For a segment defined only by industry, country and size, the
free people search followed by `bulk_match` by id is also a sourcing path, the cheapest measured
(below). A segment defined by a company-level fact the people index cannot see is still sourced
company first, with Generect (generect.md).

Priced in credits: $3,560 for 550,000 a month, **$0.006473 a credit**. The engine books each call by
the credits it used (`bh call` prints them); an admin changes the price with
`bh providers price apollo --usd <n>`.

## Emails and phones — `people/bulk_match` (the first step of the waterfall)

Up to 10 people a call. Match by `linkedin_url` whenever the contact has one; add the name and
employer either way.

```sh
bh call apollo POST /people/bulk_match --strategy <id> --body '{
  "details": [
    {"linkedin_url": "https://www.linkedin.com/in/anna-berg", "first_name": "Anna", "last_name": "Berg",
     "domain": "acme.com", "organization_name": "Acme"}
  ],
  "reveal_personal_emails": false
}' > /tmp/p/apollo1.json 2> /tmp/p/apollo1.meta
```

- `matches[]` follows `details[]` in order; `null` is a person Apollo does not know. **One credit
  ($0.0065) per person matched**, nothing for a miss (`credits_consumed`: 401 for 401 matched of 406).
- **Email**: `matches[i].email` with `email_status` (`verified`, `extrapolated`, `unavailable`).
  An Apollo address is a candidate, not an address: it counts only once **Bouncer** says
  `deliverable` (email-finding). Apollo's `verified` is not a verdict — on 2026-10-07 it called
  `verified` 8 of 38 addresses that had hard-bounced `no_such_user` for us.
- Measured 2026-10-07 on 150 contacts whose BetterContact address had been delivered: Apollo gave
  an address for 127, the same one for 99; of the different ones Bouncer checked, 8 of 9 were
  deliverable. Of 120 people BetterContact could not find, Apollo had an address for 41 (9 valid at
  Bouncer and QuickEmailVerification, most of the rest catch-all).

### Phones: add `"reveal_phone_number": true`

```sh
bh call apollo POST /people/bulk_match --strategy <id> --body '{"details":[…], "reveal_personal_emails": false, "reveal_phone_number": true}'
# apollo 200 · $0.0647 · 10 credits · 10 results · call <call-id>
# the rest arrives later, to the engine: bh call show <call-id> lists it under deliveries
```

- Apollo reveals phones **only to a webhook**: the engine adds its own `webhook_url` (never pass one)
  and books the delivery as a call of its own. The answer itself carries the emails at once; the
  phones arrive within seconds.
- **The engine puts them on the contacts** (`bh phones <contact-id>`): each person Apollo matched
  is found among the project's contacts by the `linkedin_url` you asked with (or Apollo's), else by
  Apollo's email — so upsert the contacts before the call. The raw delivery stays readable with
  `bh call show <call-id>`: `deliveries[].response.people[]` is
  `{id, phone_numbers: [{sanitized_number, type_cd, confidence_cd, status_cd, dnc_status_cd}]}`,
  `people[].id` joined to `matches[].id` of the answer; a person with empty `phone_numbers` has none.
- **When Apollo finds no number for anyone in the call, it sends nothing** — `deliveries` stays empty
  and no phone credits are charged. A delivery comes within seconds when there is one (production,
  2026-10-07: one in 2 s; none after 17 minutes for two people without numbers). So an empty
  `deliveries` ten minutes on means no numbers: record the miss (email-finding, section D).
- **Five credits ($0.032) per person a number was found for**, nothing otherwise — so there is no
  need to check first whether a phone exists.
- `type_cd`: `mobile`, `work_direct`, `home`, `other`. The engine ranks a mobile first, then
  `work_direct` (kind `direct`), then the rest.
- `dnc_status_cd: "found"` — the number is on the US Do Not Call registry: the engine puts it on
  do-not-contact (reason `registry`) and no call list takes it.
- Only the deployed engine can take a delivery (it needs an https `PUBLIC_URL`); a local one refuses
  the call with `no_callback_url` before anything is paid.
- Measured 2026-10-07 on Fuel Me's 280 contacts that BetterContact and FullEnrich had searched for
  phones: Apollo found 255 (91%) against their 207 (74%), for about $10 against $103.40. Where both
  had one, the number was the same for 100 of 198; nobody knows yet which is right in the other 98.

A number is a row of its own, never a fact (`facts.phone` is refused). One the engine could not
place — the person was not a contact yet — goes in by hand once the contact exists:

```sh
bh phones add <contact-id> --number +12015550100 --kind mobile --source apollo --confidence high
```

A contact keeps every number it was given, in the order found; the same number twice is counted,
not added again.

## Which LinkedIn profile is this named person — `people/match`

```sh
bh call apollo POST /people/match --contact <contact-id> --body '{
  "first_name": "Anna", "last_name": "Berg",
  "organization_name": "Acme Logistics", "domain": "acme-logistics.com",
  "reveal_personal_emails": false
}'
```

- Answer: `{ "person": { "name", "title", "linkedin_url", "email", "organization": { "name", "primary_domain" }, … } }`
  or `person: null`. One credit when a person comes back.
- Measured on 40 conference speakers: 34 profiles with a link, **0 wrong people**, 6 right person
  with no link; median 0.3 s. Apollo is silent where it cannot answer — that is why it goes first.
- A `person` with no `linkedin_url` is not a profile found (you have the person, not the key).
  Then, and only then, try Generect realtime leads (generect.md) and check the employer yourself.
- Its `email` is a candidate like bulk_match's: Bouncer first. For many people, use bulk_match.
- You can also match by `linkedin_url`. Vanity `/in/<slug>` and Sales Navigator `/sales/lead/<URN>`
  match; a URN in the `/in/` form (`/in/ACwAAA…`, starts with `AC` and 25+ more characters)
  answers empty — rewrite it to `/sales/lead/<URN>` first.
- Both match calls are guarded against repeats (same body within 30 days → 409).

## People search — free

`POST /mixed_people/api_search` costs nothing (ten searches left the balance where it was,
2026-10-07; Apollo's reference lists it at 0 credits). Send its filters **as query parameters with
`[]`** (`person_titles[]=…&q_organization_domains_list[]=acme.com&q_keywords=anna%20berg&per_page=25`):
that is how Apollo documents them, and the engine keeps the query with the call so it can be traced.
A JSON body was ignored on 2026-10-07 (the search became "anyone, anywhere") but was read on
2026-10-28 (the same CFO filters counted 31,568 with a body, 31,567 as a query), so a body may work
today and may not tomorrow — use the query string, and if you must use a body, check that
`pagination.total_entries` is not the whole database. Its rows carry an `id`,
`first_name`, `last_name_obfuscated`, `has_email` and `has_direct_phone` — **no full name, no
LinkedIn URL** — and an address placeholder `email_not_unlocked@<domain>` that must never become a
contact's email.

- `has_direct_phone: "Yes"` was right 203 times of 203 on Fuel Me; `"Maybe: …"` 1 of 7. It is never
  "No", and 51 of 70 people the search did not find by name and domain still had a number. Use it to
  size a batch before ordering, not to skip people.
- Whether a company has anyone with a title at all:

```sh
bh call apollo POST "/mixed_people/api_search?q_organization_domains_list[]=acme.com&person_titles[]=head%20of%20support&per_page=10" --strategy <id>
```

- **Keep `q_organization_domains_list[]` to about 25 domains a call.** 100 domains with 23 titles
  answered 422; 82 calls of 25 domains each completed (with retries, below).
- **A domain can match the wrong organisation**: `stg.com` answered for STG Labs, a university's
  domain for one department's record. A size or country answer from this search is a hint about the
  company, not a verdict — check the employer before judging the company on it.
- Tag every call with `--segment` or `--strategy`: a free call carries no cost, so the tag (and the
  query the engine keeps) is all that says which segment it served.

### Sourcing a firmographic segment: people search, then `bulk_match` by id

Measured on one project, 2026-10-16 (three segments): about 2–3.5¢ per Bouncer-valid address, against
about 32¢ per enrolled lead on that project's Generect company-first path.

1. `POST /mixed_people/api_search` (free) with `person_titles[]` (the persona ladder),
   `organization_industries[]=<Apollo industry name>`, `organization_locations[]=<country>`,
   `organization_num_employees_ranges[]=11,20` (one per band), `per_page=100`, `--segment <id>`.
   Record it with `bh search record` like any search.
2. `POST /people/bulk_match` with `{"details":[{"id":"<row id>"}, …]}`, 10 a call, one credit
   ($0.0065) per match: full name, `linkedin_url`, `email`, `email_status`,
   `email_domain_catchall`, and the organisation (`primary_domain`, `estimated_num_employees`,
   `industry`, `country`, `founded_year`, `linkedin_url`).
3. Judge each company against the segment (`bh companies judge` with the search as its source)
   before its person stands, then Bouncer on each address (email-finding).

Its traps, from that run:

- **The size filter leaks**: 10–15 of every 30 matches were outside the segment's band on
  `estimated_num_employees`. Re-check the size on the match and judge by it.
- **Catch-all shows before Bouncer**: 3–17 of each segment's matches had `email_domain_catchall:
  true` — do not pay Bouncer for those; they go by LinkedIn (email-finding, section B).
- Both leaks show only after the match is paid for, so match in small batches first and stop when
  the band or the catch-all share makes a segment expensive.

## Company search — one credit a page

`POST /mixed_companies/search` finds companies by firmographics and by what they hire for now. Its
filters go in the query string, like the people search: `q_organization_job_titles[]`,
`organization_job_posted_at_range[min]=<yyyy-mm-dd>`, `organization_locations[]`,
`organization_not_locations[]`, `organization_num_employees_ranges[]=51,200`,
`q_organization_domains_list[]`, `page`, `per_page` (up to 100).

```sh
bh call apollo POST "/mixed_companies/search?q_organization_job_titles[]=controller&organization_job_posted_at_range[min]=2026-10-01&organization_locations[]=United%20States&per_page=100&page=1" --segment <seg> --source <src>
# rows at organizations[] (and accounts[] for companies already saved in Apollo); pagination.total_entries
```

`GET /organizations/<organization id>/job_postings?page=1&per_page=25` lists one company's open
posts (`organization_job_postings[]`: `title`, `url`, `city`, `state`, `country`, `posted_at`,
`last_seen_at`) — the dated evidence for a hiring signal.

- **Price**: Apollo's API reference says each consumes **one credit per page** ($0.0065), whatever
  the page holds; the answers do not state it, so the engine books one credit per answered call
  under `company_search`. This was taken from Apollo's documentation, not measured on our account.
- Pages go up to 500 (50,000 records) on the company search; both are guarded against repeats.
- Use it when TheirStack (theirstack.md) has run out or for a quick hiring check; TheirStack's job
  filters are richer and its rows carry the posts.
## Limits and failures

- Treat 429 / 5xx as "try later"; bulk_match allows about 200 calls a minute.
- **The people search has two windows, per Apollo account — shared by every project**: 200 calls a
  minute and 6,000 an hour (both seen in 429 answers, 2026-11-03; the hourly one looked soft — 7,611
  calls went through in one hour). The 429 body names the window
  (`"… is 200 times per minute"`, `error_details.context.window.value`): wait about a minute on the
  minute window, several minutes on the hourly one, not seconds. Seven projects together ran 170 a
  minute once, so one session's pacing cannot keep the account under it: pace batch checks well
  below (one call every 1.2 s at most), back off on the first 429, and do not run several threads.
- **A 422 can be Apollo's own failure**, not a wrong request: "Couldn't connect to server" or
  "[401] … unable to authenticate user … for REST request [/people/_search]" came back for a request
  that answered 200 a minute later. Treat a 422 whose message is about connecting or
  authenticating inside Apollo like a 5xx: retry up to three times, 5–15 s apart. A 422 naming a
  parameter is the request's fault.
- The credits are the account's, shared with whoever else uses the key; `bh spend` shows the balance.
- Apollo's matching behaviour can change without notice — if a match suddenly answers nothing for
  obvious people, note it (`bh note add --kind insight`) and tell a person.
