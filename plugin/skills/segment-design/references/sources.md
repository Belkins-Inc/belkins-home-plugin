# Sources by kind

A source is where a segment's companies are looked for. `--query` is JSON in the source's own terms
(what you would send the provider); `--body` is the recipe a later session follows; `--estimate` is
how many companies the source holds. Run `bh providers` to see what `bh call` reaches and at what
price. How to call each provider is the `providers` skill; how to run each kind of search is in
`sourcing-linkedin`, `sourcing-trustpilot` and `sourcing-web`.

## linkedin

The default: companies described by industry, location, headcount and company type.

- Use the provider's own taxonomy values for industries and locations, exactly as it spells them —
  a label of your own finds nobody.
- Headcount as a band (`from`/`to`). Company type where it matters (privately held, public, self-employed).
- Query example: `{"industries":["Retail Apparel and Fashion"],"locations":["United States"],"headcount":{"from":50,"to":1000}}`.
- Recipe: which provider, page size, which facts to keep, how to derive the signal (LinkedIn alone
  rarely gives one — plan an enrichment: website, job posts, reviews).

## trustpilot

When the segment is defined by a company's presence or reputation on Trustpilot.

- Categories from Trustpilot's own tree, spelled as written there; countries as ISO alpha-2 in
  capitals (`US`, `GB`); a TrustScore band (1.0–5.0, one decimal); a review floor. Name at least one
  category or country — neither means every company on Trustpilot.
- Query example: `{"categories":["electronics_technology"],"countries":["US"],"ratingTo":3.5,"reviewsFrom":100}`.
- Rating, review count and category arrive with the company: put them in the signal (`rating` as a
  number, so `rating_above` exclusions apply) with the main complaint read from recent reviews.
- Trustpilot rarely gives headcount or industry: the recipe says how to look the company up on
  LinkedIn (an enrichment on the company, not another source).
- Split rating bands into separate sources when they will be judged or written to differently.

## directory

Members of an association, exhibitors or speakers of a conference, an award shortlist, a ranking.

- Propose only sites your search actually returned — a site you remember but did not find is a guess
  that costs a crawl to disprove. The site must name companies of *this* segment; a directory of the
  right kind about another market is the dearest wrong answer.
- Read list pages, not profiles: one roster naming forty companies beats forty profile pages.
  Prefer current over archived (this year's exhibitors, not 2021's). Skip pages that name nobody
  (terms, press releases, tickets, articles).
- Query: `{"site":"https://example.org","pages":["https://example.org/members"]}`; the cursor is the
  next page of a paginated list.
- Take only companies the page names; the domain is the company's own website, looked up if the page
  does not give it — never the directory's URL. The same company on two pages is one row.
- People named on the page (speakers, members) are material for contacts later; judge them on what
  their employer does.

## web

Companies only a web search surfaces: a funding round, a job post, a technology on their site, a
press mention.

- Name the sites a search may read and the ones that hold the answer (the press for funding, job
  boards for hiring). A search bounded to nothing is money spent on noise.
- A web search costs several times a page read: use it where the company's own site would not answer.
- Query: `{"q":"\"series A\" logistics software 2026","sites":["techcrunch.com","crunchbase.com"]}`.
- A segment defined by hiring (several open roles of a kind) is not a web search: TheirStack finds
  the companies and their job posts in one query (`providers` skill, theirstack reference).

## import

A list the client gave. Query: `{"file":"<name>","received":"2026-09-20","rows":412}`. Every row is
still judged; the client's list is not a verdict.

## Criteria that cost money

A criterion that needs enrichment (a fact no source returns) costs money on every company found.
Add one only where the segment is *defined* by it, and say in the recipe where the fact comes from:
the company's own site first (cheap), a web search only where the site cannot answer.
