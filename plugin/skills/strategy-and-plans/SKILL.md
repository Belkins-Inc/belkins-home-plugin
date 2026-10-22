---
name: strategy-and-plans
description: How to build a strategy in bh (segments x personas x what we say x how we send) on a proposal a person approved, choose its channels from evidence, set its plan templates and steps, check the senders can carry the goal, enroll leads, get it ready for a person to launch, and keep it full and healthy afterwards. Use when creating or changing a strategy, setting plans, enrolling contacts, preparing a launch, or when a task says a strategy is below its target or unhealthy.
---

# Strategy and plans

A strategy picks segments and personas (in priority order, with an angle per persona), says what we
offer (the brief), holds plan templates (one per data situation), senders and a schedule. Every
enrolled lead gets its own plan: its `messages` rows, copied from the template. The engine executes
plans and protects; it never sources, enrolls or launches.

Rights: a scheduled agent (server agent) may not enroll, launch or pause. If you run under a
scheduled-agent token and a strategy needs any of these, open a task for a person (`bh task open`).

## Read first

1. `bh brief` — goal, rules, exclusions, open questions, tasks, queues.
2. `bh strategies`, then `bh strategy show <id>` for any strategy you touch (settings, personas,
   plans, enrollment counts, `beforeLaunch`).
3. `bh segments`, `bh personas`, `bh senders`, `bh mailboxes` — the ids you will reference.
4. `bh note list --kind decision` and `--kind rule` — client rules that shape the brief and copy,
   and the approval of the segments this strategy draws on.
5. Where the strategy already runs: `bh sql "select * from strategy_segment_usage where strategy_id = '<id>'"`.
6. The brief's "Previous outreach" part and this project's replies by channel — what the channel
   choice is made from (section 3).

## Procedure

### 1. Start from an approved proposal

The order is **analyse, propose, get a person's approval, then collect**. A strategy is built on
segments a person approved (`segment-design`, "Propose, then stop"): a `decision` note on the
segment and the approval task closed. No approval, or the task still open → stop; nothing is bought
for this strategy — people, addresses, verification — until it is closed.

The strategy's own choices are part of that proposal, because they change what the client gets:
which personas and in what order, people per company, how segments split across strategies, the
channels (section 3) and whether the senders can carry the goal (section 5). Drafting a strategy is
free; when one of these choices differs from what was approved, put the difference in front of the
person again and stop before paying or enrolling.

**A strategy that tests an idea names its hypothesis.** A second persona against the main one, a
vertical the client has not confirmed, a strategy B beside strategy A: the idea is a hypothesis
(`bh hypothesis add --strategy <id> --claim … --metric … --threshold …`, see `project-orientation`),
and the strategy is built as its test. Drafting it is free; nothing is bought or enrolled for it
until a person has moved the hypothesis to `testing` (`bh hypothesis update <id> --status
testing`). An alternative you considered and did not build is written down the same way, as
`proposed` or `parked`, so it is not lost.

### 2. Create the strategy

Write the settings to a file and run `bh strategy create --file strategy.json`. Only `name` is
required; everything else can follow with `bh strategy update <id> --file …` (same fields, partial).
`segments`, `personas` and `senders`, when passed, **replace** the whole list. Full field list,
defaults and an example: [references/strategy-json.md](references/strategy-json.md).

- `brief` (markdown) is what every message is written from. Structure it as the strategy level of
  Messaging: **Offer and call to action**, **Tone**, **Avoid**, plus **Proof** the client approved.
  One or two sentences per field, at most ~400 characters each. Write only what the client
  approved (client brief, notes); where there is nothing, say so in one sentence instead of
  inventing a claim, number or case study. No placeholders.
- `personas` in priority order; each `angle` is the persona level: the pain or trigger for this
  role in this segment, the one thesis that lands, the proof that convinces. The role's concerns come
  from what is written down (persona description, client brief), never inferred from a job title.
- Pick senders whose mailboxes are active (`bh mailboxes`). A sender with no signature sends
  unsigned email (the engine appends `senders.signature`); fix that before copy is written:
  `bh sender update <id> --signature "<text>"` (a person only; `--name`, `--title` likewise).

### 3. Choose channels from evidence

Channels follow what this client's market has answered, not habit and not only what is connected.
Before choosing templates, read the reply rate per channel from every history there is:

- this project's own sends — "Replies by channel" in [references/queries.md](references/queries.md);
- the client's previous outreach — the brief's "Previous outreach" part (`client-brief`).

Compare like with like: replies per lead reached on each channel, with the base beside each rate.
One meeting is evidence too — the channel it came from is in the plan unless there is a reason
written down. State the choice against the numbers in a note:

```
bh note add --kind decision --strategy <id> --title "Email and LinkedIn: LinkedIn replied at 20% of accepted, email at 0.13% of sends" \
  --body "<the rates, their base and source; why this mix>"
```

