---
name: copywriting
description: How to write the copy of every step of every enrolled lead's plan (email, LinkedIn invite, LinkedIn message), including referral and re-engagement copy, with bh copy queue / bh copy check / bh copy write / bh preview, and a strategy's sample emails for warm-up (bh copy sample). Use whenever a strategy has messages that need copy, after enrolling, when a lead is stuck on "no copy", when a re-engagement or referral enrollment waits for its first message, or when mailboxes must warm on a strategy's text before launch or for outreach sent through another platform.
---

# Copywriting

All copy is written in Claude Code and stored in `messages`; the engine only sends it. Copy is
written for **one named person**, every step up front at enrollment, so a person can review the
whole plan before launch. A step whose copy is missing when it falls due holds the lead (stuck).

Rights: a server agent run writes no copy and no answer (`bh copy write` refuses its token):
re-engagement and referral copy waits in `bh answers` for the own Claude of the person whose lead it
is (`writing-answers` skill); first messages for newly enrolled people are a person's session (the
engine opens a task instead). A referral or re-engagement step that another person's Claude already
wrote is refused with who wrote it and when: read theirs (`bh preview`), and replace it with
`bh copy write --replace` only when you mean to, never on a scheduled pass.

## Read first

1. `bh brief` — rules (`kind = rule` notes) and exclusions are binding on copy too.
2. `bh strategy show <id>` — the `brief` (offer, tone, avoid, proof), each persona's `angle`, and
   each step's `guidance` and `hypothesis`. Write only what these support.
3. `bh note list --kind client_feedback` — what the client liked or banned.
4. Angles already used in the project, to stay consistent:
   `bh sql "select angle, count(*) from messages where angle is not null group by angle order by 2 desc"`.

## Procedure

