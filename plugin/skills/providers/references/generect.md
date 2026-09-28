# Generect

LinkedIn-sourced companies and people. Base `https://api.generect.com/api/v1` (auth added by the
engine). Every answer is `{ "data": { … }, "meta": { "amount_charged": <usd> } }`; the engine
prices the call from `meta.amount_charged` when present. Keep the trailing slash on every path.

Two indexes:

- **database** — the stored index. Counts are free, rows $0.0045. Use it for everything it can answer.
- **realtime** — live LinkedIn. Counts $0.007, rows $0.007. Only for what database refuses
  (keywords, names).

## Companies

### Count (free)

```sh
bh call generect POST /search/database/companies/count/ --segment <seg> --source <src> --body '{
  "industries": ["Retail", "Consumer Services"],
  "locations": ["United States"],
  "headcounts": ["51-200", "201-500"],
  "company_types": ["Privately Held"]
}'
# → {"data":{"results_count":12345},"meta":{"amount_charged":0.0}}
```

### Page ($0.0045 per row)

```sh
bh call generect POST /search/database/companies/ --segment <seg> --source <src> --body '{
  "industries": ["Retail"], "locations": ["United States"], "headcounts": ["51-200"],
  "limit_by": 25, "offset_by": 0
}'
# rows at data.companies[]
```

Filters (database):

| Field | Values / notes |
| --- | --- |
| `industries`, `exclude_industries` | LinkedIn industry names. A parent **includes its sub-industries** by default |
| `sub_industries` | `true` = take the named industries exactly, **without** their children (narrows a branch: Financial Services UK 40,229 → 24,532) |
| `locations`, `exclude_locations` | country names as LinkedIn writes them: `"United Kingdom"`, `"United States"` |
| `headcounts` | exactly: `1-10`, `11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001-10000`, `10 000+` (note the space) |
| `company_types` | case-sensitive, exactly: `Privately Held`, `Public Company`, `Partnership`, `Self Employed`, `Self Owned`, `Non Profit`, `Educational`, `Government Agency` |
| `exclude_domains`, `exclude_names`, `exclude_ids` | applied whole (50,000 values accepted), case-folded; the count applies them too |
| `limit_by` 1–10,000, `offset_by` 0–9,999 | the walk stops at 10,000 rows per filter |

**Industry names** are LinkedIn's (its industry taxonomy V2), spelled exactly: a wrong one answers
`400 "Object with name=<value> does not exist."` — free on the count endpoint, so try names there
first. There is no "E-commerce" industry: e-commerce brands sit under `Retail` (with children such
as `Retail Apparel and Fashion`, `Online and Mail Order Retail`) and under consumer manufacturing
(`Manufacturing` children like `Personal Care Product Manufacturing`, `Food and Beverage
Manufacturing`) depending on what they sell. The row's `industry` field on companies you already
found shows the names in use. Keep the names that worked for a segment in its source's `query`,
so the next session does not rediscover them.

**Some markets have no industry.** LinkedIn's taxonomy has no data centre industry. The nearest
branch, `Data Infrastructure and Analytics`, is analytics SaaS, crypto projects and consultancies:
one page of 25 rows ($0.11) held no company that operates a facility. `Hosting and Cloud` is not an
industry name (400). When the free count and one cheap page show the industry is not the market,
stop paging: take the company list from a directory, an association or a conference
(`segment-design`, `directory` sources), or reach the people through self-qualifying titles off the
segment (`persona-design`).

Gotchas:

- **At least one real filter.** `{}` or only empty lists → `400 at least one search filter is
  required`; `exclude_domains` alone is not a filter. On realtime the same body answers 0 and
  **charges** $0.007.
- `keywords` is refused on database (`Use realtime endpoint`). An unknown field is refused by name,
  often with "Did you mean …" — read it.
- Order is deterministic, pages do not overlap, a page past the end is empty and free: **an empty
  page is the end of the selection.**
