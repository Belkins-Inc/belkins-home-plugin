# Companies by the jobs they have open: `bh hiring`

The engine keeps its own copy of companies' public job boards on Greenhouse, Lever, Ashby and
Workable, read about twice a day. Searching it is free — try it before TheirStack (`providers`
skill, theirstack reference), which stays for what this copy lacks: Workday and other enterprise
ATSs, postings only on LinkedIn or job sites, a firmographic filter of its own.

## How much is there

```sh
bh hiring
```

Boards and open postings per ATS, how many boards have a known domain, and the oldest read. A
company missing from the copy is not proof it is not hiring.

## Companies hiring for given roles

```sh
bh hiring companies --body-file /tmp/h/q.json > /tmp/h/page0.json
```

```json
{
  "titles": ["software engineer", "backend", "full ?stack", "machine learning", "\\bai\\b"],
  "notTitles": ["sales", "account executive", "recruit", "marketing", "\\bintern\\b"],
  "postedWithinDays": 60,
  "countries": ["US"],
  "minPostings": 2,
  "employees": { "from": 100, "to": 1000 },
  "withDomain": true,
  "limit": 100,
  "offset": 0
}
```

- `titles` / `notTitles` / `departments`: regular expressions, any case; `\b` works as a word edge.
  A bare `ai` matches "Sales Manager (AI Native)": pair it with `notTitles`.
- `countries`: ISO codes; a posting counts when any of its locations is in one. Postings whose
  location names no country ("Remote", "EMEA") are left out of a search by country.
- `employees` filters only on LinkedIn data already bought for the domain; a company of unknown size
  is kept — judge it. There is no industry filter: judge industry as with any list.
- `withDomain: true` leaves out boards whose employer's domain is not known yet; without it, a row
  with `domain: null` needs its domain found from `name` before it becomes a company.
- `remote`, `ats`, `domains` (only these employers) narrow further. `total` is the whole count;
  page with `offset`.

Each row: `name`, `domain`, `ats`, `board` (the board's URL), `matching` (postings that match), `open`
(all open postings), `latest`, `linkedin` (headcount and industry when bought) and `postings` — the
three latest matches with title, URL, location and date. The titles and their dates are the signal:
put the count and two or three titles in the company's signal.

## The postings themselves

```sh
bh hiring postings --body '{"titles":["data engineer"],"domains":["acme.com"],"postedWithinDays":90}'
```

## Recording the source and the search

A hiring segment's source is kind `web` with the body as its query; record each page with
`bh search record` as provider `hiring` (no call ids: nothing was paid).

## Boards the copy lacks

A company you know hires through one of the four ATSs but is not in the copy:
`bh hiring boards --domain acme.com` to check, then add it (`{"ats":"lever","slug":"acme","domain":"acme.com"}`
a line, the slug as in its board's URL) with `bh hiring boards add --file boards.jsonl`; it is read
within minutes. Companies in our projects are looked for on the four ATSs by themselves.
