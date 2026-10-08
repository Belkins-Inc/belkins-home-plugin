---
name: segment-design
description: Defines and works a segment — which companies to look for (definition and criteria, never people), where to find them (sources of kind linkedin, trustpilot, web, directory, import), how big the market is by free counts and whether it carries the meeting goal, the proposal a person approves before any money is spent, and which found companies qualify (`bh companies judge`, with the signal copy is written from). Use when opening a new market for a client, adding or changing a source, sizing a market, or judging companies found for a segment.
---

# Segment design

A **segment is which companies**: the test every company must pass, wherever it was found. Its
**sources** say where to look. Its **companies** are every company found, with a verdict and the
**signal** that put it there. Titles and people never belong here (`persona-design`). Segments belong
to the project, so several strategies can draw on one.

Sourcing finds and spends: it is done in a person's session, never by the scheduled agent. The order
is fixed: **analyse, propose, get a person's approval, and only then collect.** Everything up to the
proposal is free — reading, research, counts, drafting segments. Nothing that costs money runs until
a person has approved the brief, the titles and the segment with its numbers (step 7).

Judging companies already found is different: from free sources it is judgement, not spending, and
the server agent does it when the engine signals a segment's backlog ("The server agent's part",
below). Paid enrichment stays a person's.

## Read first

- `bh brief` — "Target companies", "Qualification criteria", "Anti-ICP", exclusions, decisions.
- `bh segments`, `bh sources`, `bh exclusions`.
- `segment_usage`, `source_usage`, `strategy_segment_usage` and earlier `searches` /
  `provider_calls` (recipes in `project-orientation/references/sql-recipes.md`): what was already
  found, what it cost per qualified company, which searches ran and where their cursor stopped.
  Never pay for a search that already ran — continue from its cursor.
- `bh brief` → `openTasks` and `bh note list --kind decision`: whether this market was approved. An
  approval task still open means the proposal is waiting for a person — do not spend.

## Procedure

1. **Draft hypotheses from the brief, not from habit.** Two or three for a new project or a new
   market, so a person chooses between real alternatives. One segment = one market with one reason
   to buy now. Check it does not substantially overlap a segment the project already runs; if it
   does, add a source to that one instead. Say why now in one sentence. Where the brief's previous
   outreach (part 6) shows an audience that already answered, it is one of the hypotheses. Draft each
   as a segment (steps 2–5) so its counts are recorded; the ones not chosen are archived after the
   decision. (These are alternatives for one choice. An idea to try beside the chosen line is a
   project hypothesis — step 7.)
2. **Write the definition** — markdown: who is in (industry / what they do for a living, size,
   geography, company type, required facts), who is out and why, why they buy now, and how a
   company is judged. Name only what the segment *is*; project-wide "never" rules are exclusions
   (step 4), not per-segment text.

   ```
   bh segment create --name "E-commerce with poor support reviews" --body "<definition>" \
     --criteria '{"employees":{"from":50,"to":1000},"countries":["US","GB"]}' --estimate <n>
   ```

   `segment create` upserts by name; re-running it keeps the fields left out. Later changes:
   `bh segment update <id> [--name] [--body] [--criteria <json>] [--estimate <n>] [--status
   active|paused|exhausted|archived]` — pause or archive a segment you stop working.
3. **Choose the kind of source by where these companies are listed** — details and query shapes in
   [references/sources.md](references/sources.md):
   - `linkedin` — companies described by industry, location, size, type (the default);
   - `trustpilot` — defined by presence or reputation on Trustpilot: rating, review count, category;
   - `directory` — members of an association, exhibitors or speakers of a conference, a ranked list;
   - `web` — companies only a web search surfaces (a funding round, a job ad, a technology);
   - `import` — a list the client gave.

   A market with no LinkedIn industry (data centres have none) is not a `linkedin` source: take the
   list from a directory, an association or a conference, or reach the people through
   self-qualifying titles (`persona-design`) — see "Some markets have no industry" in
   [generect](../providers/references/generect.md).

   ```
   bh source add <segment-id> --kind trustpilot --name "Trustpilot: Electronics, 100+ reviews, ≤3.5" \
     --provider <p> --query '<json in the source's own terms>' \
     --body "<recipe: what to open, what to enrich from where, what signal to keep>" --estimate <n>
   ```

   The recipe (`--body`) is what lets the next session run the source without re-deriving it.
   Re-running `source add` with the same name updates it and keeps the fields left out;
   `bh source update <id>` changes status, cursor, estimate and the recipe (`--body`).