- **Past 10,000 rows**, walk by exclusion: send the domains you already hold in `exclude_domains`
  with `offset_by: 0` — it returns exactly the rows a plain offset would, and more.
- Realtime exclusions are applied after the page is cut (an empty page that is not the end) — never
  walk realtime by exclusion.
- **`headcounts` narrows the count, not the rows.** `Data Infrastructure and Analytics`, United
  States, 201 and up: the count fell from 5,053 to 99, and the rows that came back carried
  `headcount_exact` from 1 to 6. The size on this index cannot be trusted either way: do not qualify
  or reject a company on the band or on `headcount_exact` from these rows. Take the size from the
  company's own LinkedIn page or site when a rule depends on it.

Company row (34 fields). What to keep:

| Row field | Where it goes |
| --- | --- |
| `domain` | `domain` (the key; drop rows without one) |
| `name` | `name` |
| `hq_country_code` | `country` (ISO alpha-2; `hq_country` is a name and is refused by `bh companies upsert`) |
| `headcount_exact` (else `headcount_range`) | `employeeCount` (a number) — unreliable on this index (gotchas); never the only evidence for a size rule |
| `industry` | `industry` |
| `linkedin_urn` / `linkedin_link` | `linkedinUrl` = `https://www.linkedin.com/company/<linkedin_urn>` — needed for the lead search |
| `hq_city`, `hq_state` | `timezone` (IANA, when the city makes it plain) |
| `description`, `tagline`, `specialities`, `founded_year`, `company_type`, `location` | `facts` |

Strip NUL characters (`\u0000`) from text before writing — Postgres refuses them.

### A company's page from its name (realtime, $0.007 per row)

```sh
bh call generect POST /search/realtime/companies/ --company <id> --body '{
  "keywords": ["Extra Space Storage"], "limit_by": 1, "offset_by": 0
}'
```

Domains cannot be searched (`domains` is refused on both indexes). The answer approximates rather
than misses: accept the row only if its `domain` equals the one you have, or the registrable label
matches **and** the names are one firm (`tully.app` for `tully.co.uk` was another business). Measured
on 20 Trustpilot firms: 7 exact, 2 of 3 label matches right, 3 wrong firms, 5 nothing (not billed).
A company with no reliable page is recorded as such — do not look for people at a guessed firm.

## People (leads)

### Count (free)

```sh
bh call generect POST /search/database/leads/count/ --strategy <strategy> --body '{
  "job_titles": ["Head of Customer Support", "VP Customer Experience", "Director of Support"],
  "company_locations": ["United States"], "company_industries": ["Retail", "Retail Apparel and Fashion"]
}'
```

A wide branch with a common title takes 20–50 s to count — wait for it.

### Inside one company ($0.0045 per row)

```sh
bh call generect POST /search/database/leads/ --strategy <strategy> --company <company-id> --body '{
  "company_link": "https://www.linkedin.com/company/acme-inc",
  "job_titles": ["Head of Support", "Customer Support Manager", "VP Customer Experience"],
  "limit_by": 10, "offset_by": 0
}'
# rows at data.leads[]
```

### Off the segment, no company named (same price; the employer comes on the row)

**One job title per call.** With no company named the index is searched whole, and the width of
`job_titles` decides whether it answers: seven titles answered 502 `provider_unreachable`, four
titles with `limit_by: 5` answered 502, one title with `limit_by: 25` answered 200 (measured
2026-09-24). Page each title separately, merge the rows yourself by `linkedin_url`, and expect to
pay for the people two titles share. The count endpoint takes the whole list; only the rows do not.

```sh
bh call generect POST /search/database/leads/ --strategy <strategy> --body '{
  "job_titles": ["Head of Customer Support"], "company_locations": ["United Kingdom"],
  "company_industries": ["Software Development", "IT Services and IT Consulting"],
  "limit_by": 25, "offset_by": 0
}'
```