Where email is an order of magnitude behind, an email-only plan needs its reason in that note.
When the evidence favours LinkedIn and no account is connected, that is a task for a person to
connect one (`bh task open`), and the proposal says what the plan loses meanwhile — not a quiet
email-only plan. No history anywhere → say so in the note and give each step a `hypothesis` the
first results can answer. (A step's `hypothesis` is what that step should prove; an idea about the
market, the buyer or the offer is a project hypothesis, `bh hypothesis add`.)

### 4. Set the plan templates — before the first enrollment

`bh plan set <strategy-id> --file plans.json` replaces all templates. It is **refused once any lead
has a plan copied from them** ("Add a new strategy, or change a lead's own plan"), so settle the
steps first. Accepted values:

- `appliesWhen`: `email_and_linkedin`, `email_only`, `linkedin_only` (one template each at most).
- step `channel`: `email`, `linkedin_invite`, `linkedin_message`.
- `delayDays` (default 3): send days after the anchor; forced to 0 on step 1.
- `anchor`: `previous_step` (default) or `invite_accepted` (a LinkedIn message timed from acceptance).
- `condition`: `null` (always), `invite_accepted`, `invite_not_accepted`.
- `maxWaitDays` (default 10): a step whose condition is still unmet this long after it fell due is
  skipped and the next one is scheduled.
- `newThread` (email, default false): start a new thread with its own subject instead of "Re:".
  `bh plan step <strategy-id> <step-id> --file` with `{"newThread": false}` moves a frozen
  template's follow-up into the lead's first thread (a person only); every email of it not yet
  sent follows, written ones included (their own subject is then not used).
- `withoutNote` (`linkedin_invite` only, default **true**): an invitation goes as a bare
  connection request unless its step says `"withoutNote": false`. LinkedIn caps invitations with a
  note far below bare ones (a free account runs out after a handful and every further one is
  refused with "You have reached the limit for custom messages"), so a note is the exception: set
  `false` only when the person asks for notes while the strategy is being made, and say in the
  proposal that the account's cap will stop them. A bare step needs no copy (its messages are
  ready as soon as a lead is enrolled, copy written for them is refused) and no guidance; what a
  note would have said goes into the first message after acceptance. `bh plan step <strategy-id>
  <step-id> --file` with `{"withoutNote": true}` switches a frozen template's invite step (a person
  only): its unsent invitations drop their notes at once; `false` puts the ones left bare back in
  the copy queue.
- `guidance`: what this step says and how directly it asks — the copywriter's instruction. It may
  fix the exact question per persona ("Question, word for word: Want us to check last month's invoices?"; the first email offers
  something free for a yes and the question asks for it); the writer then uses it word for word. Edits the person makes to the
  copywriting sample go back into `guidance`, so the bulk copy inherits them.
  No em or en dash anywhere in it (refused): the writer copies its wording into the copy.
- `hypothesis`: what this step is expected to prove (read back when judging results).

Steps get positions in array order. Examples per template: [references/plans.md](references/plans.md).

**Which templates.** The engine picks per lead from its data: email usable and LinkedIn URL →
`email_and_linkedin`; email only → `email_only`; LinkedIn only → `linkedin_only`. A lead that
would get `email_and_linkedin` falls back to `email_only`, then `linkedin_only`, if that template is
missing; the other two have no fallback. Set the templates the channel choice (section 3) calls for,
and only those the project can execute: no connected LinkedIn account (`bh sql "select id, status
from linkedin_accounts"`) → `email_only` alone, with the reason in the channel decision note.

**How many steps.** Default four email steps over about two to three weeks (delays 0, 3, 4, 5
send days). Fewer than three wastes a researched lead; more than five reads as a machine and
burns the domain. The ask escalates, it does not repeat: step 1 asks at low friction whether this
is of interest; middle steps give a reason or proof and ask softly; the last asks for the goal
directly or closes politely; a one-step plan asks for the goal directly. Write that into each
step's `guidance`.

**Conditional steps.** Plans are conditions on steps, not a branching graph. A LinkedIn message is
`anchor: invite_accepted, condition: invite_accepted`; its copy is written up front and simply
unused if the invite is never accepted. A fallback (e.g. a short email) carries
`condition: invite_not_accepted`. A waiting step holds the steps after it for up to `maxWaitDays`,
so keep it at 7–10. Every step must read on its own and reference only steps sure to have gone out.

### 5. Capacity: can the senders carry it

Before enrolling, turn the leads into messages and the messages into sender days, with the engine's
real limits:

- **Messages needed** = leads × steps on each channel. Every step spends capacity, not only the
  first touch; count a conditional step at the share expected to fire.
