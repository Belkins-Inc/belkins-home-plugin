---
name: call-scripts
description: How to write a strategy's base calling script (kept on the strategy beside its emails and LinkedIn) and, from it, the script and the brief for every person on a call list (what the caller says to this person, in the language they are called in, and why we call them now), and hand them to the Belkins Dialer with bh strategy update / bh calls create / bh calls briefs. Use when a strategy gets a call step or starts calling, when a call list is being made, when numbers were found for people a caller will dial, when a caller or a client lead asks for call scripts, when a strategy's call-step list gains people, or when a script needs changing.
---

# Call scripts

A caller in the Belkins Dialer sees two texts of ours on the call:

| Field on the list row | In the dialer | Shown | Limit |
| --- | --- | --- | --- |
| `script` | the lead's **calling script** | first, large, line breaks kept: read aloud mid-call; also on the lead's card | 10,000 characters |
| `reason` | the **brief** of their membership of this list | under the script, only on calls from this list | 2,000 characters |

Both start from the **base** a strategy keeps (`callScript`, beside its emails and LinkedIn): the
script every person of the strategy is called from, its blocks and wording in the call's language,
with slots for what changes per person. The engine sends the base, slots filled, for each lead its
call step lists, so a caller always has a script; a script written for one person replaces it.

The script is what to say to this person. The reason is one or two lines on why we call them now
(the signal, what they already got from us), for the caller's eyes only. Both are plain text: no
markdown, no links the caller cannot use. Write them for **one named person**, like copy: a script
the caller could read to anyone is the template we were asked not to send.

## Read first

1. `bh brief` — rules (`kind = rule` notes) and exclusions bind scripts as they bind copy; the
   offer, proof, and what the meeting is for.
2. When the people are on a strategy: `bh strategy show <id>` — its `callScript` (the base every
   script of that strategy is written from), its `brief` (offer, tone, avoid, proof), each
   persona's `angle`, the steps' `guidance` (a call step's is the brief for its list).
3. `bh note list --kind client_feedback` — what the client liked or banned.
4. The people and what is known of them (one select, no trailing semicolon):

   ```sql
   select x.position, x.contact_id, c.first_name, c.last_name, c.title, c.country, c.timezone,
     c.facts as contact_facts, co.name as company, co.domain, co.facts as company_facts,
     (select jsonb_agg(sc.signal) from segment_companies sc
       where sc.company_id = co.id and sc.signal <> '{}'::jsonb) as signals,
     x.reason, x.script, x.briefed_via
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

## The base on the strategy

A strategy that calls has a base before its first lead reaches the call step, and before the first
list of its people is made by hand. Write it in the shape below, in the call's language, from the
brief and the personas' angles: the blocks every person gets, with these slots where the person
changes it (the engine refuses any other `{…}`):

| Slot | Filled with | When the contact lacks it |
| --- | --- | --- |
| `{first}` | first name | `[first name]` |
| `{last}` | last name | `[last name]` |
| `{full}` | first and last name | `[name]` |
| `{company}` | company name | `[company]` |
| `{title}` | job title | `[title]` |

What the caller fills in aloud stays in brackets (`[your name]`, `[your number]`). WHY YOU in a base
names the role and the problem the brief says that role has; the specific observation is what a
script written for one person adds. Show the base to the person you work with, take their edits,
then set it: `bh strategy update <strategy-id> --file base.json` with `{"callScript": "..."}`
(`null` takes it off). Leads already on the call list keep what they have; the base reaches those
listed after, and `bh calls briefs` changes the others.

## Procedure

1. **Sample gate.** Write the script and reason for **one person per persona** first and show them
   to the person you work with as plain text, beside the strategy's base. Take edits that hold for
   everyone into the base (`bh strategy update`), and write the samples again until they approve.
   Then write the rest, each from the base.
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
with the step's guidance as their reason and the base, filled in, as their script. Find those
still on the base (`x.briefed_via = 'engine'` in the select above, or `x.script is null` when the
strategy had no base) and write theirs with `bh calls briefs`.
