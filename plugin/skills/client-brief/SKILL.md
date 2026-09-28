---
name: client-brief
description: Turns a client's materials — website, discovery-call notes or transcript, deck, price list, cases, ICP and exclusion lists, and the outreach they already ran — plus our own research on their market and competitors into the project's brief and its checkable memory (rules, decisions, exclusions, client questions). Use when a project is new or its brief is empty or thin, when new client material or call notes arrive, and when the client changes what they want.
---

# Client brief

The brief is what every later session writes segments, personas and copy from. It holds two kinds
of statement and never mixes them. What it says **about the client** — who they are, what they sell,
who they sell to — comes only from the client's materials, and everything the materials leave open
becomes a question to the client, not a guess. What it says **about the market** — its size, the
incumbents the buyer already pays, what they claim, how third parties see the client — is our own
research, sourced as research and kept in its own section.

The brief is the first thing a person approves before any money is spent (`segment-design`,
"Propose, then stop"). Analysis is free; collecting waits for that approval.

## Read first

- `bh brief` — the current `project.brief`, rules, decisions, exclusions, open questions. You are
  usually revising, not starting over.
- `bh note list --kind client_feedback` and `bh questions --status all` — what the client already
  said and what was already asked, so nothing is asked twice.
- The materials the person gives you (files, pasted notes, links). The client's own website, and the
  market around it, you read with your own web tools; a paid scraper or search goes through
  `bh call` (check `bh providers` and earlier `provider_calls` first) and waits for the approval.
