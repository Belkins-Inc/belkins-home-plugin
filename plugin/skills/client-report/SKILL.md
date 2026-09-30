---
name: client-report
description: Builds the periodic report for a client (weekly, monthly or at a milestone) as an HTML artifact from the project's database, for a person to review and send. Use when someone asks for a client report, a results update for the client, or "how are we doing" written for the client rather than the team.
---

# Client report

The report is built by Claude in a person's session and sent by that person. The engine keeps the
numbers; this skill turns them into what the client reads: what we did, results against the goal,
what worked and why, what changes next, what we need from them.

## Before anything

1. `bh brief` — the goal, open questions, notes, what is in flight.
2. Agree the period with the person (`:from`, `:to`, inclusive days). Default: since the last
   report's `period_end` (query 11 in [references/queries.md](references/queries.md), or
   `bh note list --kind insight` for titles starting "Client report") to yesterday.
3. Settle the inbox first. If query 3 shows `untriaged` replies or `bh inbox` is not empty, run the
   `inbox-triage` skill or tell the person the reply split will be provisional; a report built on
   the engine's unconfirmed classes can misstate the positives.
4. Read the client's side: `bh note list --kind client_feedback`, `bh questions --status all`,
   `bh note list --kind decision`, `bh hypothesis list --status all` (what we are testing and what
   was settled), and the meetings' `client_feedback` (query 4). The report quotes
   the client's verdicts; it never invents one.

## Procedure

1. **Run the queries** in [references/queries.md](references/queries.md) with the period
   substituted: volume (1), funnel (2), classes (3), goal and meetings (4), strategy × segment (5),
   the cuts that matter (6), angles and steps (7), cost (8) if the engagement reports it, removals
   (9), leads in flight (10). Keep every query's exact text and its result.
2. **Check the figures against each other** before writing a word: sent ≥ people contacted;
   positives ≥ meetings that came from replies; reply classes sum to the replies; goal `achieved`
   equals the held meetings that count. A mismatch is a finding: find why (a reply outside the
   period, a rescheduled row, an unattributed reply) and write the definition that makes it true.
3. **Decide what the numbers say**, per the sections in [references/sections.md](references/sections.md):
   - what worked: the persona, segment, country and angle whose positive rate stands out, and the
     client's verdict on the meetings they produced (quality beats count);
   - angles by reply rate through `thread_messages.reply_to_message_id → messages.angle` (query 7),
     ranked by positives then reply rate, with the unattributed count;
   - each hypothesis under test: its metric over the period against its threshold, with the base.
     One that reached the threshold's volume gets a verdict proposed to the person (`bh hypothesis
     update <id> --status confirmed|rejected --verdict "<figures>"` once they agree); one that has
     not says how far along it is. A result that bears on it goes into its evidence either way;
   - what slipped on our side and what we changed;
   - what changes next: only what the team decided or the person confirms now. A change nobody has
     decided is a question for the person, not a promise to the client.
4. **Write the page** as an HTML artifact: load the `artifact-design` skill, write one file, publish
   it with the Artifact tool. Private by default; the person shares it.
5. **Hand it to the person to read and send.** Point out every figure that rests on a judgement
   (an outcome mapped from the client's words, a class you re-read) and every question in
   "What we need from you". Sending is theirs.

### Sending it by email from the engine

When the person wants the report emailed from the agency rather than from their own inbox, and
says so in this session, send it as system mail:

- `bh system-mail domains` — a verified domain to send from. None: `bh system-mail domain add
  <name>` connects one (a person's act). It must be a domain no mailbox sends from — system mail
  never shares a domain with cold outreach, and the engine refuses one that does. On a domain our
  registrar holds the engine writes the DNS itself; otherwise it answers the records to add where
  the domain's DNS lives. `bh system-mail domain verify <name>` checks again (it also runs hourly).
- `bh system-mail send --from "<Name> <reports@that-domain>" --to <client addresses> --subject
  "<subject>" --body-file <text> [--html-file <html>] [--reply-to <the person's address>]
  --project <slug>` — only the addresses the person gave, at most 50, and only after they
  approved the final text.
- System mail is for people who expect it: the client, our own team, an invitation. Never a lead or
  a prospect — that is a strategy's work, from its mailboxes.

## Record, so the next report starts from this one

- **The report**: there is no `bh` command that writes `client_reports` yet. Record it as
  `bh note add --kind insight --title "Client report <from>..<to>" --body "<artifact URL>. Figures:
<each headline number = its definition and the query it came from>. Sent: <date or not yet>."`
  When `client_reports` gets a command, use it: `url`, `period_start`, `period_end`, `figures` (each
  number with how it was computed) and `sent_at`.
- **Questions put to the client**: `bh question add --body "<question>" --note "<why, what depends
on it>" --asked` for each new one in the report, and `bh question asked <id>` for open ones it now
  asks. Their answers later come in with `bh question answer <id> --body "<verbatim>"`.
- **What the report commits to** (the plan section): `bh note add --kind decision` for decisions
  the person confirmed, `bh task open` for actions with an owner and a date.
- **Hypotheses**: every verdict the person agreed (`--status confirmed|rejected --verdict`), and
  the report's figures added to the evidence of those still running (`--add-evidence`).
- **Insights worth keeping** ("refunds and lost-orders openers drew every meeting"): `bh note add
--kind insight`, superseding the older insight it replaces (`--supersedes <id>`).
- `bh session end --summary "<report period, URL, what was sent or is waiting to be sent, questions
asked, what to watch>"`.

## Rules

- Every number comes from a query you ran this session, over the stated period, with the stated
  definition. No number from memory, from a note, or from an earlier report without re-running it.
- A person counts once per stage: "replied" is people, not messages; out-of-office, bounces and
  unrelated mail (`other`) never count as replies.
- Meetings count from `meetings` and `goal_progress`, never from reply classes. A `rescheduled` row
  is history, not a second meeting.
- Small samples are said to be small. Four positives do not prove an angle; they suggest one.
- Spend: `spend` is the only ledger (one row per `bh call`, plus seats and data). Do not add
  `provider_calls` on top; the classifier's cost is in `model_calls` separately.
- The server agent does not build or send client reports: it has no artifact publishing, and what
  the client reads is sent by a person.

## Common mistakes

- Counting a reply from someone contacted before the period as a reply of the period's volume
  without saying so; the rate then exceeds what was sent.
- Reading `strategy_segment_usage.replied` as "people who replied": it counts enrollments stopped by
  a reply or an unsubscribe.
- Crediting every reply to the first touch's angle. Use `reply_to_message_id`; it names the message
  actually answered.
- Leaving the inbox untriaged, then reporting the engine's provisional classes as final.
- Writing internal words (`not_now`, `enrollment`, `segment_companies`) into a client page.
- Promising next steps nobody decided, or omitting what went wrong on our side.
- Not recording the report: the next report then cannot say "since last time", and nobody knows
  whether it was sent.
