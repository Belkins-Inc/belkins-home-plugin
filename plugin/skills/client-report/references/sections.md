# Sections, what each says, how it reads

The shape is the one the simulation's three-week report (sim/reports/S6-client-report.html) proved
out with a client-facing reader. Keep the order; drop a section only when it has nothing behind it
and say so in one line rather than padding it.

## Header

- Title: `<Client> outbound: <period in words>` (e.g. "three-week report", "October").
- One line: the period as dates, who prepared it (the team, not a person's name unless asked), and
  "all figures from our campaign database as of <date, time, zone>".
- **In short**: three or four sentences a busy reader can stop after. Meetings against the goal,
  people and companies reached, how many replied, and the one thing that decides next period
  (usually a decision we need from them).
- Four figure tiles at most: meetings vs goal, people contacted (at N companies), people who
  replied (with %), positive replies. Nothing else earns a tile.

## 1. What we did

Plain past tense, one short paragraph or bullet per activity, each with its number:

- the target list: how many companies checked against their brief, how many passed, the main
  reasons the rest failed (from `segment_companies` verdicts), exclusions made at their request;
- the people: how many reached at how many companies, by persona; the qualified companies we could
  not reach and why (no deliverable address, no matching title: `strategy_companies.status`);
- the sequence: steps and channels, the senders, the proof points used (only ones the client
  approved), waves with dates and sizes;
- volume: touches by channel, invites accepted, bounces;
- exclusions: their customers and the people who asked to be removed are blocked for good (a count,
  never the removed people's names).

## 2. Results against the goal

- The goal as data (`goal_progress`): target, what counts, achieved, still scheduled. With no goal
  row, say "no goal set for <month>"; never reconstruct one from notes.
- A meetings table: person and title, company (country), date held, the client's verdict in their
  own words (`client_feedback`). A meeting the client has not rated says "awaiting your feedback".
- The funnel: contacted, replied (out-of-office not counted), positive, meetings held, qualified by
  the client; each with its rate against the stage before it.
- What the replies said: one row per class with the count of people and a short representative
  paraphrase (never a named lead's words).
- **Where it slipped**: what went wrong on our side, as fact, with what we changed. A late booking,
  a bounce spike, a stalled step: say it before the client finds it.

## 3. What we learned: who responds, and why

Open with the sample-size caveat whenever positives are under about ten: "read these as signals,
not proof". Then short tables (contacted / replied / positive) by the cuts that differ: persona,
segment, country, angle, step, sender. Follow each with one or two sentences on what it changes in
what we do next. Skip a cut where nothing differs. Tie the client's meeting verdicts back to the cut
they came from when it separates quality ("both 'great fit' meetings came from the 3.5-or-lower
band").

Angles: rank by positive replies, then reply rate; name what the winners share and which expected
winner did not work. Say how many replies could not be attributed to a message.

Why people said no: the objections by frequency, and what we do with each (not-now dates we will
write again on, referrals we are following up).

What we are testing: each hypothesis under test in the client's words ("whether operations
leaders, not procurement, buy fuel at mid-size carriers"), the figure it is judged by against the
threshold, with its base, and how far along it is; then what was settled since last time, with the
verdict. Proposed ones the client can move (a vertical waiting on their word) go to section 5 as a
question.

## 4. Plan for next period

Concrete actions with dates: who we write to next, which angle leads, what we stop, what we fix.
Only what the team has decided (`bh note list --kind decision`, `bh task list`). Then an honest
outlook against the goal: whether what is in flight can reach it, and what it depends on.

## 5. What we need from you

The open and asked questions (`bh questions`), each as a decision they can answer in a line, the
options lettered where there are options, and how long it has been open ("we asked on 5 October and
have not had an answer"). Always ask for the outcome of meetings without feedback, and for new
customers or open deals to exclude.

## Definitions (last, small)

One paragraph: what "contacted", "replied", "interested" and any band or segment label mean, and the
period rule. The client reads every number through these.

## Writing rules

- Every number is one a query produced, and the query is kept with it (SKILL.md, "Record"). A number
  you could not compute reliably is left out, or given with what it rests on; never rounded into
  confidence.
- Write only what the data and the client's own feedback support. Where a section has nothing
  behind it, say so in a line; do not generalise from the industry and do not pad.
- The client's words for their business; no internal table, status or class names (`not_now`
  becomes "not now, try me in December"; `strategy_segment_usage` never appears).
- Where two sources disagree (their feedback and our data; two complaints naming "Urban Gear" and
  "Urban Gadgets"), write both readings and ask. Do not settle it quietly. A difference of wording
  is not a disagreement.
- No preamble, no summary of what the report is about to say, no closing pleasantries. Short
  sentences; bold only the terms a reader scans for.
- Nothing about other clients; no lead's email address; names of people who unsubscribed or
  complained never appear, only counts. Spend goes in only when the engagement reports it.

## Page

An HTML artifact (load the `artifact-design` skill before writing it): one readable column (about
760px), tables in a horizontal-scroll wrapper, light and dark themes, all data inline, a chart only
where it makes a comparison plainer than a table. It must print well: a person may send it as a PDF.
