# BetterContact

Waterfall email finding. Base `https://app.bettercontact.rocks/api/v2/async`; the engine sends the
key as `X-API-Key`. Asynchronous: submit a batch, poll until it is finished.

## Submit (free; up to 100 people per request)

```sh
bh call bettercontact POST / --strategy <strategy-id> --body-file /tmp/bc/batch1.json
```

```json
{
  "enrich_email_address": true,
  "enrich_phone_number": false,
  "data": [
    {
      "first_name": "Anna",
      "last_name": "Berg",
      "company_domain": "acme.com",
      "company_name": "Acme",
      "linkedin_url": "https://www.linkedin.com/in/anna-berg",
      "custom_fields": { "contact": "<contact-id>" }
    }
  ]
}
```

- Answer: `{ "id": "<request-id>", … }`. **Save the id at once** (a note or the scratch file you are
  working from) — a resubmitted batch is billed again. (`bh call show <call-id>` prints the submit's
  answer again if the id was lost.)
- Put the contact id in `custom_fields.contact`: the answers come back keyed by it. The echo comes
  back as a **list** — `"custom_fields": [{"name": "contact", "value": "<id>", "position": 0}]` —
  read it by `name`, never by position. A row whose key you cannot read is dropped, not guessed.
- Give it everything you have: a LinkedIn URL raises the hit rate; a name plus domain works without.
- **`enrich_phone_number` stays false** unless a person wants phones and Apollo found none for these
  people: a number here costs ten credits ($0.50), Apollo's $0.032 (apollo.md). On one project's 280
  BetterContact found 207 numbers for $99; Apollo 255 for about $10. A phone-only batch is
  `"enrich_email_address": false, "enrich_phone_number": true` (see Phones below).
- The submit is guarded against repeats: the same batch body twice within 30 days is refused with
  409 — which is what you want.
- **One account, every project.** A batch the balance cannot cover is accepted by BetterContact and
  held (`on hold`) until a top-up, and every project's lookups wait behind it. So the engine refuses
  a batch that could take more credits than the account holds — one per row for addresses, ten per
  row for phones — with `409 credits_short`, naming `mostCredits` and `creditsLeft`. Send a smaller
  batch, or tell a person to top up. (It goes by the balance it last heard and asks BetterContact
  afresh before refusing, so a top-up shows at once.)

## Collect (one credit, $0.05, per email found; booked from the answer's own credit count)

**Collect each batch once.** Every GET of a finished batch is a call of its own, recorded again.
The engine books only the credits the batch's total has not booked yet, so a second collect shows
`0 credits` — but it is still a wasted call, and a loop that keeps polling hides what it did. One
polling loop once called nine times across two batches, four and five of them after the batches
had terminated.

```sh
bh call bettercontact GET /<request-id>
```

A collect needs no `--strategy`: with no refs of its own it is tied to what the submit was tied to,
and its cost lands there. Pass `--strategy` on the **submit**.

- Ready **only when `status` is `"terminated"`**; any other status means wait. A 2xx says the
  request exists, not that it is finished. **`on hold`** means the account ran short: `bh call`
  says so on stderr. The batch runs by itself once a person tops up — tell one, keep the request id
  in the `todo` note, and **never submit it again** (that pays twice). Twenty people took ~20 minutes once — poll every few
  minutes, not in a tight loop.
- Poll with a loop that **stops on the first `terminated`**, and keep that answer: write the results
  to the contacts straight from it, then supersede the batch's `todo` note. Never poll a batch
  already collected — if the answer is lost, `bh call show <call-id>` prints it again for free.
- Rows at `data[]`: `contact_email_address` (null when nothing was found — not charged),
  `contact_phone_number` and `contact_phone_number_status` when phones were asked for, and the
  echoed `custom_fields`. Read any status field it adds as a hint only. `bh call` counts a row with
  an address or a phone found as a result.
- The answer carries `credits_consumed` (the batch's total so far) and `credits_left` (the account's
  balance). The engine books the credits the batch has not booked yet at $0.05 each, so `bh call`
  prints `N credits (M left)`, and `bh providers` and `bh spend` show the balance. Before a batch
  larger than the balance, stop and tell a person.
- The answer also includes `company_formatted_locations`: a cheap way to count a company's sites.

## Phones

Submit with `"enrich_phone_number": true` (and `"enrich_email_address": false` when only phones are
wanted). Ten credits ($0.50) per number found, nothing for a row without one; one project's batch of
49 found 35 numbers for 350 credits. The number is at `contact_phone_number`, its status at
`contact_phone_number_status`, the batch's tally at `summary.phone_enrichment`. The engine books
phones as `phone_find` and addresses as `email_find` (`bh spend`), shared by the credits each took.
Write the numbers with `bh phones add` (email-finding, section D) — never into `facts`.

## After collecting

Every found address is **unverified**. Verify each with Bouncer before it goes to a contact as
`valid` (email-finding skill). An address not found is recorded as a fact on the contact
(`facts.email_search`), so nobody pays to ask again next week.

## Errors

- 402 (balance), 429, 5xx — "not now"; wait and retry.
- Other 4xx — the request is wrong; read the body.
