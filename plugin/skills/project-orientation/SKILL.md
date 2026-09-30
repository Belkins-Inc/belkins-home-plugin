---
name: project-orientation
description: Opens and closes every working session on a client project — reads the project's state with `bh brief`, decides what to do first, keeps project memory (notes, client questions, hypotheses, tasks) and hands over with `bh session end`. Use at the start of any session on a project, whenever the current state of a project is in doubt, and before stopping work.
---

# Project orientation

The database is the only memory. Teammates, other sessions and the server agent work the same
project before and after you; nothing in your head, local files or chat survives. Never assume a
previous session did or did not do something — read it.

## Start of session

1. `bh whoami` — confirm the token works and whose it is. A `scheduled_agent` token may classify,
   draft, take notes, open tasks, check and replace addresses; it may not enroll, launch or pause,
   remove dnc, approve replies or set goals. If the work needs one of those, open a task for a person.
2. `bh use <slug>` for the project the person named (`bh projects` lists them). It holds for this
   Claude Code session only — the person may run several sessions side by side, one per client, and
   each keeps its own; nothing another session picks reaches this one. If they did not say which
   project, ask rather than guess — a client named in passing, a project from an earlier session or
   the only one you know is not a pick; a session that has not picked is refused, never defaulted.
   Once `bh use` answers, name the project back in one line — its name and slug ("Working on Pepper
   (pepper).") — so a wrong pick is caught before anything is done on it.
   When they move to another project mid-session, `bh use` it again. `bh use` with no slug says
   which project is current; `--project <slug>` reads another for one command without switching.
3. `bh brief` — read all of it before doing anything. Then read the parts that matter for today in
   full (see "Where to look next").

## Reading `bh brief`

| Part | What it is | What to do with it |
| --- | --- | --- |
| `project.brief` | Markdown: client, product, ICP, what we say | The source for every judgement. Empty or thin → the `client-brief` skill comes first. |
| `goal` | This month's meeting target: `target`, `counts` (qualified or held), `achieved`, `scheduled` | `null` = no goal this month. Behind pace → pipeline work (sourcing, enrolling) outranks polish. |
| `goalsAhead` | The goals set for the months after this one, soonest first: `month` (YYYY-MM), `target`, `counts`, `scheduled` | Late in a month, read the next month's goal here. No goal this month and none ahead → ask a person to set one (`bh goal set` is person-only). |
| `rules.exclusions` | The client's hard rules (`country`, `industry`, `business_model`, `employees_below/above`, `rating_above`, `other`) | `bh companies judge` refuses to qualify a company that breaks one — except `other`, which is prose nobody checks but you. |
| `rules.notes` | Notes of kind `rule` | Obey them like exclusions: copy rules, channel rules, "never mention X". |
| `decisions` | Notes of kind `decision` | Settled. Do not re-open without new evidence; if you do, supersede (below). |
| `todos` | Notes of kind `todo` | Loose ends a session left. A todo that needs a person by a date belongs in a task instead. |
| `insights` | `insight` and `client_feedback` notes | What worked, what the client said. Read before copy, segments, triage. |
| `openQuestions` | Client questions `open` (not sent yet) or `asked` (waiting) | Anything blocked on the client. An `open` one nobody sent is a gap: make sure a person sends it. |
| `openHypotheses` | Ideas worth testing, `testing` first, then `proposed`: the claim, what tests it (segment, persona, strategy), how it is judged (`metric`, `threshold`), who started the test and when | A `testing` one: read its results against the threshold before changing what tests it. A `proposed` one is not approved — nothing is bought, sourced or enrolled for it until a person moves it to `testing`. |
| `openTasks` | Tasks for people, by due date | Check each: if its `done_when` is now true, close it (`bh task close <id> --note …`). Do not duplicate one. |
| `queues.untriaged`, `oldestUntriagedAt` | Replies waiting for triage | Anything older than a few hours goes first: lost replies are the costliest failure seen. |
| `queues.draftsToApprove` | Reply drafts waiting for a person | Old drafts → a task to the approver, `--priority urgent` if slots or dates are at stake. |
| `queues.stalled` | Leads that cannot move | `bh sql` on `stalled_enrollments` for the reasons. |
| `queues.needsCopy` | Steps with no copy | A lead waits while its step has no copy — write it (`copywriting` skill). |
| `queues.activeLeads` | Leads in flight | Compare with the strategies' `target_active`. |
| `channels` | Mailboxes and LinkedIn accounts with a `problem` | Disconnected or failing reads → a task to a person; sending and reading are stopped for that channel. |
| `lastSessions` | The last five hand-overs, newest first | What was done, left, to watch. Pick up "left" and check "watch". |

Test and noise data — a strategy, reply or task made by the team while testing the engine (internal
addresses, "test" or "M1" in the name) — is not client work: leave it as it is and name it in the
hand-over, so nobody triages or reports it.

Order of work when several things are open: untriaged replies and approvals with a deadline →
broken channels → stalled leads and missing copy → open tasks whose `done_when` you can check →
pipeline below target → everything else.

## Where to look next

`bh sql` reads anything (one `select`, read-only, 10 s, 200 rows unless `--limit`). It is not scoped
to the project: filter with `@project`, which `bh sql` replaces with the current project's id, quoted —
`bh sql "select … from spend where project_id = @project and operation = 'llm'"`. Double-quote the
query for the shell and single-quote SQL strings inside it. Recipes for
the views — `inbox_queue`, `stalled_enrollments`, `goal_progress`, `strategy_segment_usage`,
`source_usage`, `segment_usage` — and for recent events and spend are in
[references/sql-recipes.md](references/sql-recipes.md). The schema the engine runs is
`references/schema.sql` beside this skill in the published plugin; in a checkout of the platform it is
`db/schema.sql`.

Other reads: `bh note list [--kind k] [--all]`, `bh questions --status all`,
`bh hypothesis list --status all` (settled and parked too), `bh task list`,
`bh strategies`, `bh strategy show <id>`, `bh segments`, `bh sources`, `bh personas`, `bh inbox`,
`bh spend`.

## Keeping project memory

Write down, as you go, anything the next session would need. Free text in chat is lost.

**Notes** — `bh note add --kind <k> --title <t> [--body <b>]`:

- `rule` — a constraint that must hold on every future action ("no emails mentioning pricing",
  "LinkedIn only for the DACH segment"). A hard rule a tool can check belongs in `bh exclusion add`
  instead (see `segment-design`), with a rule note only for what an exclusion cannot express.
- `decision` — something chosen, with the why in the body ("dropped segment X: 2 of 40 qualified").
- `insight` — something learned from data ("step 2 angle pain:hiring gets 3x the replies").
- `client_feedback` — what the client said, verbatim where possible, with who and when in the body.
- `todo` — a loose end with no person or date attached. If a person must act, open a task instead.

Titles are the claim itself, not a topic ("Canada is in scope from Oct 1", not "Canada"). Notes are
never edited: to change one, add the new note with `--supersedes <old-id>[,<id>]`; the old one stays
as history and drops out of `bh brief`. Find ids with `bh note list --kind <k>`.

**Client questions** — anything we are waiting to hear from the client (a DNC/customer list, a
yes/no on a market, meeting availability): `bh question add --body "<question>" --note "<what
depends on it>"`, plus `--asked` if it has already gone to the client. Later `bh question asked
<id>`, `bh question answer <id> --body "<their answer, verbatim>"`, or `bh question drop <id>`. An
answer that changes how we work also becomes a `decision`, `rule` or exclusion.

**Hypotheses** — an idea worth testing that is not yet how we work: a buyer we think is someone
other than the brief says, a vertical we have not tried, a strategy drafted but not launched.
Anything proposed beside the main line becomes one — not a note, not a sentence in chat:

```
bh hypothesis add --claim "<a sentence that can turn out false>" --evidence "<why: what was seen, with ids and figures>" \
  [--segment <id>] [--persona <id>] [--strategy <id>] [--metric "<what is measured>" --threshold "<what confirms it>"]
```

- The claim is the claim ("At carriers with 5–30 terminals operations buys fuel, not procurement"),
  not a topic ("Carrier buyers"). It starts `proposed`; `--status parked` sets one aside.
- **A test starts only when a person moves it to `testing`** (`bh hypothesis update <id> --status
  testing`, or Start test on the project's Hypotheses screen): it spends or changes who we write
  to. A scheduled agent's token is refused, and so is a test without `--metric` and `--threshold`.
  Writing it down is free; building a persona, sourcing or enrolling for it before then is not. If
  it should start, open a task for a person.
- While it runs, add what bears on it: `bh hypothesis update <id> --add-evidence "<what was seen,
  with ids>"` (a dated line). Only a person changes how a running test is judged.
- Settle it on the figures: `--status confirmed|rejected --verdict "<what the results showed, with
  the figures and their base>"`. What follows — a decision note, a rule, a segment archived — is
  recorded where it belongs.
- Not a hypothesis: a settled choice (a `decision`), a fact only the client can give (a question —
  a hypothesis that turns on the answer names the question's id in its evidence), what one step of
  a plan is expected to prove (the step's `hypothesis`, `strategy-and-plans`).

**Tasks** — when only a person can do something (approve, launch, set a goal, reconnect a mailbox,
send a question to the client, remove dnc): `bh task open --title "<what, concretely>" --assignee
<email> [--due <iso>] [--priority urgent] --done-when "<how an agent can tell it is done>"
[--body <context>]`. The engine posts it to Slack and nudges until it is closed. `--done-when` must
be checkable from the database ("replies 01…, 02… are approved", "question <id> answered"), so a
later session can close it with `bh task close <id> --note "<what you saw>"` — or `--status
cancelled` when it no longer applies. Title with the count and the deadline ("Approve 4 drafts:
offered slots start 14:00 UTC").

**Defects in the tooling** — `bh` or the engine answering wrong, a provider behaving otherwise than
its reference says, a skill that sent you the wrong way. Notes are about the client, so a defect is
never a note, and it is recorded the moment you find it, not at the end: a finding kept in chat is
lost. It goes where the people who fix the tooling read — a GitHub issue:

```
gh issue create --repo Belkins-Inc/belkins-home-plugin --label bug --title "<the defect, as a claim>" \
  --body "<where / what happened / change>"
```

or, in a session working in the repository, an entry in `docs/skills-fixes.md` in the same shape.
**Where**: the file, command or endpoint. **What happened**: what you ran and what came back, with
numbers, ids and the date — enough to reproduce it. **Change**: what should be different. Then
carry on with a workaround, and name the issue in the hand-over.

## End of session

`bh session end --summary "<text>"` — mandatory, even after a short session. Three parts, in plain
sentences with ids and numbers:

- **Done** — what changed in the database (segments, sources, companies judged, enrollments, copy,
  triage, notes), with counts.
- **Left** — what the next session should pick up, in order, and what it is waiting on (question or
  task ids).
- **Watch** — what might go wrong or needs a check on a certain day (an address check due, a
  deadline, a strategy near its health threshold, a source near exhaustion), and every tooling
  defect you recorded, with the workaround you used.

Before it: close tasks you saw done, supersede notes you contradicted, record any searches you ran
(`bh search record`), make sure every client question you thought of is in `bh question add` and
every idea worth testing is in `bh hypothesis add`, and add the session's results to the evidence
of the hypotheses they bear on.

## Common mistakes

- Starting work before reading `bh brief` to the end, or trusting the previous summary without
  checking the data it describes.
- Leaving facts that matter on a date (slots, return dates, promised invites) only in note text —
  that is a task with a due date, or a question.
- Editing a decision by writing a contradicting note without `--supersedes` — both then show.
- Opening a second task for something already in `openTasks`.
- Using `todo` notes for things a person must do by a date.
- An idea worth testing kept in a note title ("Hypothesis under test: …"), in chat or only in the
  hand-over — it is a hypothesis, with how it will be judged.
- Sourcing, enrolling or building a strategy for a hypothesis still `proposed`.
- Writing who did something into a note — attribution comes from the token automatically.
- A tooling defect left in chat or in a project note, where nobody who fixes the tooling reads it.
- A session summary like "worked on sourcing" — say what, how many, what is left.
