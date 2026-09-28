# Brief template

`project.brief` is one markdown document: five lines on top, then six parts. Every item carries its
source in square brackets. Parts 1–4 and 6 come from the client's materials and the outreach they
ran; a section with nothing behind it says "Not in the materials." and has a client question. Part 5
is our own research and says so on every line.

## 0. In five lines (top of the brief)

- **What we sell** — the offer in the client's own terms: what a buyer actually gets, not the category.
- **Who it is for** — who buys it, as one or two sentences a person would say, not a list of filters.
- **Pain removed** — what stops hurting for that buyer once they have bought it.
- **Proof** — evidence a letter may cite: named customers, specific figures, case studies, awards,
  certifications. Only what a source names.
- **Never claim** — claims a letter must not make: guarantees, figures, customers, certifications or
  capabilities no source supports, and anything easy to overstate. One claim per line, written as
  the claim.

## 1. About the client — who they are, what the business is, what they expect from us

- **Company snapshot** — industry, size, geography, stage, the key products.
- **Business model** — how they make money: the model, the average deal, the sales cycle, the channels.
- **Goals and expectations** — why they hired us: goals, KPI, what success is, deadlines. (The
  monthly target itself is `bh goal set`, by a person.)
- **Constraints and context** — compliance, brand tone, forbidden topics, what went badly before
  (details in part 6). Each hard constraint is also a `rule` note.

## 2. Product — what we sell, at what price, how it beats the alternatives, the objections

- **What we sell** — the products and services, and what they are used for.
- **Pricing** — plans, prices (currency, period), discounts, the model.
- **Differentiators** — how it beats the alternatives and the status quo, as the client states it.
  Where part 5 shows an incumbent owns the same claim, say so here and point to it.
- **Objections** — the frequent objections and the answers that work. Objections actually heard in
  replies and calls (part 6) come first, with their source.
- **Cases** — the client, the task, the result.

## 3. Who we sell to — the target companies and people

- **Target companies** — firmographics: industries, size, geography, stack; triggers such as hiring,
  a funding round, a launch. Feeds `segment-design`.
- **Target people** — who decides, who champions, who blocks, and the job titles to search on.
  Feeds `persona-design`.
- **Qualification criteria** — the attributes a company or lead must have.
- **Anti-ICP** — who we do not touch: segments, competitors, current clients, geography. Each
  checkable item is also an exclusion or a dnc entry.

## 4. What we say — pain, offer, talking points, what to avoid, which cases to use

- **Pain and triggers** — what hurts in the segment, and which events sharpen it.
- **Offer** — the value, the call to action, the variants by segment.
- **Talking points** — the hooks, by role.
- **Avoid** — what we do not say: forbidden topics, clichés, compliance.
- **Proof to use** — which case goes under which segment or objection.

Written after part 5 is researched, so the pain and the offer are placed where the incumbents are not.

## 5. Market and competitors — researched, not extracted

Our research, not the client's materials. Every line carries `[research: <source>, <date>]`. Nothing
here is a claim about the client, and nothing here moves into parts 0–3 as one.

- **The market** — its size and direction, with the figure and who published it.
- **Incumbents** — the two or three the buyer already pays for this job (not the rivals the client
  names by habit), what each sells and to whom.
- **What they claim** — each incumbent's lead claim, in its own words.
- **Ground we do not fight on** — what an incumbent owns and the client cannot claim or match; copy
  stays off it. The matching "never claim" lines go in part 0 and in `rule` notes.
- **How the client is classified** — how market databases, directories, review sites and LinkedIn's
  industry list the client, and which neighbours that puts them next to. A misleading neighbour is
  the reader's first objection; answer it in part 4.

## 6. Previous outreach — what was tried and what it did

From the client's own campaigns, an earlier agency's project or their SDRs' notes, marked
`[outreach: <campaign or export>, <dates>]`. The checklist is in
[materials.md](materials.md#previous-outreach).

- **What ran** — campaigns, channels, dates, status (running, paused, stopped and why).
- **Results by channel** — sends, replies and meetings per channel, as rates with their base (one
  client's: email replies at 0.13% of sends, LinkedIn at 20% of the people who accepted).
- **What replies said** — the objections and the interest, quoted, with how many said each.
- **Meetings** — every meeting it produced, with the channel, the persona and the message it came from.
- **Audiences and lists** — which lists were worked, where they came from, how many people; the
  address-status mix (valid, catch-all, bounced).
- **Sending identity** — who signed, from which domains and mailboxes, with what signature.
- **What it means for us** — the channel the evidence favours, the objection to answer first, the
  audiences to reuse or avoid. Feeds `segment-design` (rates for the arithmetic) and
  `strategy-and-plans` (channels).
- **Not obtained** — what was asked for and not received, with the question id.

## Source markers

Name the source concretely enough to find it again: `[call 2026-09-12]`, `[deck p.7]`, `[site
/pricing]`, `[agreement]`, `[email from Jane 2026-09-20]`, `[research: g2.com category page,
2026-09-24]`, `[outreach: 2025 LinkedIn campaign export]`. On an internal project (one of our own
companies) its owner is the client, and what they say in a session is material: `[owner
2026-09-25]`. When sources conflict on something acted on differently:

> Price per seat: $49/month [site /pricing] vs $39/month for annual [call 2026-09-12] — asked (question <id>).
