---
name: sourcing-linkedin
description: Finding companies and the people inside them from LinkedIn data (Generect, with Apollo for name lookups) — count free, page with cursors, record every search, upsert, judge against the segment. Use when a segment has (or needs) a linkedin source, or a strategy needs more contacts at qualified companies.
---

# Sourcing from LinkedIn data

Provider details (fields, filters, prices, traps) are in the `providers` skill:
[generect](../providers/references/generect.md), [apollo](../providers/references/apollo.md).
Read the `providers` SKILL.md first if you have not this session.

## Read first

```sh
bh brief                         # notes, rules, exclusions, open questions, what the last session left
bh segments; bh sources          # criteria, each source's query, cursor, found/qualified, spend
bh exclusions; bh personas
bh strategy show <strategy-id>   # its segments, persona ladder (priority order), max_per_company
bh sql "select * from strategy_segment_usage where strategy_id = '<id>'"
bh sql "select ran_at, query, cursor, results, new_records, duplicates, cost_usd, note
        from searches where source_id = '<source-id>' order by ran_at desc"
```

## Where the next contacts come from — cheapest first

Decide before spending, and write the reason in one sentence (a note or the session summary):

1. **Qualified companies nobody has looked inside yet** (`companies_left` in
   `strategy_segment_usage`) — no market is bought, only people.
2. **People off the segment** (lead walk, no company named) — only when the segment is defined by
   industry, country and size alone; the employer comes on the row but must still pass the segment.
   Cheapest measured: Apollo's free people search, then `bulk_match` by id (apollo.md, "Sourcing a
   firmographic segment") — about 2–3.5¢ per valid address against about 32¢ company first; its size
   filter leaks, so re-check the size on each match. Generect's lead walk is the other way.
3. **More companies** from the source, from its cursor.
4. Nothing left: the source is `exhausted`. Do not widen the segment yourself — propose a looser
   definition to a person (`bh question add` if the client decides, else `bh task open`), and say what
   was exhausted and what it produced.

## A. Companies

