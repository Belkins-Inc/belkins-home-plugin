---
name: sourcing-trustpilot
description: Finding companies through their Trustpilot reviews, bought as Bright Data dataset snapshots — filter design with a records_limit, polling, download cost, and turning reviews into a signal (rating, review count, top complaint) on the segment company. Use when a segment is defined by review sentiment or has a trustpilot source.
---

# Sourcing from Trustpilot

The provider mechanics — endpoints, filter limits, row fields, failure codes — are in
[brightdata](../providers/references/brightdata.md). Read it before the first order.

Why Trustpilot: a company's own customers describing a problem is the strongest reason to write to
it, and the review text is copy material nobody else has. The row is a **review**, so what you buy
is reviews; companies come out of them.

## Read first

```sh
bh brief; bh segments; bh sources; bh exclusions      # rating_above exclusions matter here
bh sql "select ran_at, query, cursor, results, new_records, cost_usd, note
        from searches where source_id = '<source-id>' order by ran_at desc"
bh sql "select at, endpoint, params->'body' as body, status_code, results, cost_usd
        from provider_calls where provider = 'brightdata' and source_id = '<source-id>' order by at desc"
```

**If the source's cursor holds `snapshot:<id>`**, a snapshot was ordered and may never have been
downloaded. It is already paid for: poll it and download it before ordering anything new.

## Procedure

1. **Source.** `bh source add <segment-id> --kind trustpilot --provider brightdata --name
   "Trustpilot: Electronics, US, ≤ 3.5, 100+ reviews" --query '<the filter, without records_limit>'
   --body "<recipe: what makes a qualified company, what signal to keep>"`.
2. **Design the filter** (four entries per group, three levels deep at most):
   - country (`company_country in […]`) — Trustpilot registration country, not HQ;
   - rating band (`company_overall_rating <=` / `>=`) — respect a `rating_above` exclusion;
   - a review floor (`company_total_reviews >= 50–100`) so a rating means something, and a ceiling
     when the segment is small firms — otherwise the snapshot fills with UberEats and AliExpress;
   - categories (`breadcrumbs array_includes "<name>"`, several as an `or` group);
   - `review_date >=` twelve months ago — older reviews are money spent on listings nobody writes
     about;
   - from the second wave: `company_id not_in [ids already held]`
     (`bh sql "select facts->'trustpilot_id'->>'value' from companies where project_id = @project and facts ? 'trustpilot_id'"`).
3. **Size the wave.** `records_limit` = companies wanted × 1.25 for a thin market, up to × 5 when
   one busy listing may fill the wave (rows of one company are contiguous). **Never order without
   `records_limit`**, and start with 50–100 rows ($0.13–$0.25) until the density is known.
   Before a wave over 1,000 rows ($2.50+), check `bh spend` and say what it will cost.
4. **Order**, then immediately `bh source update <src> --cursor snapshot:<snapshot_id>`.
5. **Poll** `GET /datasets/snapshots/<id>` until `ready` (usually a minute; allow five). `failed`
   with `no_records_found` = nothing left in this market; `NOT_ENOUGH_FUNDS` = tell a person.
6. **Download** once, with `--segment` and `--source`, to a scratch file. The call id on stderr is
   the one that carries the cost; if the file is lost, `bh call show <call-id>` prints the rows again
   (answers up to 1 MB are kept) instead of a second download.
7. **Record the search**: `{"kind":"companies","sourceId":…,"provider":"brightdata","query":{the
   filter and records_limit},"cursor":"","results":<rows>,"newRecords":<new companies>,
   "duplicates":<companies already held>,"callIds":[order id, download id],"note":"wave 2: 100 rows,
   97 companies, 1.03 rows each"}` — an empty cursor clears the snapshot handle.
8. **Group rows by `company_id`** and build one company each (below). Drop rows with no
   `company_id` or no website.
9. **Upsert** companies: `domain` from `company_website` (bare, no `www.`), `name`, `country` only
   when the site plainly is in that country (the Trustpilot country is registration, not HQ),
   `source: "trustpilot"`, and `facts`:
   `{"trustpilot_id": {"value": "<company_id>", "source": "brightdata"}, "trustpilot_url": {"value":
   "https://www.trustpilot.com/review/acme.com", "source": "brightdata"}, "trustpilot_category":
   {"value": "Electronics & Technology › Mobile Phone Store", "source": "brightdata"}}`.
10. **Judge** with the signal (below). Qualify only what fits the segment's other criteria; a
    Trustpilot find usually still needs size and business model — enrich it (step 11) or leave it
    `new` with the signal saved.
11. **Enrich**: give each kept company its LinkedIn page (Generect realtime by name — accept only an
    exact domain, or the same label and the same firm; see generect.md), then headcount and industry
    from the Generect row. A company with no reliable page is still a company; it just cannot be
    searched inside for people.

## The signal — the point of this source

Put it on `segment_companies.signal` through `bh companies judge`, `rating` as a number (the
engine's `rating_above` check reads it):

```json
{"domain": "acme.com", "status": "qualified", "sourceId": "…", "searchId": "…",
 "reason": "rated 2.8 across 340 reviews; slow support replies in 11 of 19 recent ones",
 "evidence": [{"fact": "rating", "value": 2.8, "url": "https://www.trustpilot.com/review/acme.com", "seenAt": "2026-09-24"}],
 "signal": {
   "rating": 2.8, "reviews": 340, "category": "Mobile Phone Store",
   "top_complaint": "slow replies to support tickets — 11 of 19 recent reviews",
   "complaints": ["no reply for two weeks", "refund took a month"],
   "quote": "Emailed support four times, no answer in 12 days.",
   "recent_reviews_read": 19, "period": "2025-10..2026-09",
   "trustpilot_url": "https://www.trustpilot.com/review/acme.com"}}
```

- Read the review texts in the rows you bought, not just the rating. Name the **top complaint** in
  the customer's words with how many of the reviews read say it; keep one short verbatim quote.
- The complaint must connect to what the client sells. A 2.1 rating about delivery is no signal for
  a support-outsourcing client; disqualify with that reason or keep it `new`.
- Too few recent reviews (under ~5 in the window) is thin evidence — say so in the signal.
- Never invent a complaint or a quote. If the snapshot held no review text for a company, the
  signal is only the rating and count.

## Before you stop

- The source's cursor must not hold a snapshot you have already downloaded (recording the search
  with `cursor: ""` clears it) — and must hold one you have not.
- `bh note add --kind insight` for densities (rows per company), categories that produced good or
  bad companies, and misleading country codes.
- `bh session end --summary`: waves ordered, rows and dollars, companies new / qualified, what the
  next wave should exclude or change.

## Common mistakes

- An order without `records_limit`.
- Ordering a new wave while a ready snapshot sits undownloaded.
- Counting rows as companies (100 rows ≈ 86 companies in one measured wave).
- Taking `company_country` as HQ, or `review_url` as the company's page.