Lead filters and traps:

- **The company is named by its LinkedIn page only** — `company_link` or `company_id`.
  `company_domain`, `company_website`, `domains` are refused. A company with no LinkedIn page
  cannot be searched inside.
- **Company filters carry a `company_` prefix**: `company_locations`, `company_industries`,
  `exclude_company_industries`, `exclude_company_locations`. **`locations` / `exclude_locations`
  are accepted and mean where the person lives** — a body copied from the company search silently
  filters the wrong thing.
- **Industries are not expanded on leads**: a parent and its children are disjoint sets. List the
  children explicitly (Financial Services alone found half the CEOs the whole branch did).
- `company_headcounts` and `company_types` are accepted but almost empty on the database lead index
  (all eight bands together: 16 of 111,143). Do not filter people by size there — filter the
  companies, then search inside them.
- `job_titles`: for a count, and for rows inside a named company, send the whole persona ladder as
  **one list in one call** (the answer is the de-duplicated union; summing per-title counts double
  counts). 154 per-company searches with 39 titles each all answered: `company_link` narrows the
  index first. Rows off the segment are the exception — one title per call (above). Small words
  (`of`, `and`, `for`, `the`, `to`, `in`, `at`, `with`, `on`, `a`, `by`, `or`) and word order are
  ignored. Abbreviations are inconsistent (`CFO` ⊃ `Chief Financial Officer`, `CRO` only overlaps
  `Chief Risk Officer`) — list both forms.
- `offset_by` < 2,400 and `limit_by` ≤ 2,400; no exclusion of any kind on leads, and name filters
  are refused on database.
- `is_current` cannot be filtered; it comes **on the row**. Drop rows with `is_current: false` or
  `company_still_working: false` — they are former employees (still charged).

Lead row: `full_name`, `job_title` (`raw_job_title`), `linkedin_url` (vanity `/in/<slug>` — use
this), `sales_id` (the URN), `linkedin_sales_link` (search context with commas — never store it),
`company_url` (`https://www.linkedin.com/company/<slug>/`), `company_website`, `company_name`,
`linkedin_company_id`, `company_industry`, `location`, `is_current`, `company_still_working`.
**No email** (`email_candidates` is a count, `contact_info` is empty) and no seniority or department.
The index's company data is loose (a garage labelled Software Development) — the employer still has
to pass the segment.

### A named person (realtime only, $0.007 per row)

Use only when Apollo `people/match` found no profile (see apollo.md):

```sh
bh call generect POST /search/realtime/leads/ --contact <id> --body '{
  "first_name": ["Anna"], "last_name": ["Berg"], "company_names": ["Acme"], "limit_by": 3, "offset_by": 0
}'
```

Name fields are lists (a string is refused). `company_names` barely narrows: 5 of 40 answers were
namesakes at other firms. Take the first row whose `lead_company_name` is the same firm, and its
`sales_id`; the vanity URL is not on these rows.

## Enrich by LinkedIn URL ($0.0045)

```sh
bh call generect POST /enrich/database/lead/ --contact <id> --body '{"linkedin_url":"https://www.linkedin.com/in/erikbern"}'
bh call generect POST /enrich/database/company/ --company <id> --body '{"linkedin_url":"https://www.linkedin.com/company/acme-inc"}'
```

A lead enrich takes either form (`/in/<slug>` or `/sales/lead/<URN>`) and answers both
(`linkedin_url`, `sales_id`, `linkedin_id`). A company enrich adds nothing a search row lacks — buy
it only for a company no search found (e.g. one imported by domain). The database enrich can refuse
a firm the search returned (`400 Company does not exist`).

## Errors

- `Bad url`, `Person does not exist`, `Company does not exist`, `No such company` — ordinary "no
  result", not failures.
- `429` or a `detail` containing "Try again later" — wait a minute and retry (up to three times).
- One over-long title in `job_titles` fails the whole request — keep titles short.