1. **Source.** One per query. Create it with the Generect body (without paging) as its query:

   ```sh
   bh source add <segment-id> --kind linkedin --provider generect \
     --name "LinkedIn: US retail, 51–500" \
     --query '{"industries":["Retail"],"locations":["United States"],"headcounts":["51-200","201-500"]}' \
     --body "Generect database index. Qualify on: sells online, own support team. Signal: what they sell, headcount."
   ```

   Translate the client's exclusions into the query (`exclude_locations`, `exclude_industries`,
   headcount bands) so you do not pay for rows the engine will refuse to qualify.

   **Default filters for every new source**, unless the segment is about one of them: a project
   aims at no more than $0.05 a verified enrolled lead (`bh spend` → `perLead`; a task opens above
   the project's limit), and most of that is company rows bought and then disqualified. So:
   - exclude what the project already holds (`exclude_domains`, generect.md) instead of paging a
     cursor that hands back paid duplicates;
   - exclude the recurring disqualifiers by industry and company type: banks and credit unions,
     investment managers and VC, government and non-profits, games studios, staffing, resellers;
   - check the employee floor on `headcount_exact` as well as the band: a company in the 11–50 band
     that lists 1–10 people is under it, and is dropped before it is judged or paid for further;
   - two people a company (`max_per_company`, 2 by default), at different personas.
2. **Count (free)** with the same body. Adjust until the number is the market you meant (a count of
   2 million is a missing filter; 0 is a misspelled value). `bh source update <id> --estimate <n>`.
3. **Page from the cursor.** `segment_sources.cursor` is the next `offset_by` (empty = 0). Start
   with `limit_by` 25, read the rows, then go wider (100–500).

   ```sh
   bh call generect POST /search/database/companies/ --segment <seg> --source <src> \
     --body '{…query…, "limit_by": 100, "offset_by": 200}' > /tmp/li/p3.json 2> /tmp/li/p3.meta
   ```
4. **Record the search** — before anything else, so the cursor moves even if the session dies:

   ```sh
   bh search record --file - <<'EOF'
   {"kind":"companies","sourceId":"<src>","provider":"generect",
    "query":{…the body you sent…},"cursor":"300","results":100,"newRecords":87,"duplicates":13,
    "callIds":["<call id from stderr>"],"note":"page 3; 13 already held from the Trustpilot source"}
   EOF
   ```

   `cursor` is the next offset to ask for; the source's cursor moves with it. Duplicates: domains
   already in `companies` (check with `bh sql` before recording).
5. **Upsert** (`bh companies upsert --file rows.jsonl`): `domain`, `name`, `country` from
   `hq_country_code` (ISO-2), `employeeCount` from `headcount_exact`, `industry`, `linkedinUrl`
   (`https://www.linkedin.com/company/<linkedin_urn>` — the lead search needs it), `timezone` when
   the HQ city makes it plain, `source: "generect"`, and `facts` as `{key: {value, source, note}}`
   (description, tagline, specialities, founded year, company type).
6. **Judge** (`bh companies judge <segment-id> --file verdicts.jsonl`), every row with `sourceId`
   and `searchId`:
   - `qualified` — passes every criterion you can check; a `reason` says why in a sentence ("DTC
     apparel brand, 120 people, US"), `evidence` the facts it rests on, and `signal` what copy can
     use (what they sell, how big).
   - `disqualified` — with a `reason` a teammate would accept: "agency, not a retailer",
     "competitor", "existing customer", "under 50 people".
   - `new` — cannot tell from the row; research it (`sourcing-web`) before qualifying.
   The engine refuses to qualify a company that breaks a client exclusion and says which; that is
   not an error to work around. The index's industry is loose (a garage labelled Software
   Development) — judge what the company does, from its description.
7. **Repeat** until the page is empty → `bh source update <id> --status exhausted`. Past 10,000 rows,
   walk by `exclude_domains` instead of the offset (generect.md).

## B. People for a strategy

1. **The ladder**: the strategy's personas in priority order, their `titles` and `excluded_titles`.
   Send the whole ladder as one `job_titles` list; include abbreviations and long forms.
2. **Which companies**: qualified companies in the strategy's segments with a LinkedIn page and no
   contacts for this strategy yet:

   ```sh
   bh sql "select c.id, c.domain, c.linkedin_url from segment_companies sc
           join companies c on c.id = sc.company_id
           join strategy_segments ss on ss.segment_id = sc.segment_id and ss.strategy_id = '<strategy>'
           where sc.status = 'qualified' and c.linkedin_url is not null
             and not exists (select 1 from strategy_companies stc
                             where stc.strategy_id = ss.strategy_id and stc.company_id = c.id
                               and (stc.status <> 'pending' or stc.excluded))" --limit 50
   ```

   `strategy_companies` is what the strategy has already worked: the engine raises a company to
   `contacts_found` and `enrolled` as its people stand, and step 6 below writes the two words only
   a search can say. `excluded` marks a company a person kept out of this strategy (`bh strategy
   exclude`). `strategy_segment_usage.companies_left` counts the same rows, so the screen and this
   query agree on what is still to do.

   A company with no LinkedIn page cannot be searched inside: find its page first — the cache by
   domain, the company's own site, then Generect realtime by name (generect.md, cheapest first) —
   or leave it.

   Another project may have bought people there already: `bh cache people <company_link>` lists
   them free (only those bought, so it never proves nobody else fits). Enough who fit the ladder →
   take them from there and skip the paid search.
3. **Search inside each company, rung by rung**, with `company_link`, `--strategy <id> --company
   <id>` (a lead count while sizing, before any strategy exists, takes `--segment <id>` instead):
   - the top rung's titles first, `limit_by` = `max_per_company`; the next rung only for the places
     still empty. One list of the whole ladder with a wide `limit_by` buys rows the cap throws away:
     one project paid for 12,700 people in October and kept 21%.
   - **Too few kept → realtime** with the same body (generect.md, "Inside one company, live"): the
     database index misses people, most at small companies. Every realtime call costs at least
     $0.007, an empty answer too, and can take minutes: skip it where the free database count
     shows many people held and none fit (the ladder is the gap, not the index).
     Check each realtime row's employer, duplicates and title before keeping it.
   - Record each search (the database one and the realtime one apart) as a contact search, with
     what was dropped and why:
     `{"kind":"contacts","strategyId":…,"companyId":…,"provider":"generect","query":…,"results":…,"newRecords":…,"callIds":[…],"dropped":{"title":5,"over_cap":2}}`.
     The reasons: `former`, `title` (outside the ladder or an excluded title), `over_cap` (past
     `max_per_company`), `other_company` (realtime answered someone else's people), `duplicate`
     (already held, or the same person twice), `location` (outside the strategy's region, or in a
     part of it a rule holds out), `invalid` (a fake or placeholder record). They are what answers
     "why was this lead not found".
4. **Keep only people who fit**: `is_current` not false; title matches a persona (whole words; the
   first rung that matches is their persona); no excluded title; within `max_per_company`, highest
   rung first. People who do not fit are not stored — the search's counts and `dropped` keep the
   record.
5. **Upsert contacts**: `linkedinUrl` (the vanity `/in/<slug>` form, no query, no trailing slash),
   `firstName` / `lastName` from `full_name`, `title`, `companyDomain`, `country` / `timezone` from
   `location` when plain, `source: "generect"`, `facts` (e.g. how long in role, which persona rung
   the title matched). No email yet — leave `email` and `emailStatus` out. Then mark each kept
   person for the strategy: `bh stand <strategy-id> --contact <id> --status candidate` (one call per
   contact); several at once with `bh stand <strategy-id> --file people.jsonl`, one
   `{"contactId","status","personaId"}` per line.

6. **Say what the search came to** — `bh worked <strategy-id> --file companies.jsonl`, one
   `{"domain","status"}` per line: `no_match` when the company was searched (realtime too) and nobody fits,
   `exhausted` when there is nobody left to find there. Both are refused for a company whose people
   already stand in this strategy, because the counts would then grow back over work being done.
   Companies with people found need no row — standing them wrote it.
7. **Addresses** next: the `email-finding` skill. A contact with a LinkedIn URL and no address can
   still go on a LinkedIn-only plan.
8. A stored contact that turns out wrong for the strategy:
   `bh stand <strategy-id> --contact <id> --status rejected --reason "<why>"` — never looked at again.

## Why a lead was not found

Someone has a person (another tool's list, a teammate's search) we did not find. Answer from data,
in this order, before buying anything:

1. **Held?** `bh sql "select … from contacts where linkedin_url …"` or by name and company — maybe
   found, then rejected (`bh stand … rejected` keeps the reason).
2. **Searched?** `bh sql "select ran_at, query, results, new_records, dropped, note from searches
   where company_id = '<id>' order by ran_at"` — never searched (no LinkedIn page, the strategy did
   not reach it), or searched and dropped: `dropped` says why (`title` → the ladder lacks the
   person's title, `over_cap` → others came first).
3. **In the index?** Free counts: `{"company_link": …}` alone, then with the ladder, then with the
   person's own title. Held and not matched → the ladder; not held → the database index lacks them,
   and realtime is the way (generect.md).

Say which of these it was; a missing title is a persona change for a person to approve
(`persona-design`), not a quiet widening of the ladder.

## Rules

- Count before paging; page small before paging wide; never re-run a page the cursor has passed.
- One source = one query. A different query is a new source (or `bh source add` with the same name
  to update its query) — otherwise the cursor means nothing.
- Every paid search is recorded with its call ids. A search not recorded is money nobody can see.
- A page paid for but lost from the scratch file: `bh call show <call-id>`, not the same call again.
- Never invent a company, a person, a domain or a title. A row without a domain is dropped.
- Company `country` is ISO-2 and drives send windows (the engine skips no holidays); a US or Canadian company's
  timezone comes from its state or city, not from the project's: write the state as
  `facts.hq_state` (code or name) and the engine sets the timezone for the US, Canada and Australia.

## Before you stop

- `bh source update` any source whose status changed; the cursor is already moved by `search record`.
- `bh note add --kind insight` for anything the next session needs (a filter that did not narrow,
  a sub-industry that produced only agencies, a better title list).
- `bh session end --summary "…"`: companies found / qualified / disqualified per source, contacts
  added per strategy, what was spent, what is left in each source, what to do next.

## Common mistakes

- Company filters without the `company_` prefix on the lead search (`locations` = where the person
  lives).
- Filtering people by `company_headcounts` on the lead index (almost empty there).
- A parent industry on leads without its children (disjoint on leads, nested on companies).
- Writing `hq_country` ("United Kingdom") as the company's country — it must be `GB`.
- Qualifying from the provider's industry label alone.
- Enrolling former employees (`is_current: false`).
- Calling a company with no row "nobody fits" before asking realtime: the database index may simply
  not hold its people.
- Keeping a realtime row without checking its employer (`linkedin_company_id`).
