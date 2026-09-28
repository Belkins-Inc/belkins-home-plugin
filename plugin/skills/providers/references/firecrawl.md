# Firecrawl

Reads web pages through a real browser and returns markdown; lists a site's pages. Base
`https://api.firecrawl.dev/v2`; key as `Authorization: Bearer …`.

Price: one credit per call, $0.0009 ($90 for 100,000 credits) — for both scrape and map, whatever
the map's `limit`. Cheap per call, but **neither endpoint guards repeats**: the
same page fetched twice is paid twice. Check `provider_calls` before re-reading a page.

Why a vendor and not a plain fetch: a modern page's HTML is not its content — a speakers page was
302 KB of markup and 2,413 characters of navigation text; Firecrawl returned 7,882 characters with
all twenty people.

## Scrape one page

```sh
bh call firecrawl POST /scrape --company <company-id> --body '{
  "url": "https://acme.com/about",
  "formats": ["markdown"],
  "onlyMainContent": true
}' > /tmp/fc/acme-about.json
jq -r '.data.markdown' /tmp/fc/acme-about.json
```

- Success: `{ "success": true, "data": { "markdown": "…", "metadata": { "title", "statusCode", … } } }`.
- Keep `onlyMainContent: true` (drops nav and footers). Past ~120,000 characters is boilerplate.
- Do not send scroll `actions`: eight scrolls returned byte-identical output and took ten times as
  long on the pages tested. Use actions only for a page proven to need them.

## Map a site (list its pages)

```sh
bh call firecrawl POST /map --company <company-id> --body '{
  "url": "https://acme.com",
  "limit": 300,
  "includeSubdomains": false,
  "ignoreQueryParameters": true
}'
```

- Answer: `{ "success": true, "links": [ { "url", "title", "description" }, … ] }`.
- `includeSubdomains: false` — the default is true, and `docs.`, `status.`, `careers.` subdomains are
  rarely about what the company sells.
- The limit bounds what you read back, not what you pay. The pages worth reading are rarely at the
  end of a long list, and the vendor's order is not relevance (a conference's current speakers sat
  at positions 204–226 of 362). Choose from titles and descriptions, not from position.

## Whose failure is it

| Answer | Meaning | Do |
| --- | --- | --- |
| 200 with `success: false`, e.g. `SCRAPE_DNS_RESOLUTION_ERROR` | the site does not resolve | record it on the company (`facts.website`), move on |
| 500 with `code` starting `SCRAPE_` (`SCRAPE_SITE_ERROR`, `SCRAPE_SSL_ERROR`) | **the site** will not load; Firecrawl is fine | same — it is the page's failure, not an outage |
| 500 without such a code, 402, 408, 429 | Firecrawl's quota, clock or outage | wait and retry |
| 401 / 403 | the engine's key | tell a person |

A private or local IP address is never worth a call. Trustpilot's category pages answer 403 to
Firecrawl — Trustpilot data comes from Bright Data.
