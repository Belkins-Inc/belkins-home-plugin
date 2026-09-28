# Strategy JSON (`bh strategy create --file` / `bh strategy update <id> --file`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | required on create | |
| `brief` | markdown | null | Offer and call to action, tone, avoid, approved proof — the strategy level of Messaging |
| `sendDays` | ISO weekdays 1–7 | `[1,2,3,4,5]` | days a message may go, in the lead's time zone |
| `windowStart` / `windowEnd` | `"HH:MM"` | `09:00` / `17:00` | the lead's local sending window |
| `dailyLimit` | int or null | null | first touches per day across the strategy; null = mailbox limits only |
| `maxPerCompany` | int ≥ 1 | 2 | enrolled contacts per company, counted over every enrollment in the strategy |
| `targetActive` | int or null | null | leads to keep in flight; below it the engine opens a task |
| `startSpreadDays` | int ≥ 1 | 3 | a batch's first touches spread over this many days |
| `companyStaggerDays` | int ≥ 0 | 2 | the next person at a company starts this many days after the previous |
| `catchAllPolicy` | `hold` / `linkedin_only` / `send` | `hold` | what to do with catch-all addresses |
| `segments` | segment ids | | replaces the list |
| `personas` | `[{personaId, maxPerCompany?, angle?}]` in priority order | | replaces the list; position = array order |
| `senders` | sender ids | | replaces the list; each brings its mailboxes and LinkedIn account |

Ids must belong to the current project (`bh use <slug>` in this session), or the call is refused.

## Choosing the numbers

- `sendDays`: weekdays unless the client's market works weekends.
- Window: 08:00–17:00 local works for most B2B; narrow it for executives only if the client asks.
- `maxPerCompany`: 2 for companies under ~200 people, 3 above; one per persona via the persona's
  `maxPerCompany` when two roles would read the same email.
- `dailyLimit`: leave null while mailbox limits bind; set it to pace a small market (so the segment is
  not burned in a week) or to hold a new strategy to a test batch.
- `targetActive`: roughly what the senders can carry — (active mailboxes × daily limit × send days
  in a plan's length) ÷ steps per lead, then round down; halve a fresh mailbox's share for its first
  twelve sending days (the ramp). The full arithmetic is the skill's "Capacity" section; record it
  in a decision note.
- `startSpreadDays`: 3–5 so a batch does not land on one morning.

## Example

```json
{
  "name": "Support leaders — low-rated DTC brands (US)",
  "brief": "**Offer and call to action.** Outsourced tier-1 support that answers within an hour; ask whether faster replies are on their list this quarter.\n\n**Tone.** Plain, peer to peer, short. No hype.\n\n**Avoid.** Pricing, naming competitors, anything about layoffs.\n\n**Proof.** Acme Outdoor cut first-reply time from 19 h to 45 min in six weeks (client-approved, may be named).",
  "sendDays": [1, 2, 3, 4, 5],
  "windowStart": "08:30",
  "windowEnd": "16:30",
  "dailyLimit": null,
  "maxPerCompany": 2,
  "targetActive": 60,
  "startSpreadDays": 4,
  "companyStaggerDays": 2,
  "catchAllPolicy": "hold",
  "segments": ["<segment-id>"],
  "personas": [
    {
      "personaId": "<head-of-support-id>",
      "maxPerCompany": 1,
      "angle": "Pain: reviews complain about slow replies and it shows on Trustpilot. Thesis: faster first replies without hiring. Proof: Acme Outdoor, 19 h to 45 min."
    },
    { "personaId": "<coo-id>", "angle": "Pain: support cost per ticket rising with volume. Thesis: flexible capacity for peaks. Proof: Acme Outdoor." }
  ],
  "senders": ["<sender-id>"]
}
```
