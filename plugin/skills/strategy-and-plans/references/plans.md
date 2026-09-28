# Plan templates (`bh plan set <strategy-id> --file plans.json`)

Replaces every template of the strategy; refused once any lead's plan was copied from them.
Positions follow array order; step 1's `delayDays` is always 0.

## The ask ladder (write it into `guidance`)

| Place | Asks | Guidance pattern |
| --- | --- | --- |
| first | interest, low friction | open on the signal, one line of relevance, ask whether it is worth a word |
| middle | a reason or a proof, soft ask | a different side of the offer: proof, a number, a consequence; ask softly |
| last | the goal directly, or a polite close | name the goal (a call), or close and leave the door open |
| only step | the goal directly | no polite close; it is a first approach |

`guidance` is an instruction to the writer, not copy: what the step is for, what to open on, what
argument to make, what to ask. It never names a person and never says who signs. It may reference
only steps sure to have gone out. It carries no em or en dash (`bh plan set` refuses one): the writer
lifts its wording, and copy with a dash is refused. Quoted lines the writer uses word for word are
written as they should be sent.

## email_only (default shape)

```json
{
  "plans": [
    {
      "appliesWhen": "email_only",
      "steps": [
        { "channel": "email", "guidance": "Open on the company's signal (e.g. their review rating or complaint theme). One sentence on why it matters to this role. Ask at low friction whether faster replies are a priority.", "hypothesis": "The signal alone earns a reply from a third of the interested." },
        { "channel": "email", "delayDays": 3, "guidance": "In the same thread. Do not repeat the opening. Give the approved proof in one or two sentences and ask softly if a similar result would matter.", "hypothesis": "Proof converts the curious." },
        { "channel": "email", "delayDays": 4, "guidance": "In the same thread. A different angle: the cost of slow replies at their volume. One question." },
        { "channel": "email", "delayDays": 5, "guidance": "Last touch, in the same thread. Ask directly for a 20-minute call, or close politely and leave the door open.", "hypothesis": "A direct ask recovers the undecided." }
      ]
    }
  ]
}
```

## email_and_linkedin

```json
{
  "appliesWhen": "email_and_linkedin",
  "steps": [
    { "channel": "email", "guidance": "As step 1 of email_only." },
    { "channel": "linkedin_invite", "delayDays": 1, "guidance": "Connection note, under 300 characters. Asks for nothing but the connection; does not pitch; does not mention the email." },
    { "channel": "email", "delayDays": 3, "guidance": "Proof step in the email thread. Must not mention LinkedIn." },
    { "channel": "linkedin_message", "anchor": "invite_accepted", "condition": "invite_accepted", "delayDays": 1, "maxWaitDays": 7, "guidance": "Thanks for connecting. One sentence of value, one soft question. Stands on its own; does not rely on the emails having arrived." },
    { "channel": "email", "delayDays": 4, "guidance": "Last touch. Direct ask for a call or a polite close. References only the earlier emails." }
  ]
}
```

A lead whose invite is never accepted skips the LinkedIn message after `maxWaitDays` and continues
with the next step. A fallback step for that case carries `"condition": "invite_not_accepted"`.

## linkedin_only

```json
{
  "appliesWhen": "linkedin_only",
  "steps": [
    { "channel": "linkedin_invite", "guidance": "Connection note under 300 characters, opening on the signal. No pitch, no ask beyond connecting." },
    { "channel": "linkedin_message", "anchor": "invite_accepted", "condition": "invite_accepted", "delayDays": 1, "maxWaitDays": 10, "guidance": "Interest question in two or three sentences." },
    { "channel": "linkedin_message", "delayDays": 4, "condition": "invite_accepted", "guidance": "Proof and a direct, polite ask for a call." }
  ]
}
```

## Changing plans later

- One step's `guidance` or `hypothesis`, frozen templates too: `bh plan step <strategy-id> <step-id>
  --file step.json` with `{"guidance": "…"}`. Messages not yet written follow it; written ones keep
  their copy (rewrite them through `bh copy`). Step ids are in `bh strategy show`.

- Templates frozen, a lead's plan wrong: there is no `bh` command to edit one lead's messages;
  open a task for a person (`bh task open`) naming the enrollment and the change.
- A new shape of plan: create a new strategy and enroll into it (one contact, one live strategy).
