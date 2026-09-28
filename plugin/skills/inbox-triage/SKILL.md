---
name: inbox-triage
description: Works a project's inbox — confirms or corrects the engine's classification of each reply, drafts answers for a person to approve, and turns "not now" and referrals into follow-ups. Use when replies are waiting (`bh brief` shows untriaged replies or drafts to approve), when asked to check or work the inbox, and in every server-agent run that has replies waiting.
---

# Inbox triage

The engine has already acted on every reply before you see it: at ingest, any human reply stopped
the lead's plan; seconds later the classifier gave it one of eleven classes and ran that class's
rules. Your job is to confirm or correct the class (a new class or date re-runs the rules), answer
what needs an answer, and hand dated follow-ups to the right place. Replies that wait cost meetings: in the
simulation four confirmed meetings were lost to a week of untriaged replies.

## Read first

1. `bh brief`: untriaged count and the oldest, drafts waiting for approval, open tasks.
2. `bh inbox`: every reply not yet triaged, oldest first, with the engine's `classification`,
   `note`, `followUpOn`, the lead, company, strategy and `leadStatus`.
3. [references/classes.md](references/classes.md): the eleven classes and their tie-breaks, verbatim
   from the engine's prompt. Use exactly these definitions so people and the engine agree.
4. `bh brief` → `openHypotheses`: what the project is testing. A reply can bear on one ("I'm not
   the one who buys fuel — that's our VP of Operations").
5. Before drafting: [references/answers.md](references/answers.md), the project's rules and client
   feedback (`bh note list --kind rule`, `--kind client_feedback`), and the strategy
   (`bh strategy show <id>`).

## What each class sets in motion

The same rules run whether the engine, a person or an agent sets the class:

| Class                   | The engine does                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsubscribe`           | adds the sender's address to dnc (`unsubscribed`), stops the lead (`stop_reason = unsubscribed`), cancels unsent steps; set by a person or a session, it waits 60 s first (`bh triage undo <id>` takes it back)                                                                                                                                             |
| `out_of_office`         | pauses the lead until the day after `--return`; no date, or one over 90 days out, pauses a week from the reply. If ingest had stopped the lead for this note, its steps come back, unless a person also wrote in the lead's threads or the contact is live elsewhere |
| `not_now`               | stores `--follow-up` as `follow_up_on`; nothing is scheduled until someone runs `bh reengage`                                                                                                                                                                        |
| `interested`, `meeting` | only when the engine classified: an urgent task "Answer <lead>" for the person who launched the strategy, done when a reply is sent                                                                                                                                  |
| everything else         | nothing beyond the stop ingest already made (a person may put the lead back: `bh lead resume`, step 5)                                                                                                                                                              |

Changing a class does not undo the earlier one's effects: moving away from `unsubscribe` leaves the
dnc row (a person removes it with `bh dnc remove <id>`), moving away from `out_of_office` leaves the
pause.

## Procedure

For each reply in `bh inbox`, oldest first; positives (`interested`, `meeting`) before the rest when
there are many:

1. **Read the thread** when the class is not obvious from the reply alone, and always before
   drafting: `bh thread <threadId>`. It shows every message both ways and our replies in any state;
   a draft may already exist.
2. **Decide the class** against references/classes.md. Resolve dates against the reply's day in the
   lead's time zone: `--follow-up` for `not_now` (the first day of a named month or quarter, the next
   occurrence), `--return` for `out_of_office` (the first day back).
3. **Triage**:
   - confirm: `bh triage <id> --class <same class> --note "<one line>"` — keeps the engine's
     follow-up date and does not pause an away lead again; add `--follow-up` / `--return` only to
     change the date (the rules then run again with it);
   - correct: `bh triage <id> --class <new class> [dates] --note "<what they said that matters>"`;
   - no class at all (the classifier failed three times) and nothing to act on:
     `bh triage <id> --note "<why>"` marks it handled. On a reply that has a class, leaving out
     `--class` marks it handled with its class and dates as they are.
     The note is one sentence for the salesperson: a time, a name, a condition. No advice.
4. **Answer if it needs one** (references/answers.md says which classes get none):
   `bh reply draft <threadId> --body-file <path> --note "<for the approver>" [--send-at <iso>]
   [--approve-by <iso>] [--sender <id>]`. A draft already waiting in the thread (`bh thread`
   shows it) is changed with `bh reply revise <replyId> --body-file <path> --note "<what changed>"`,
   which keeps the old version — never a second draft beside it. A person can ask for a rewrite in
   the web app or with `bh reply rewrite <replyId> --ask "<what to change>"`; a server-agent run
   then does it.
   Write the body to a file first; `--body` for one-liners. Set `--send-at` when the answer should
   land in the lead's working hours (their time zone, not ours) or when they asked for a moment
   ("write me Monday"); leave it off otherwise and it goes as soon as it is approved. Set
   `--approve-by` when the draft goes stale (offered slots): approval is refused after it.
   `--sender` signs it as another sender than the lead's. Only email
   threads take replies for now; for a LinkedIn thread open a task for a person.
5. **Follow-ups** (a person's token; a server agent opens a task instead, below):
   - `not_now` with a date: `bh reengage <inbound message id> [--on <yyyy-mm-dd>]` makes a new
     enrollment in the same strategy starting that day, with the same plan. Its copy is written
     like any other (`copywriting` skill, `bh copy queue` / `bh copy write`) with this thread as
     context, before it starts. No date given: triage with a `--note`; there is nothing to schedule.
   - `referral` with a named person: `bh refer <inbound message id> --email <e> [--first-name]
[--last-name] [--title]` adds the colleague at the same company, enrolled in the same
     strategy, with `referred_by`; their first message names who referred us. Named without an
     address: find it the usual way (`email-finding` skill), then refer.
   - Both refuse a contact on dnc or already live in a strategy; the error says which.
   - `acknowledgement` or `other` that stopped the lead (`leadStatus` `stopped`) although it needed
     nothing ("thanks, got it", a ticket receipt): `bh lead resume <enrollment-id>` (the
     `enrollmentId` in `bh thread`) puts the lead back — its cancelled steps come back and it goes
     on. Only for a lead stopped by a reply; refused for any other stop.
6. **Bounces are not replies.** A bounced address is replaced through `bh address check` /
   `bh address replace` (the engine opens a task for it); never from the inbox.

`<inbound message id>` — what `bh reengage` and `bh refer` take — is the reply's `id` in `bh inbox`
(a `thread_messages` row), not the thread's id or a draft's.

## Approval: a person only

- `bh replies` lists drafts; `bh replies --status approved|sent|failed` the rest.
- `bh reply approve <id> [--body "<final text>"]` sends it (at `send_at`, or now). Only a person's
  token can approve; read the thread and the note first, and edit the body in the same call if it
  needs a change.
- `bh reply discard <id>` withdraws a draft, an approved reply not yet sent, or a failed one.
- A failed reply (`bh replies --status failed`, `lastError`) is usually a disconnected mailbox; fix
  the mailbox, then draft again.

## The server agent

A scheduled agent may: classify and re-classify, mark handled, draft replies, add notes, questions,
tasks, hypotheses and their evidence, check and replace bounced addresses, offer slots (`bh slots offer`), and book or move a
meeting to a slot that was offered to this lead and is still held (references/answers.md,
Meetings). It may not: start a hypothesis's test or change how a running one is judged, approve or send, `bh reengage`, `bh refer`, `bh lead resume`, remove dnc,
enroll, book any other time, or cancel a meeting. Where one of those is due, open a task for the
person who launched the strategy:

- their email: `bh sql "select u.email from threads t join enrollments e on e.id = t.enrollment_id join strategies s on s.id = e.strategy_id join users u on u.id = s.launched_by where t.id = '<threadId>'"`;
- `bh task open --title "Re-engage <lead> on <date>" --assignee <email> --due <iso> --done-when "a re-engagement is scheduled" --body "<inbound message id>, what they said"`;
- likewise "Refer <colleague> from <lead>" (with the name and address), "Resume <lead>: the reply
  needed nothing" (with the enrollment id), "Approve the reply to <lead>" with `--priority urgent`
  for a positive answer with offered slots.

The engine already opened an urgent task for every positive reply it classified; do not duplicate
it. Draft the answer so the task's owner only has to approve.

## Record

- The class and note on every reply (step 3) are the record; nothing else per reply — except a
  reply that bears on an open hypothesis, which goes into its evidence: `bh hypothesis update <id>
  --add-evidence "<lead, title, company, class: what they said> (thread <id>)"`. That is evidence,
  not a verdict: the verdict is read over the volume the hypothesis's threshold names
  (`strategy-and-plans`, Health). An idea the replies suggest that nobody is testing yet:
  `bh hypothesis add` (it stays `proposed` until a person starts it).
- What the replies teach beyond one lead (a recurring objection, an angle that draws "not now",
  a question the brief cannot answer): `bh note add --kind insight`; a fact we need from the client:
  `bh question add --body "<question>" --note "<which lead asked>"`.
- `bh session end --summary "<triaged N: classes; drafts waiting for approval and what they
offer; re-engagements and referrals made or handed to whom; what to watch>"`.

## Common mistakes

- **Correcting to `out_of_office` without `--return`**: the lead is paused a week from the reply
  instead of until the day they are back. Read the return date from the reply's text.
- Classing a polite unsubscribe ("I'd rather not get any more of these") as `not_interested`: the
  unsubscribe outranks it, and a miss keeps writing to someone who asked us to stop.
- Classing an away note that names a colleague as `referral`: it stays `out_of_office`.
- An unsubscribe from a different address than the one we wrote to: the engine blocks the address
  that wrote; add the contact's own address too (`bh dnc add --kind email`), and the domain
  (`--kind domain`) when they speak for the company ("remove all of us").
- Drafting an answer to a "thanks, got it" or to a no; arguing with a decline.
- Inventing a price, a customer, a date or a feature in a draft; offering times `bh slots` does not
  list; offering them without `bh slots offer` (someone else may be offered the same hour);
  sending a booking link.
- Writing the approver's note into the body.
- Leaving positives for later: they go first, every run.
