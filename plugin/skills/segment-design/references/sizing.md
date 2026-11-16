# Sizing: from the goal to companies

A segment is sized against the goal, not on its own. The arithmetic runs backwards from the meetings
a month needs to the companies we have to find, then forwards from what the free counts say is
there. Both lines go into the proposal (step 7), and the gap between them is the first thing a
person reads.

## The chain

| Step | Divide by | Where the rate comes from |
| --- | --- | --- |
| Meetings a month | — | `bh brief` → `goal.target`, and whether it `counts` qualified or held meetings |
| → leads needed | meetings per lead contacted | this project's history; else the client's previous outreach; else an assumption |
| → people needed | share of people found with a usable address or LinkedIn | this project's email finding; else the provider's usual find rate, said to be one |
| → qualified companies needed | people per company | the free people count ÷ the company count, capped by `maxPerCompany` and the persona caps |
| → companies to find | share of found companies that qualify | this segment's `qualified_pct`; else a sample judged from free reads, or an assumption |

Rules for the rates:

- **Name the source of every rate** in brackets, as the brief does: `[history: strategy_segment_usage,
  4 strategies]`, `[outreach: 2025 campaign, 1 meeting of ~800 leads]`, `[assumption]`. A rate with no
  source is an assumption, and the proposal says so.
- **History first.** Meetings per lead is `meetings ÷ enrolled` from `strategy_segment_usage`;
  qualified share is `qualified_pct` from `segment_usage` (recipes in
  `project-orientation/references/sql-recipes.md`). Use the kind of meeting the goal counts: held
  meetings are fewer than booked ones.
- **Then the client's previous outreach** (brief part 6). Even one meeting from a known number of
  leads is a rate; say how thin it is.
- **An assumption is written once**, as a `decision` note with `--segment`, so the next session
  compares the result with it instead of assuming again.
- **Time.** Leads contacted in a month produce meetings over the plan's length (two to three weeks
  of steps) plus the days it takes to book. A month's goal needs its leads first touched in the
  weeks before it, and the senders have to carry them in that time — the capacity check is in
  `strategy-and-plans` ("Capacity").

## Available by free counts

- **Companies** — the count endpoint's total, or the total a directory prints on its first screen.
  Never a round guess where a source printed its number.
- **People** — the free leads count for the persona titles with the same company filters. Titles
  that name the market can be counted straight off the segment; titles that exist in any company
  can only be counted company first (`persona-design`).
- **Leads available** = qualified companies available × people per company × the address share.
  Divided by the leads needed per month, it is how many months the segment carries the goal.

## Worked example (illustrative figures)

```
Goal: 10 held meetings in 2026-10
Leads needed per month: 1,000      (10 ÷ 1 meeting per 100 leads [assumption: no history; the
                                    client's own outreach gave 1 meeting, too few for a rate])
People needed: 1,140               (÷ 0.88 with an address [measured: 113 of 128 in the first batch])
Qualified companies needed: 570    (÷ 2 people per company [maxPerCompany; the count shows ~3])
Available by free counts: 2,244 companies [directory total], 60% qualify [assumption]
  → 1,350 qualified × 2 people × 0.88 → 2,370 leads
Gap: +1,370 in the first month; at 1,000 a month the segment carries the goal for about 2 months
```

When the gap is negative, the proposal opens with it:

> This segment cannot carry the goal: about 400 leads a month against 1,000 needed. Options below
> add a second segment or lower the October target.

## First-batch cost

Rows × the price in `bh providers` for each paid step the batch will take: company pages, people
per company, address finding, verification. Where a provider's price is unknown (`cost unknown` in
`provider_calls`), say so and give the units instead of inventing a dollar figure.
