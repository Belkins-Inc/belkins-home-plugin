---
name: call-scripts
description: How to write the calling script and the brief for every person on a call list (what the caller says to this person, in the language they are called in, and why we call them now) and hand both to the Belkins Dialer with bh calls create / bh calls briefs. Use when a call list is being made, when numbers were found for people a caller will dial, when a caller or a client lead asks for call scripts, when a strategy's call-step list gains people, or when a list's scripts need changing.
---

# Call scripts

A caller in the Belkins Dialer sees two texts of ours on the call:

| Field on the list row | In the dialer | Shown | Limit |
| --- | --- | --- | --- |
| `script` | the lead's **calling script** | first, large, line breaks kept: read aloud mid-call; also on the lead's card | 10,000 characters |
| `reason` | the **brief** of their membership of this list | under the script, only on calls from this list | 2,000 characters |

The script is what to say to this person. The reason is one or two lines on why we call them now
(the signal, what they already got from us), for the caller's eyes only. Both are plain text: no
markdown, no links the caller cannot use. Write them for **one named person**, like copy: a script
the caller could read to anyone is the template we were asked not to send.

## Read first

1. `bh brief` — rules (`kind = rule` notes) and exclusions bind scripts as they bind copy; the
   offer, proof, and what the meeting is for.
2. When the people are on a strategy: `bh strategy show <id>` — its `brief` (offer, tone, avoid,
   proof), each persona's `angle`, the steps' `guidance`. A call step's guidance is the
   skeleton every script of that list follows.
3. `bh note list --kind client_feedback` — what the client liked or banned.
4. The people and what is known of them (one select, no trailing semicolon):

   ```sql
   select x.position, x.contact_id, c.first_name, c.last_name, c.title, c.country, c.timezone,
     c.facts as contact_facts, co.name as company, co.domain, co.facts as company_facts,
     (select jsonb_agg(sc.signal) from segment_companies sc
       where sc.company_id = co.id and sc.signal <> '{}'::jsonb) as signals,
     x.reason, x.script
   from call_list_contacts x
   join contacts c on c.id = x.contact_id
   left join companies co on co.id = c.company_id
   where x.list_id = '<list-id>'
   order by x.position
   ```

   For people not on a list yet, select the same columns from `contacts` by id.
5. What they already got from us: `bh calls show <list-id>` gives each person's `strategy`,
   `emailsSent` and `lastSubject`. A script for someone who got three emails says so ("I wrote to
   you about …"); one for a cold contact does not pretend otherwise.

## The language

Write in the language the person is called in: their country (`country`, else the company's), not
the client's. Germany, Austria and German-speaking Switzerland are German: `Sie` throughout, never
`du`. Do not guess a gender for `Herr` / `Frau`: open with the full name ("Guten Tag, spreche ich
mit Anna Becker?") and let the caller carry on from how they answer. The section labels (below) stay
in English for the caller; every line they say is in the call's language. When the brief names a
language for calls, that wins.

## The shape of a script

Spoken, not written: short sentences, one idea each, nothing the caller has to parse aloud. From
the opener to the ask it reads in under 40 seconds. Blocks in this order, each under its label on a
line of its own, a blank line between blocks:

```
OPENER
<who is calling and from where, one sentence; ask for 30 seconds>

WHY YOU
<the one specific thing we know about them or their company, from the signal or the facts>

QUESTION
<one open question about that, the one the strategy wants answered>

VALUE
<one line of what the client does for companies like theirs, with the proof the brief gives>

ASK
<the meeting: what it is, how long, two concrete options ("Tuesday or Thursday morning?")>

IF THEY SAY
- <the 3 or 4 objections this persona is likeliest to raise>: <one or two sentences, ending in a question>

VOICEMAIL
<15 seconds: name, the one reason, call-back number or "I'll send you an email">
```

- **Specific or silent.** WHY YOU uses only what the facts, the signal or the brief say. With no
  signal, it names the person's role and the problem the brief says that role has, and makes no
  observation about their company.
- No invented numbers, clients or results; proof comes from the brief word for word.
- The house rules of copy apply where they make sense aloud (no burned phrases, no hype, no "How
  are you?", no dashes as punctuation):
  [../copywriting/references/house-rules.md](../copywriting/references/house-rules.md).
- The reason: one or two lines for the caller ("Hiring 4 drivers in Munich since October; got 2
  emails from Anna, no reply"), never a second script.

## Procedure

1. **Sample gate.** Write the script and reason for **one person per persona** first and show them
   to the person you work with as plain text. Take their edits into the strategy's call-step
   `guidance` (`bh plan set`) when the people are on a strategy, and write the samples again until
   they approve. Then write the rest.
2. Put the batch in a file, one object per person (JSON array or JSONL):
   `{"contactId","reason","script"}`, with `"phone"` too when making a list and a number other than
   the first live one should be dialled.
3. A new list: `bh calls create --name <n> --file rows.json [--note <t>]` (a person only). In a
   project linked to a dialer workspace the list goes to the dialer with the scripts and briefs.
   A list that exists (a call-step list, one made earlier, scripts to fix):
   `bh calls briefs <list-id> --file rows.json`; `null` clears a field, a field left out stays.
4. Read the answer's `dialer`: `scripts` and `briefs` sent, `skipped` (people the dialer left out
   of the list, so there is no lead to write to; `bh calls show` says why per person), `error`
   (send the same file again: it picks up where it stopped).
5. `bh calls show <list-id>` shows each person's `reason` and `script` as they stand.

A strategy's call-step list (`<strategy> (call steps)`) gains people as they reach the step, each
with the step's guidance as their reason. Find those still without a script in the select above
(`x.script is null`) and write theirs with `bh calls briefs`.