- **The outreach the client already ran**, before anything else you write: it is the only record of
  what this market answers. What to ask for and how to read it:
  [references/materials.md](references/materials.md#previous-outreach).

## Procedure

1. **Inventory the materials.** Label each by what it is: website, discovery call, agreement, sales
   deck, price list, cases, competitors, sales call, ICP list, won/lost export, exclusion list,
   previous outreach. Judge what a document *is*, not what it mentions (a deck quoting a price is a
   deck). Missing ones are questions — see [references/materials.md](references/materials.md) for
   what each feeds. The discovery call is the one the brief cannot be written without; previous
   outreach is the one most often not asked for.
2. **Read the previous outreach first.** Ask for it before writing anything: the client's own
   campaigns, an earlier agency's project, a sending tool they can export from or give read access
   to, call notes from their SDRs. Work through the checklist in
   [references/materials.md](references/materials.md#previous-outreach): campaigns and their status,
   sends and replies per channel, every reply read in full, call dispositions, where the lists came
   from, address statuses. What it teaches goes into section 6 of the brief — the objections
   actually heard, the channel that answered, the sending identity, the audiences already worked, the
   meetings it produced and where from. Whatever could not be obtained is said plainly in that
   section ("No export of the 2025 campaign: asked, question <id>"), never skipped. The people it
   already reached are a dedupe list: `bh dnc add --kind email --reason
   unsubscribed|complaint|bounced` for everyone who opted out, complained or bounced, and a
   `decision` note on when the rest may be written to again.
3. **Extract, do not summarise.** Carry names, prices (with currency and period), customers, figures,
   titles, geographies and the exact sentence an offer or guarantee is made in, verbatim. Drop
   navigation, slogans, the third restatement of a value proposition. Read the pages the client
   wrote for **suppliers, partners and investors**, not only the ones for buyers: the business model
   is usually stated plainly there and nowhere else (one client's strongest line, "we never mark up fuel
   cost", was on a page for vendors).
4. **Research the market and the incumbents** with your own tools before writing section 4 (What we
   say). Section 5 of the template: the market's size and direction; the two or three incumbents
   the buyer already pays; what each claims, and which ground they own so we do not fight on it; and
   how third parties (market databases, directories, review sites, LinkedIn's industry) classify the
   client, because that classification is the first objection a cold reader has. Find the
   incumbents yourself — do not copy the client's own framing of its competition, which names the
   rivals they worry about rather than the ones the buyer is paying. Every item carries a research
   marker with its source and date (`[research: mansfield.energy /services, 2026-09-24]`).
5. **Write the brief** in the structure of [references/brief-template.md](references/brief-template.md):
   In five lines, About the client, Product, Who we sell to, What we say, Market and competitors,
   Previous outreach. Every statement carries its source in brackets — `[call 2026-09-12]`,
   `[deck]`, `[site]`, `[pricing page]`, `[research: …]`, `[outreach: …]`. A sentence with no source
   is one nobody can check; do not write it.
6. **Empty is an answer.** Where a section about the client has nothing behind it, write "Not in the
   materials." and add a client question. Never fill sections 1–3 from general knowledge of the
   industry or from the market research: a claim about the client never comes from research. What
   research says about the client ("listed next to fleet-fuelling apps") is written in section 5 as
   what a third party says, not as a fact about them.
7. **Conflicts are questions.** Where two sources disagree on something a person would act on
   differently (a price, a segment, a market, a number, a date), write both readings with their
   sources and `bh question add` it. A difference of wording, rounding or detail is not a conflict:
   take the fuller reading and write it once.
8. **Save the brief.** Write it to a file, then `bh project update --brief-file <path>` (or
   `--brief "<text>"`). It replaces the whole brief, so the file holds all of it, not the changes.
   A person's token only — an interactive session has one; a scheduled agent opens a task
   (`bh task open --title "Set the project brief" … --done-when "bh brief shows the new
   project.brief"`) with the brief in `--body`.
9. **Saving is not approval.** On a new project, or when the brief changes who we sell to or what we
   say, a person reads it before anything is collected. It is part one of the proposal in
   `segment-design` ("Propose, then stop"): the brief, the titles with free counts, the segment and
   the numbers. Put in front of the person what the materials could not answer and which questions
   are open, not only the text. No paid call is made on a brief nobody has approved.
10. **Turn the checkable parts into data**, so tools enforce them instead of people remembering:
   - Anti-ICP that a tool can test → `bh exclusion add --kind <k> --value <v> --note "<client's
     words, source>"`. Kinds: `country` (a country to leave out, ISO alpha-2, e.g. `DE`), `country_outside` (the
     countries allowed, comma-separated — "US only" is `--kind country_outside --value US`; a company
     known to be elsewhere breaks it), `industry` (matched as a substring
     of the company's industry), `business_model` (matched exactly against `facts.business_model` — pick one spelling, e.g.
     `amazon_only`, and write it down in a `rule` note so everyone stores the fact the same way),
     `employees_below` / `employees_above` (a number), `rating_above` (e.g. `4.0`), `other` (prose;
     never checked by the tool — only use when nothing else fits). The response lists qualified
     companies that now break it: re-judge them (`segment-design`).
   - Current customers, competitors, partners by domain or email → `bh dnc add --kind domain|email
     --value <v> --reason existing_customer|competitor|client_request [--note …]`. A customer list
     not received yet is a client question — launching without it was a real failure.
   - Constraints on how we write or send (forbidden topics, tone, compliance, "never claim X") →
     `bh note add --kind rule --title "<the rule>" --body "<source>"`.
   - Choices made with the client or the team (markets in or out, priorities, offer) →
     `bh note add --kind decision`.
   - What the client said about our work → `bh note add --kind client_feedback`, verbatim, with date.
11. **Goal.** The monthly meeting target and what counts (qualified or held) comes from the agreement
   or the client. Setting it is a person's action (`bh goal set <YYYY-MM> --target <n> [--counts
   qualified|held]`); if you are not a person or it is not agreed, open a task or a question.
12. **Questions.** Every gap and conflict: `bh question add --body "<one question the client can
   answer>" --note "<what depends on it>"`. One question per row; group them in the task that asks
   a person to send them.
13. `bh session end` per `project-orientation`.

## Quality bar

- About the client, only what the materials support. Never invent a customer, figure,
  certification, case or result.
- About the market, only what a source you can name says, marked as research. Research informs what
  we do not claim and where we do not fight; it never becomes a claim about the client.
- Proof is what a source *names* (a customer, a figure, a case); "industry-leading" is not proof.
- "Never claim" is read off what the materials conspicuously do not support: guarantees, figures,
  customers, certifications or capabilities nobody stated, and anything easy to overstate. Each is a
  `rule` note too, so copy checks it.
- Plain markdown, short paragraphs and lists, no marketing adjectives, no preamble.
- Target companies and target people are described so a segment and a persona can be built from
  them (industries, size, geography, triggers; decision makers, champions, blockers, titles to search
  on) — but segments and personas themselves are made with `segment-design` and `persona-design`.
- When revising, change what the new material changes and keep the rest with its sources.

## Rights

A scheduled agent may add notes, questions, exclusions and tasks. It may not set the brief (person
token), set goals, or remove dnc — open a task.

## Common mistakes

- Writing a plausible ICP from the industry instead of from the call.
- A brief with no market section, so copy walks into the incumbents' ground and the reader's first
  objection ("aren't you one of those apps?") is never answered.
- Market research written into About the client or Product without a research marker.
- Writing the brief before reading the client's previous outreach, or leaving "past outreach" as a
  heading with nothing behind it and no question asking for it.
- Hiding a conflict by picking one reading.
- Leaving hard exclusions only in the brief text, where `bh companies judge` cannot see them.
- An `industry` exclusion value too short to be safe ("ai" matches "retail") — use the full word the
  company data uses.
- Asking the client something already answered in `bh questions --status all` or a client_feedback note.
- Forgetting the customer/DNC list question before the first strategy launches.