1. `bh copy queue <strategy-id> [--limit n]` (default 50, max 200). Each item is one message still
   `needs_copy`, ordered by lead then step: `messageId`, `enrollmentId`, `kind` (`first`,
   `re_engagement`, `referral`), `followsEnrollmentId`, `position`, `channel`, `condition`,
   `guidance`, `hypothesis`, `newThread`, `strategyBrief`, the contact (`firstName`, `lastName`,
   `title`, `email`, `timezone`, `contactFacts`, `referredBy` — the referrer's name or null), the
   company (`company`, `domain`, `companyFacts`, `signal` — why it is in the segment, null when
   there is none), `persona`, `personaAngle`, `segment`, `sender`, `signature`, `earlierSteps`
   (subject and body of this lead's steps already written), and `problem` — set when a first-contact
   lead has **no signal**: nothing specific is known, so its copy makes no observation (see "Specific
   or silent"). Tell the person how many leads in the batch have no signal before writing them.
2. For a `referral` or `re_engagement` item, read the earlier conversation it follows (`bh thread`;
   how to find it: [references/context-queries.md](references/context-queries.md)).
3. **Sample gate, before any bulk copy.** Write every step for **one lead per persona and
   strategy** (pick leads with a typical signal, not the richest), check them (step 6), and show
   them to the person as plain text: subject, then each step's body. Take their edits back into the
   strategy's step `guidance` (`bh plan set`), not only into the samples, and write the samples
   again from the new guidance until they approve. Only then write the rest. At a few hundred
   messages, copy written before anyone has seen the style is copy written twice.
4. Write **one lead's whole plan as one story**: step 3 knows what steps 1 and 2 said. Follow each
   step's `guidance` and its place on the ask ladder (interest → value → goal). Where the guidance
   gives a question word for word, use it word for word.
5. Put the batch in a file, one object per message:
   `{"messageId","subject","body","angle"}` (JSON array or JSONL). `subject` is `null` for LinkedIn.
6. `bh copy check --file copy.json` (up to 2 000 messages) writes nothing and reports every problem
   per `messageId`: the engine's checks below plus the house rules it can read (dashes and curly
   quotes, burned phrases and hype, the greeting with the real first name, a first sentence starting
   with I or We, word limits per step, the question rule, the subject rules, one subject across a
   thread, British spelling to a US recipient, a link or markdown, the same first email to two
   colleagues at one company). It exits 1 while any message has a problem; `warnings` (a lead with
   no signal) are for the reviewer, not errors. Fix and check again until `withProblems` is 0.
   When several agents write one strategy, check the whole batch together: colleagues are compared
   across the batch and against copy already written.
7. `bh copy write --file copy.json`. The batch is all or nothing: one refused message and nothing
   is written; the error lists every problem per `messageId`. Fix and send the batch again.
8. `bh preview <message-id>` for the first lead of each persona and each template: it shows the
   message as sent (from, to, subject with "Re:", body with signature). Read it as the recipient.
   To see how it lands in a real inbox, a person sends it to their own address: **Send test** on the
   strategy's Copy tab, or `bh copy test <message-id> --to <their address>` (never to a lead; a
   scheduled agent cannot send one).
9. Repeat until the queue is empty; `bh strategy show <id>` → `beforeLaunch` "Copy for every step".

A message is rewritable while it is `needs_copy` or `ready`; once `sending`/`sent` it is refused.

## What the engine checks (`copyProblems`) — refused exactly for these

- email: body under 20 characters (trimmed) or over 2 500 — "the body is shorter than 20
  characters" / "longer than 2500"; subject missing or under 3 characters — "an email needs a
  subject"; subject over 90 — "the subject is longer than 90 characters".
- `linkedin_invite`: body 1–200 characters on a step set `"withoutNote": false` (1–300 when the lead's LinkedIn account has Premium; over that: "the note is longer than 200 characters, the most LinkedIn takes from an account without Premium"); refused outright
  on any other ("the step sends its invitation without a note"), as invitations go bare by default; `linkedin_message`: body 1–1 900 characters; either with
  a subject — "a LinkedIn message has no subject".
- any channel: "a placeholder was left in the copy" when body or subject contains `{{` or `}}`,
  `[name]` / `[first name]` / `[last name]` / `[full name]`, `[company…]`, or **any square
  brackets holding only letters and spaces** (case-insensitive, so `[see below]` is refused too).
- `angle` is required (non-empty) on every message.

These are the floor. The house rules below are stricter; `bh copy write` does not refuse on them,
`bh copy check` reports the ones a script can read, and the rest (substance, specificity, one story)
you hold. Full rules, lists and examples: [references/house-rules.md](references/house-rules.md),
[references/examples.md](references/examples.md).

## Rules that matter most

- **Specific or silent.** Where there is a signal or facts, one sentence is about them and could
  not be sent to any other company. Where there is none, take the angle from the brief and invent
  no observation: they can tell.
- **Only what the brief supports.** No claim, number, customer or result that is not in the
  strategy brief, persona angle, client notes or the lead's facts. A role's concerns come from the
  persona angle, never from the job title.
- **No signal, say so.** A lead whose queue item has `problem` set (no signal) gets copy from the
  brief and the persona angle only, and the person hears how many such leads the batch has.
- **The first email connects the dots, in three beats, then the question**: their footprint (a fact
  from the signal or facts), the pain that scale means for this reader (hedged: "usually",
  "often"), what the reader gets free for a yes (a concrete deliverable from the client, matched to
  the reader's pain), then the question that asks for it. Going straight from the observation to the question was refused in onboarding.
- **Simple beats clever.** The reader gets the email in one read and answers without thinking:
  plain words, one idea, nothing to work out.
- **Every email ends on one short question**: under ten words, with one obvious answer (a yes, a
  date or a name). Never either/or, never two questions. **The first email offers value for a yes**:
  something concrete and free the reader gets by answering (a check of last month's invoices, a
  backup vendor list for their sites), and the question asks for it. Model: "Want us to check last
  month's invoices?". A question that only asks about them gives nothing for the reply and is
  refused in the first email: "Who checks the fuel invoices across your sites today?", "Does anyone
  compare fuel prices across your terminals?". Refused: "Is fuel run centrally, or does each site handle its own?". The
  last email makes one offer and asks "Want me to set it up?"; it may close with one sentence after
  the question ("If fuel is not a priority right now, I will stop here.").
- **Email greets by first name on its own line** ("Hi Ada,"), the real name written in. No first
  name → no greeting at all ("Hi there" is worse). The first sentence does not start with "I" or "We".
- **Short.** A first email at most 120 words, a follow-up 100, the last 70 (after the greeting); a
  few short paragraphs of uneven length, one idea, one ask. Plain text, blank lines between
  paragraphs; no markdown, lists, HTML; no link on step 1.
- **American spelling for US recipients** (center, fueled, program, organize).
- **No sign-off, no signature.** The engine appends the sender's `signature` to every email; the
  body ends on its last sentence. No "Best regards". If `signature` is null, stop: a person sets it
  with `bh sender update <sender-id> --signature "<text>"` (ids: `bh senders`); a scheduled agent
  opens a task for one.
- **Subject**: what a colleague would type, ≤ 6 words, sentence case or lower, no "!", emoji, dash
  or "quick question". Proper names keep their capitals ("diesel across Acme quarries"). Write
  it last, from the email.
- **No dash as punctuation** (—, –, or a spaced hyphen); hyphens inside words are fine. Straight
  quotes and "..." rather than typographic ones.

## Follow-ups and threads

- An email step after the first goes in the same thread unless `newThread`: the engine sends it
  with subject `Re: <first sent email's subject>` and threading headers. Still give every email a
  valid subject (the check requires it); use step 1's subject so the record reads cleanly.
- A follow-up does not repeat the opening, reuse the earlier observation or restate the same point
  in other words; it moves to a different side of the brief. No "just following up", "bumping this".
- **Every step must read on its own and reference only steps sure to have gone out.** A
  conditional LinkedIn message may never go; an email may bounce and then LinkedIn continues. So an
  email never mentions LinkedIn, a LinkedIn message never relies on an email having arrived, and a
  step after a conditional one references neither. (Not checked by the engine yet, so check it
  yourself.)

## Sample emails for warm-up (no lead needed)

Every other warm-up note, and the placement tests, carry the project's copy so the seeds rescue and
answer the text we actually send. Steps written for leads count, launched or not. When there are
none — the strategy is prepared ahead and its leads are not found yet, or we only warm the mailboxes
and outreach goes out through another platform, so nobody is ever enrolled here — write the
strategy's **sample emails** instead. Nothing is launched and no lead is touched.

1. One sample per email step at least (more variants rotate better, up to 50 a strategy):
   `[{"position": 1, "subject": "…", "body": "…"}, {"position": 2, "subject": "…", "body": "…"}]`.
   `position` is the step; a later one goes out as `Re:` the first sample's subject unless
   `"newThread": true`. Write for one plausible made-up lead of the segment (a first name, their
   company's situation), exactly as a real step: same rules, same checks, no placeholders. When the
   copy lives in the other platform, take its sequence as it is sent there, a lead's tokens filled in.
2. `bh copy sample <strategy-id> --file samples.json` (all or nothing, checked as `bh copy write`);
   `--replace` swaps the strategy's earlier samples for the new set.
3. `bh copy samples <strategy-id>` lists them with how many warm-up and placement notes carried each;
   `bh copy sample-remove <strategy-id> <sample-id>` takes one out. Rewrite them when the sequence
   changes: they are not tied to the plan templates.

Samples go only to our seeds and do not count toward launch: launch still waits on every lead's own
copy. A mailbox carries its projects' copy from its fourth sending day; a network mailbox no
project has taken carries none.

## LinkedIn

- `linkedin_invite`: only on a step that asks for a note (they go bare by default). At most 300
  characters including spaces and line breaks; two short sentences; asks for nothing beyond
  connecting; no pitch; no greeting needed.
- `linkedin_message`: two to four sentences (well under the 1 900 limit); no subject, no greeting
  line, no signature; one ask.

## Angles

Every message carries the idea it leads with, as `<kind>:<slug>`: `pain:slow-replies`,
`proof:acme-outdoor`, `trigger:new-funding`, `signal:trustpilot-rating`, `question:priority`,
`close:last-touch`, `referral:<referrer>`, `reengage:<topic>`. Reuse existing slugs for the same
idea; reply rates are read by angle.

## Referrals and re-engagement

- **Referral** (`kind = referral`): the first message names the person who referred (`referredBy`:
  "Anna Smith suggested I write to you") and says only what that person actually said — read their
  reply with `bh thread <thread-id>`. Angle `referral:<slug>`.
- **Re-engagement** (`kind = re_engagement`, starts on the agreed day; copy due two days before):
  read the earlier conversation with `bh thread`. Open on what they said ("You asked me to come back
  after the holidays"), do not replay the old sequence, one fresh reason, one ask. It is a new thread:
  give it a subject of its own. Angle `reengage:<slug>`.
- The query to find the earlier thread: [references/context-queries.md](references/context-queries.md).

## Record

- `bh note add --kind insight` when an angle or step clearly works or fails; `--kind rule` for a new
  client copy rule (e.g. "never mention pricing"), so every writer follows it.
- `bh question add` when the brief lacks something only the client can give (a usable proof).
- `bh session end --summary "…"` — strategies and leads written, what is still `needs_copy`.

## Common mistakes

- Writing step 2 without step 1 in view; four openings instead of one story.
- A bracket like `[link]` or `[Company]`, or a `{{first_name}}` token — refused, or worse, sent.
- Signing the email with the sender's name on top of the engine's signature.
- A LinkedIn invite over 200 characters (300 from an account with Premium), or with a subject.
- An observation invented because the lead's facts were empty.
- Bulk copy before the person approved a sample; the edits then land on hundreds of messages.
- A question with "or" in it, or a second question "to be safe".
- Writing `bh copy write` straight away: run `bh copy check` on the whole batch first.
- Leaving a batch half-written at session end: stuck leads the next morning.
