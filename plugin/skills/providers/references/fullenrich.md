# FullEnrich

**Off** (2026-10-09). Addresses and numbers come from Apollo, then BetterContact; what they miss goes
by LinkedIn. The engine refuses a submission with `409 provider_off`; collecting a batch submitted
before still works, and its balance is no longer read or alerted on.

Waterfall enrichment for emails and phones. Base `https://app.fullenrich.com/api/v1`; the engine
sends the key as `Authorization: Bearer …`. Asynchronous: submit, then poll.

Use it as the **third** email finder (for people Apollo and BetterContact found nothing for) and for
**phones only when a person asks**, and after Apollo and BetterContact — a phone costs roughly ten
times an email.

## Submit (free)

```sh
bh call fullenrich POST /contact/enrich/bulk --strategy <strategy-id> --body-file /tmp/fe/batch1.json
```

```json
{
  "name": "acme-support-leaders-emails-1",
  "datas": [
    {
      "firstname": "Anna",
      "lastname": "Berg",
      "domain": "acme.com",
      "company_name": "Acme",
      "linkedin_url": "https://www.linkedin.com/in/anna-berg",
      "enrich_fields": ["contact.emails"],
      "custom": { "contact": "<contact-id>" }
    }
  ]
}
```

- `enrich_fields`: `["contact.emails"]` for addresses, `["contact.phones"]` for numbers (only when
  asked). Do not ask for both by default.
- Answer: `{ "enrichment_id": "<id>" }`. Save it at once; a resubmitted batch is billed again
  (`bh call show <call-id>` prints the answer again if the id was lost).
- `custom.contact` comes back on each row as an object (`row.custom.contact`) — match answers by it.
- Guarded against repeats (same body within 30 days → 409).

## Collect (charged in credits, $0.055 each; booked from the answer's `cost.credits`)

```sh
bh call fullenrich GET /contact/enrich/bulk/<enrichment_id>
```

- Ready **only when `status` is `"FINISHED"`**; otherwise wait and poll again later.
- Rows at `datas[]`; each has `custom.contact` and `contact`:
  - phones: `contact.phones[].number`;
  - emails: `contact.most_probable_email` and `contact.emails[]` (each with an `email` and a
    status). Check the first finished answer's exact shape before writing a batch.
- The answer's `cost.credits` is the batch's total so far; the engine books what it adds to the
  earlier polls of the same batch, so `bh call` prints `N credits`. A finished batch polled again
  books 0 credits — still, collect it once.
- The balance: `bh call fullenrich GET /account/credits` (free) — then `bh providers` shows it.

## After collecting

An address from FullEnrich is unverified like any other: verify with Bouncer (email-finding
skill). A phone number goes into the contact's `facts` (`{"phone": {"value": "+1…", "source":
"fullenrich"}}`) — there is no phone column.

## Errors

402 (balance), 429, 5xx — wait and retry. Other 4xx — the request is wrong.