- **Email** — each mailbox sends at most its `dailyLimit` a day (`bh mailboxes`; 40 by default, 60
  the most the engine allows), on the strategy's `sendDays` only (weekdays by default). Warm-up
  notes draw on the same day: a warmed mailbox with warm-up on keeps 8 notes a day going, so it
  carries 32 outreach emails of its 40.
- **The ladder** — a mailbox not yet `warmed` climbs for four weeks of sending days: three days of
  warm-up alone, then a trickle of 1–3 outreach emails a day to the end of its second week (about
  20), then 3 a day rising by 2 every other day to 15, about 126 emails over those two weeks. It is
  warmed only when its domain's seed notes are in the inbox, so plan on a new mailbox carrying a
  test batch in its first two weeks and its full share from its fifth. Buy domains about four weeks before a client needs volume (`sending-domains`).
- **A young domain** — under 60 days old, a mailbox sends at most 30 a day in all (22 outreach once
  warmed) and the domain at most 40 outreach emails a day across all its mailboxes; a mailbox
  marked warmed on a domain under 14 days old sends only a trickle, 1–3 a day. More volume early is more domains, not more mailboxes on one.
- **The engine's protection** — when a domain's seed notes slip into spam, its ladder stops
  climbing; when they fall below 70% in the inbox, the engine holds the domain's outreach, opens an
  urgent task for the project's owner and lets outreach go again once the notes are back for three
  days. A held mailbox shows `outreach_held_at`. Where each one stands:
  `bh sql "select address, daily_limit, warmed, sending_days, placement_state, outreach_held_at from mailboxes where sender_id in ('<sender-id>')"`.
- **LinkedIn** — each account sends 15 invites and 40 messages a day (`daily_invite_limit`,
  `daily_message_limit`), on send days. One invite per lead, so an account opens at most about 75
  leads a week.
- **Other caps** — `projects.daily_domain_cap` (3 by default) is sends per recipient company domain
  per day across the whole project, and binds when several people at one company are enrolled; a
  mailbox shared across projects gives this one only its `daily_share` of the sender; `dailyLimit` on the strategy
  caps first touches.