4. **Put the client's hard rules in exclusions**, if `client-brief` has not: `bh exclusion add --kind
   country|industry|business_model|employees_below|employees_above|rating_above|other --value <v>
   --note "<why, client's words>"`. The judge refuses to qualify a company that breaks one; the
   response lists already-qualified companies that now break it — re-judge those.
5. **Size with free counts — companies and people.** Use counts that cost nothing: a count endpoint
   (Generect's are free), or the total a directory or list prints on its first screen (read it with
   your own web tools). Count the **companies** in the segment and set `--estimate` on the segment
   and the source — the real number, never a round guess when the source printed its total. Then
   count the **people**: the persona titles (`persona-design`) against the same company filters,
   through the free leads count. A segment with plenty of companies and nobody in the titles is not
   a market. Record each sizing call with `bh search record`: a count returns no rows, so send
   `{"kind":"companies","sourceId","provider","query","results":0,"note":"count: <n>","callIds":[…]}`
   (no cursor — the source has not moved). `bh call` prints the count on stderr as the result count.
6. **Carry the numbers to the goal.** Work from the month's meeting target down through leads,
   addresses and people to companies, each rate with where it came from —
   project history, the client's previous outreach, or an assumption said to be one. Method and a
   worked example: [references/sizing.md](references/sizing.md). `bh brief` shows only this month's
   goal; the months ahead are in `bh sql "select month, meetings_target, counts from project_goals
   where project_id = @project"`. No goal at all → the agreement's target, said to be one. The
   required output, per hypothesis:

   ```
   Goal: <n> meetings (<qualified|held>) in <YYYY-MM>
   Leads needed per month: <n>        (goal ÷ <meetings per lead> [<source>])
   People needed: <n>                 (÷ <share with a usable address or LinkedIn> [<source>])
   Qualified companies needed: <n>    (÷ <people per company>)
   Available by free counts: <n> companies, <n> people → <n> leads in all
   Gap: <available − needed> against the first month; the segment carries the goal for <n> months
   ```

   Too small → widen, add sources, or a second segment; far too large → tighten so the signal is
   sharp. If the gap is negative, the proposal says so in its first line.
7. **Propose, then stop.** Before the first paid call on a new project or a new market, put one
   proposal in front of a person. It has three parts, approved together:
   1. **The brief** — as saved by `client-brief`, with what the materials could not answer and the
      open client questions.
   2. **The titles, with free counts** — each persona's title list and its free people count in this
      geography (`persona-design`), so nobody approves a title that returns nothing.
   3. **The segment and the numbers** — the two or three hypotheses: who is in each, why they buy
      now, the free counts of companies and people, the step 6 output, and what the first batch
      will cost (rows × the prices in `bh providers`, then address finding; say which prices are
      unknown). Name each choice that changes what the client gets, with its alternative: the
      employee floor, the geography, the personas, people per company, how the strategies split,
      the channels (`strategy-and-plans`).

   Record it and stop:

   ```
   bh task open --assignee <person> --title "Approve brief, titles and segment for <client>: nothing is spent until then" \
     --done-when "the hypothesis chosen is recorded as a decision note" --body "<the proposal>"
   ```

   **No paid endpoint is called until that task is closed** — not a sample page, not one
   enrichment "to check". A person in the session may answer on the spot; it is recorded all the
   same. Their answer becomes `bh note add --kind decision --segment <id> --title "<the segment
   chosen, with its numbers>" --body "<what they approved and what they changed>"`; archive the
   hypotheses not chosen (`bh segment update <id> --status archived`); then `bh task close <id>
   --note "decision <note-id>"`. A new geography, industry or segment later goes through the same
   gate; more batches from an approved segment do not.

   **A market that is not the main line becomes a hypothesis**, never a note or a line in chat: a
   vertical the client has not confirmed (mines in an aggregates segment), a company type whose
   role is unclear (fuel tank carriers: buyer or vendor?), an alternative still worth trying after
   the choice. `bh hypothesis add --segment <id> --claim "<who buys and why>" --evidence "<what
   suggests it, the free counts, the question id if it turns on the client>" --metric "<what is
   measured>" --threshold "<what confirms it>"`. It stays `proposed` (or `--status parked`) and
   **nothing is bought for it until a person moves it to `testing`** — which is this gate for that
   market. Put it in the proposal so the person decides it with the rest.
