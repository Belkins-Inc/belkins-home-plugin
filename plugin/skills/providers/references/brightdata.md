# Bright Data — Trustpilot dataset

Trustpilot reviews bought as dataset snapshots through the Filter API. Base
`https://api.brightdata.com`; key as `Authorization: Bearer …`. Dataset id
**`gd_lm5zmhwd2sni130p`** (Trustpilot business reviews).

## Money first

- **Price: $2.50 per 1,000 rows. A row is one review, not one company** — a company appears once
  per review of it the snapshot holds.
- **A snapshot is charged in full the moment it is `ready`**, downloaded or not. The snapshot API
  reports `cost: 0` on every snapshot; price it from the rows yourself.
- **Always send `records_limit`.** One unbounded sizing order (7,000 rows) plus four small ones
  emptied a $20 balance in an afternoon.
- The engine records the order and status polls as free and prices the **download** at $0.0025 per
  row, because that is where the rows arrive. The provider bills at `ready`: download every ready
  snapshot you ordered, once, or the money is spent with nothing recorded.

## 1. Order a snapshot (the order itself is free)

```sh
bh call brightdata POST /datasets/filter --segment <seg> --source <src> --body-file /tmp/bd/wave1.json
```

```json
{
  "dataset_id": "gd_lm5zmhwd2sni130p",
  "records_limit": 100,
  "filter": {
    "operator": "and",
    "filters": [
      { "name": "company_country", "operator": "in", "value": ["US", "CA"] },
      { "name": "company_overall_rating", "operator": "<=", "value": 3.5 },
      { "name": "company_total_reviews", "operator": ">=", "value": 100 },
      { "name": "review_date", "operator": ">=", "value": "2025-09-24T00:00:00.000Z" }
    ]
  }
}
```

- Answer: `{ "snapshot_id": "s_…" }`. **Record it at once** on the source
  (`bh source update <source-id> --cursor snapshot:s_…`) — a snapshot a later session forgot is money
  spent with nothing to show.
- The previous product sent `dataset_id` and `records_limit` as query parameters with a multipart
  body; if the JSON form is refused, send them in the query:
  `/datasets/filter?dataset_id=gd_lm5zmhwd2sni130p&records_limit=100` with `{"filter": …}`.
- Guarded against repeats: the same order within 30 days is refused (409).

### Filter rules (measured)

- A group holds **at most 4 entries, and a nested group counts as one of them**; groups nest at
  most **3 levels**. Five conditions → `400 Filter logical groups can have a maximum of 4 rules`.
  Pack more conditions as `and` groups inside an `and`.
- Fields that matter: `company_country` (ISO alpha-2, the country the firm **registered on
  Trustpilot**, not where its site is — `US` admitted `despegar.com.ar`), `company_overall_rating`,
  `company_total_reviews`, `review_date` (ISO timestamp; filter to the last 12 months so you do not
  pay for reviews of dead listings), `breadcrumbs`, `company_id`.
- **Categories**: `{"name": "breadcrumbs", "operator": "array_includes", "value": "Shipping & Logistics"}`
  matches a section, category or leaf anywhere in the breadcrumb. Several categories are an `or`
  group of such conditions (four per group). Category names are Trustpilot's English names, exact.
- **Walk by exclusion, not by offset**: the next wave excludes every Trustpilot company already held:
  `{"name": "company_id", "operator": "not_in", "value": ["<id>", …]}`. Measured: a second wave of
  100 rows returned 97 companies, none from the first.
- A filter that matches nothing is **accepted** and the snapshot ends `failed` with
  `warning_code: "no_records_found"` — that is an empty (or walked-out) market, not an error.
- Bounds: 120 filter calls an hour, 100 jobs at once, 5 minutes before a filter job times out.
- `bh call` sends JSON only. The API also takes uploaded CSV files for long value lists (10,000
  values a file) — not possible through `bh call`; keep inline exclusion lists to a few thousand ids.

## 2. Poll the snapshot (free)

```sh
bh call brightdata GET /datasets/snapshots/s_…
```

- `status`: `building` (wait — usually under a minute for small snapshots, up to 5 minutes), `ready`
  (with `dataset_size` = rows charged), or `failed`.
- `failed` + `warning_code: "no_records_found"` → an empty market; mark the source exhausted if the
  filter was the whole market.
- `failed` + `error: "NOT_ENOUGH_FUNDS"` / `error_code: "104"` → the balance could not cover it;
  nothing was charged; tell a person to top up. A 402 is the same.
- 404 → the vendor no longer knows the snapshot.

## 3. Download (charged: $0.0025 × rows)

```sh
bh call brightdata GET "/datasets/snapshots/s_…/download?format=json" --segment <seg> --source <src> > /tmp/bd/wave1-rows.json
```

An array of review rows. Company fields repeat on every review of that company:

| Field | Notes |
| --- | --- |
| `company_id` | Trustpilot's id — the exclusion key for the next wave; keep it in company facts |
| `company_name`, `company_website` | website filled on every row measured; normalise to a bare domain |
| `company_overall_rating`, `company_total_reviews` | the signal |
| `company_country` | registration country (see above) |
| `breadcrumbs` | `[section, category, leaf]`, sometimes `[section]` or null; the category is `breadcrumbs[1] ?? breadcrumbs[0]` |
| `company_category` | the leaf's slug, or null |
| `url` | the company's Trustpilot page; may carry `?languages=all&page=10` — strip the query |
| `review_url` | one review's page, not the company's |
| `review_date` and the review's own rating, title and text | material for the signal — read the first row to see the exact field names |

Rows of one company are contiguous; one busy listing can fill a small wave on its own (ten rows,
one company). The sample leans to large consumer brands (median 1,063 reviews) unless you set a
category or a review ceiling. Density measured: about 1.03–1.25 rows per company for a thin market
with a 12-month window.
