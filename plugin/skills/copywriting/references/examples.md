# Examples

Illustrative only: the client, proof and facts below are invented for the example. In real copy
every fact comes from the brief, the persona angle, the signal or the lead's facts.

Context: brief offers outsourced tier-1 support; approved proof "Acme Outdoor cut first-reply time
from 19 h to 45 min in six weeks". Persona angle (Head of Support): reviews complain about slow
replies. Signal: Trustpilot 2.9, 340 reviews, main complaint "no reply for days". Lead: Ada Byron,
Head of Customer Support, Northwind Goods. Template `email_only`, four steps.

## A lead's plan as one story

Step 1 (interest), angle `signal:trustpilot-slow-replies`. Three beats, then the question:
their footprint, what it means for the problem the client solves, how the client helps.

```
Subject: replies at northwind

Hi Ada,

Most of Northwind's 340 recent Trustpilot reviews say the same thing: no answer for days.

At that volume the complaint is usually the first thing a new customer reads, and it tends to mean tickets arrive faster than the team can open them.

Taking tier-1 tickets off your team is what we do, so the first reply stops waiting on the queue.

Who owns first-reply time at Northwind today?
```

Step 2 (value), angle `proof:acme-outdoor`, same thread

```
Subject: replies at northwind

Hi Ada,

Acme Outdoor had the same pattern last spring. Their first-reply time went from 19 hours to 45 minutes in six weeks, without adding anyone to their own team.

Would a result like that matter for Northwind?
```

Step 3 (value), angle `pain:review-rating`, same thread

```
Subject: replies at northwind

Hi Ada,

One thing we see at stores your size: once the rating drops under 3, ads cost more to convert because shoppers check reviews first.

Fixing reply time is usually the fastest lever on the rating. Worth a look?
```

Step 4 (goal), angle `close:last-touch`, same thread: one offer, asked for directly.

```
Subject: replies at northwind

Hi Ada,

Last note from me. A 20 minute call would show you how Acme Outdoor's first six weeks went and what the same would look like at Northwind.

Want me to set it up?

If reply times are not a priority right now, I will stop here.
```

No greeting-less body, no sign-off (the signature is appended), no dash, one short question each
with one obvious answer (a name, a yes), each step on a different side of the brief. The last
email offers one thing; "Would Tuesday or Wednesday work?" is a choice, and "Is getting first
replies under an hour something you're working on this quarter?" is too long to answer at a glance.

## LinkedIn

Invite (angle `signal:trustpilot-slow-replies`, 176 characters):

```
Ada, I work with support teams at DTC brands on reply times and saw Northwind's reviews mention slow answers. Would be glad to connect.
```

Message after acceptance (angle `proof:acme-outdoor`):

```
Thanks for connecting, Ada. Acme Outdoor took first replies from 19 hours to 45 minutes in six weeks with us handling tier 1. Is reply time something you're looking at this year?
```

## Referral (first message)

```
Subject: anna suggested i write

Hi Priya,

Anna Smith said you own support operations at Northwind and that reply times are yours to decide on.

Acme Outdoor went from 19 hours to 45 minutes on first replies in six weeks.

Worth a short call to see if it applies?
```

Angle `referral:anna-smith`. Say only what the referrer actually wrote.

## Re-engagement

```
Subject: back in january, as agreed

Hi Ada,

In October you asked me to come back after the holiday peak, so here I am.

If reply times are on the plan for this year, I can show you what Acme Outdoor changed in their first six weeks. Would a call next week be useful?
```

Angle `reengage:after-peak`. A new thread with its own subject.

## Bad, and why

```
Subject: Transform Your Customer Support Today!

Hi there,

I hope this email finds you well! We are a world-class support partner — we help brands like
[Company] leverage seamless support. Can we book 30 minutes? Also, would you share this with your COO?

Best regards,
Kate
```

Title Case and "!" in the subject; empty greeting; burned opener; opens with "We"; hype words;
a dash; a placeholder (refused by the engine); two asks; a meeting ask on step 1; a sign-off and a
name on top of the engine's signature; nothing specific to the company. `bh copy check` reports all
of it but the meeting ask, the name under the sign-off and the missing specifics: those are yours.

## `bh copy check` / `bh copy write` file

```json
[
  { "messageId": "<id-step-1>", "subject": "replies at northwind", "body": "Hi Ada,\n\nMost of Northwind's recent Trustpilot reviews ...", "angle": "signal:trustpilot-slow-replies" },
  { "messageId": "<id-invite>", "subject": null, "body": "Ada, I work with support teams ...", "angle": "signal:trustpilot-slow-replies" }
]
```