8. **Search, store, judge** — the loop for every batch:
   1. `bh call <provider> … --segment <id> --source <id>`; note the call ids on stderr.
   2. `bh companies upsert --file companies.jsonl` — `domain` (the company's own site, never the page
      it was read from), `name`, `industry`, `employeeCount`, `country` (ISO alpha-2), `linkedinUrl`,
      `facts`. The exclusions read `facts.business_model` (e.g. `"amazon_only"`) and `facts.rating`
      (a number), plain or as `{value, source, note}`.
   3. `bh search record --file search.json` — `{"kind":"companies","sourceId","provider","query",
      "cursor","results","newRecords","duplicates","callIds":[…]}`; the cursor moves the source on.
      Keep the returned search id.
   4. `bh companies judge <segment-id> --file verdicts.jsonl` — one row per company: `domain`,
      `status`, `reason` (required for `qualified` and `disqualified`), `evidence`
      (`[{fact, value, url, seenAt}]`, on every verdict), `exclusionId` (when a client's rule is the reason),
      `signal`, `sourceId`, `searchId`.
   5. When a source runs dry: `bh source update <id> --status exhausted`.
9. **Record what you learned**: a result that bears on an open hypothesis goes into its evidence
   (`bh hypothesis update <id> --add-evidence "<figures, ids>"`); otherwise `bh note add --kind insight` (a source that yields 5% qualified, a
   rating band that works) or `--kind decision` (segment opened / paused, and why), with
   `--segment <id>` so the note is scoped to the segment.

## Judging companies

Details and examples in [references/judging.md](references/judging.md). The core:

- Judge on **what the company does for a living**. A fund, an agency, a conference organiser or a
  publisher found in a segment of manufacturers is `disqualified` — the common case, not a borderline.
- **A missing fact is not a disqualification.** Leave the company `new` until the fact that decides
  it is known (enrich it), rather than guessing either way — and say which fact in `reason` ("number
  of sites unknown"); a `new` verdict without one is refused. The tool also cannot enforce an
  exclusion on a fact the company lacks — you must.
- **Held on the client** — the company turns on a question put to the client (`bh question add`):
  judge it `new` with `questionId` (the reason defaults to the question). It is not counted as work
  until the question is answered or dropped; then judge it on the answer.
- **Nothing stays `new` unowned.** Companies waiting on a fact for more than two days
  (`JUDGE_AFTER_DAYS`) open one engine task per segment, "N companies to judge in <segment>", for
  the project's owner; the engine keeps its count current and closes it when none waits. Held
  companies are not counted.
- `other` exclusions are never checked by the tool; check them yourself on every verdict.
- `reason` is short and reusable ("too small: 12 employees", "competitor", "already a client",
  "B2B only — segment is consumer brands").
- **Signal is the material copy is written from**: the concrete, sourced fact that put the company in
  — `{"rating": 2.8, "reviews": 340, "top_complaint": "slow replies", "source": "trustpilot"}`,
  `{"hiring": "3 support agents", "job_post": "<url>", "seen": "2026-09-20"}`. No signal → nothing to
  say → usually not qualified. Signals merge across calls; send only what is new.
- Every verdict is kept (`segment_company_verdicts`), so re-judging is safe: judge again with the new
  status and reason when facts or exclusions change.
- A company found by one segment's source may be judged into another segment — pass the source
  where it was actually found.

### The server agent's part

When a project's agent is on, a run takes up to 40 companies at a time from segments with an open
judging task, and is told which. Rules for that run (details in
[references/judging.md](references/judging.md), "The server agent's part"):

- Free sources only: what is stored (`bh companies in <segment-id> --q <domain>`, the company's
  `facts` and `signal`), the brief's ICP and exclusions, and the company's own site with WebFetch —
  the run may fetch only the domains it was given. Never `bh call` a provider.
- Every company it was given gets a verdict: `qualified` with a sourced signal, `disqualified` with
  a reason, or `new` with a reason naming the fact the free sources did not give. A company it left
  `new` goes to the task's owner (paid enrichment, or a person's judgement); the agent does not take
  it again.
- Do not close the segment's task — the engine closes it when nothing waits.
## Common mistakes

- Calling a paid endpoint before the approval task is closed — "propose" read as "write it down and
  continue". The proposal stops the work.
- A single hypothesis put to the person, so the choice is yes or no instead of which.
- An estimate with nothing behind it ("about 900") when the directory printed its total on the first
  screen; or counting companies and never people.
- Sizing that stops at companies: a goal never turned into leads, people and companies needed, so
  nobody sees that the segment cannot carry it until the money is spent.
- Titles or people in a segment definition.
- Paying for a search already run (not checking `searches` / `provider_calls` and the cursor).
- Forgetting `bh search record`, so the spend is not tied to the source and the next session repeats it.
- Qualifying without a signal, or with a vague one ("good fit").
- Disqualifying for a missing field; or qualifying a company whose employee count is unknown under an
  `employees_below` rule because the tool let it through.
- Leaving a company `new` without saying what it waits on, or holding a company on the client
  without naming the question — so nobody can tell whose move it is.
- Storing a directory's or Trustpilot's URL as the company domain.
- A new segment that is an existing one with a different name.
- A side market kept in a note or chat, so nobody knows it is open; or sourced before a person
  moved its hypothesis to `testing`.
