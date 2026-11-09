---
name: writing-answers
description: Your own Claude writes every answer to your leads and every follow-up copy waiting for you (`bh answers`) — on a schedule in the Claude desktop app, so it is done by the time you look. The server only classifies replies; nobody else writes them. Use when the scheduled task fires, when asked to write the waiting answers, when a person asked for an answer or a rewrite (in Slack, the web app or `bh reply rewrite`), and to set the schedule up on a new computer.
---

# Writing answers

The engine reads every reply and classifies it; its server agent confirms the class. Neither writes
a word to a lead: a run on the server knows nothing of the people it writes for, and its answers
read like it. You do — you run on the computer of the person whose leads they are, with their
memory of the project, the client and how they write. Every answer, every rewrite and every
follow-up's copy is yours, and a person approves each before it goes.

## Set up the schedule (once per computer)

In the Claude desktop app, a scheduled task runs this skill every 15 minutes while the app is open;
a run missed while it was closed runs when it opens. Create it with the scheduled-tasks tool
(`create_scheduled_task`), or in the app's Scheduled tab:

- `taskId`: `belkins-answers`; title: `Belkins answers`;
- `cronExpression`: `*/15 * * * *`;
- the working directory (create the task from a session opened there): the person's Belkins Home
  workspace (`~/work/belkins-home`, whose
  `.claude/settings.json` allows `Bash(bh *)` and writing under `clients/`), so the run asks for no
  permission — nobody is there to answer one (a workspace copied before 2026-11-02 lacks
  `"Edit(clients/**)"` in its `permissions.allow`: add it);
- `prompt`: `Use the belkins-home:writing-answers skill: run bh answers and write everything waiting.
  Never approve or send. End with one line: what you wrote, by project.`

Check `bh answers` works there first (`bh login` once per computer). Keep the app open on a working
day: a lead who wants to talk waits for the next pass, not for the morning.

## A pass

1. `bh answers`: what waits for this person, urgent first. Nothing → end with "Nothing waiting".
2. For each project in it, in that order — naming it on every command, `--project <project>`
   (a pass works several projects, so `bh use` holds none) — read what every answer is
   written from: `bh brief`, the rules and client feedback (`bh note list --kind rule`,
   `--kind client_feedback`), the client's answers (`bh questions --status answered`), and
   `inbox-triage`'s [references/answers.md](../inbox-triage/references/answers.md). Your own memory of
   this project and of how this person writes counts as much: use it.
3. Each item, by `kind` (bodies go to files under `clients/<project>/answers/`, then
   `--body-file`):
   - `reply` — a lead's reply with no answer. `bh thread <threadId>` (the whole thread, always).
     Untriaged (`bh inbox` lists it)? Triage it first (`inbox-triage`, Procedure). Then answer it
     (`bh reply draft <threadId> --body-file <path> --note "<for the approver>"`, with `--send-at`
     and `--approve-by` as `inbox-triage` says), or, when it needs none, `bh thread close
     <threadId> --note "<why>"`. Times and booking: references/answers.md, Meetings (`bh slots`).
     Colleagues still running at the company (`colleagues` in `bh thread`, `inThread` / `inDraft`
     above all): name them in the draft's `--note` for the approver, who pauses them
     (`inbox-triage`, Procedure 1); never pause them yourself.
     It goes under "Re: " and the lead's last subject; when that subject says what the project's
     rules keep out (a client's name), add `--subject "<s>"` with one that does not.
     A fact only the client has: a holding answer, and the question — tie the thread to one already
     waiting that asks the same (`bh questions`, `bh question link <id> --thread <threadId>`), else
     `bh question add --thread <threadId> --body "<question>"` (references/answers.md says how to
     word it); the thread comes back as `client` once it is answered.
   - `ask` — the person asked for this (`ask` is what they said; `askedBy` who). `draftId` set: a
     new version of that draft, changing only what was asked (`bh reply revise <draftId>
     --body-file <path> --note "<what changed>"`). No draft: write the answer, as they asked.
   - `client` — the client answered a question (`question`, `answer`) the thread waited for.
     Write it in: revise the waiting draft (`draftId`), or draft the follow-up when the holding
     answer went already.
   - `copy` — a follow-up plan (re-engagement, referral) has `steps` messages with no copy:
     `copywriting` skill (`bh copy queue <strategyId>`, `bh copy write`), with the lead's thread as
     context. A step someone else wrote in the meantime (the teammate who referred the lead, say)
     is refused with who and when: leave theirs, never `--replace` it on a pass.
   Writing or revising in a thread settles what waited there; an item still listed on the next pass
   was not done.
4. **Never approve, send or discard.** Your token is a person's and could: the person approves in
   Slack or the web app, where the draft now waits for them with its buttons.
5. End with one line: what you wrote, by project (`acme: 3 answers, 1 rewrite; globex: copy for 4
   steps`). No session summary per pass — it is not a working session.

## Learning from the approver

When the person edits a draft before approving it, rewrites it, or tells you in a session what was
wrong, keep the lesson: one that holds for the project goes to its rules (`bh note add --kind rule`)
so every teammate's Claude writes the same way; one about this person's own voice stays in your
memory. What went (`bh thread <threadId>`) against your versions (`bh reply versions <replyId>`)
shows what they changed.