- **The engine's own brake** — a mailbox starts each day only as many new leads as their whole
  sequences fit its daily limit (a four-email plan on 40 a day: ten new leads), and sends follow-ups
  before first emails. Enrolling more than the mailboxes carry does not break sequences; it starts
  the extra leads days or weeks later. So the plan above still decides when the goal is met.
  A strategy whose leads must all be started before a date (an event's attendees) can turn this
  round: `{"firstEmailsFirst": true}` in `bh strategy update` (a person only) sends its first emails
  before its follow-ups and holds none of them, and its follow-ups run late instead.
- **A step too many in a frozen plan** — `bh plan remove <strategy-id> <step-id>` takes the plan's
  last step out (a person only): leads enrolled later do not get it, its unsent messages are
  cancelled, and a lead whose next step it was ends there.

Worked with the engine's defaults: 250 leads on a four-step email plan are 1,000 messages. Four fresh
mailboxes on one new domain send about 80 in their first two weeks and about 500 in the two after; the domain's
cap of 40 outreach a day then carries the other 420 in about eleven more sending days, so the last
step goes out around week six or seven. The other way round: a goal needing 1,000 leads a month on four
steps is 4,000 messages in about 21 sending days. A warmed mailbox on an old domain gives about 670
of them, a domain under 60 days old at most 840 however many mailboxes it has, so the month needs
six warmed mailboxes on old domains or five young domains of two mailboxes each — and 67 LinkedIn
account days if every lead gets an invite.

Record the arithmetic in a `decision` note with `--strategy`, and set `targetActive` from it. Where
the senders fall short of the goal, that goes in front of a person before enrolling (section 1):
more mailboxes (bought and ordered through the `sending-domains` skill, a person approving the
spend), a smaller batch, or a later goal.

### 6. Enroll

Input: `[{"contactId","segmentId","personaId"}]` (JSON or JSONL, ≤ 500 per call). Always:

1. `bh enroll <id> --file leads.json --dry-run` — per lead the template it would get and its start,
   or why it is skipped.
2. Read the skips, fix what is fixable, then run without `--dry-run`.

What the engine enforces (skip reasons you will see): contact not in the project; segment or
persona not in the strategy; on the do-not-contact list; the company is excluded from this
strategy; `rejected` for this strategy; catch-all
held back; no usable email and no LinkedIn; no template fits; the company cap
(`maxPerCompany`, counted over every enrollment in this strategy); the persona cap at the company;
no active mailbox among the senders; **already in a live strategy** (one contact, one live
strategy). Mailboxes are assigned by load. Starts are spread over `startSpreadDays`; a second person
at a company starts `companyStaggerDays` after the first.

Catch-all addresses follow `catchAllPolicy`: `hold` (default) holds the lead (`strategy_contacts =
held`) unless it has LinkedIn, in which case it goes LinkedIn-only; `linkedin_only` never emails a
catch-all; `send` treats it as valid. Change the policy only with a reason in a note.

Record selection decisions that are not enrollments: `bh stand <id> --contact <cid> --status
candidate|held|rejected --reason "…"` (reason required for held and rejected; rejected means never
look again).

A whole company that belongs in the segment but not in this strategy — a client's decision pending,
a site that redirects to a do-not-contact domain, a company that has already built what we sell:
`bh strategy exclude <id> --company <domain> --reason "…"` (a person only; several with `--file`).
It stays qualified for every other strategy; enroll skips its people, including those found later;
`bh strategy show` counts it under `excludedCompanies` and per segment. The answer's `live` is how
many of its people are already in a plan here — they keep going until someone pauses them.
`bh strategy include <id> --company <domain>` lets it back in.

After enrolling, every step of every lead needs copy — hand over to the `copywriting` skill
(`bh copy queue <id>`).

### 7. Readiness and launch (a person launches)

`bh strategy show <id>` → `beforeLaunch` lists four checks, all must be `ok`:
plan templates with steps; senders with an active mailbox; leads enrolled (active, paused or
scheduled); copy for every step of those leads. `bh strategy launch <id>` is refused with the
missing items otherwise, and only a person's token may launch or pause. Before asking a person to
launch also check: client's DNC list received (`bh questions`), exclusions set (`bh exclusions`),
a few `bh preview <message-id>` read end to end.

### 8. Keep the pipeline full

`targetActive` is the number of leads to keep in flight. The engine only signals (a task) when
fewer are live or candidates run out; finding and enrolling more is a person's session. Check:
queries in [references/queries.md](references/queries.md) (live count vs target,
`strategy_segment_usage.companies_left`, candidates waiting). When short: enroll `candidate`
contacts first, then source more (segment and sourcing skills; a new market goes through the
approval first), then enroll and write copy. New
leads on an active strategy start sending as soon as their copy is ready, so write it the same session.

### 9. Health

Signals (the engine opens a task; it never pauses by itself): hard bounces ≥ 3% of sends,
unsubscribes and complaints ≥ 2%, no replies after 200 sends. Read them only over enough volume.
Queries: [references/queries.md](references/queries.md). Bounces mean sourcing was wrong (verify
addresses; check the email-finding path); unsubscribes mean the segment or copy offends; silence
means the segment or offer is wrong. Recommend pause to a person with the figures; a scheduled
agent may not pause.

Read the results against the hypotheses the strategy tests (`bh hypothesis list`): each names its
`metric` and `threshold`. Short of the threshold's volume, add the figures to its evidence
(`--add-evidence`); at it, settle it — `--status confirmed|rejected --verdict "<the figures, with
their base>"` — and put what follows (a persona dropped, a segment widened) in front of a person.

Before calling a sender stuck, check two things. A mailbox sends only inside the strategy's window
in the lead's time zone (the project's when the lead has none), so a US project's mailboxes are
quiet until the window opens. A LinkedIn account that `bh linkedin` shows with `limitedUntil` is
resting on Unipile's rate limit (`limitedReason` has Unipile's words); it goes on by itself then,
and pausing and resuming it changes nothing.

A person pauses with `bh strategy pause <id> --reason "<the figures>"` (only a running strategy) and
resumes with `bh strategy launch <id>`. A strategy that is finished or replaced:
`bh strategy archive <id>` — refused while it runs (pause first); its leads and history stay.

## Record

- `bh note add --kind decision --strategy <id>` for every strategy choice a teammate would question
  (why these personas, these channels against the evidence, this catch-all policy, this target and
  the capacity arithmetic behind it); `--kind insight` for what results taught. `--strategy` scopes the note to the strategy.
- `bh question add` for anything only the client can answer (proof they allow, DNC list).
- `bh hypothesis add` for an alternative not built now, and `--add-evidence` when results bear on
  an open one.
- `bh task open` for launch, pause or enrollment a person must do.
- `bh session end --summary "…"` — what was built, what is left (copy, launch), what to watch.

## Common mistakes

- Buying people or addresses for a strategy on a market no person approved, or on choices that
  changed since the approval.
- An email-only plan by default while the client's history says LinkedIn answers and email does not.
- Enrolling several hundred leads against one or two fresh mailboxes without the capacity
  arithmetic — messages queue for weeks and the month's goal slips.
- Enrolling before plans are final — the templates are then frozen for this strategy.
- `strategy update` with a partial `personas` list — it replaces the list and drops the rest.
- An `email_and_linkedin` template in a project with no LinkedIn account.
- `guidance` that references a conditional step ("as I said on LinkedIn").
- Skipping `--dry-run`; enrolling people already live elsewhere and reading the skips as failures.
- Launching with the client's DNC list still outstanding.
