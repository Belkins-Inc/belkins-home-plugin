# Apollo

Base `https://api.apollo.io/api/v1`; the engine sends the key as `x-api-key` (the only form Apollo
reads — anything else answers `422 Api key required`).

Apollo answers three questions here: **which LinkedIn profile is this named person**, **the first try
for a work email**, and **the first try for a phone number**. It is not a sourcing search — people
are found with Generect (generect.md).

Priced in credits: $3,560 for 550,000 a month, **$0.006473 a credit**. The engine books each call by
the credits it used (`bh call` prints them); an admin changes the price with
`bh providers price apollo --usd <n>`.

## Emails and phones — `people/bulk_match` (the first step of the waterfall)

Up to 10 people a call. Match by `linkedin_url` whenever the contact has one; add the name and
employer either way.

```sh
bh call apollo POST /people/bulk_match --strategy <id> --body '{
  "details": [
    {"linkedin_url": "https://www.linkedin.com/in/anna-berg", "first_name": "Anna", "last_name": "Berg",
     "domain": "acme.com", "organization_name": "Acme"}
  ],
  "reveal_personal_emails": false
}' > /tmp/p/apollo1.json 2> /tmp/p/apollo1.meta
```

- `matches[]` follows `details[]` in order; `null` is a person Apollo does not know. **One credit
  ($0.0065) per person matched**, nothing for a miss (`credits_consumed`: 401 for 401 matched of 406).
- **Email**: `matches[i].email` with `email_status` (`verified`, `extrapolated`, `unavailable`).
  An Apollo address is a candidate, not an address: it counts only once **Bouncer** says
  `deliverable` (email-finding). Apollo's `verified` is not a verdict — on 2026-10-07 it called
  `verified` 8 of 38 addresses that had hard-bounced `no_such_user` for us.
- Measured 2026-10-07 on 150 contacts whose BetterContact address had been delivered: Apollo gave
  an address for 127, the same one for 99; of the different ones Bouncer checked, 8 of 9 were
  deliverable. Of 120 people BetterContact could not find, Apollo had an address for 41 (9 valid at
  Bouncer and QuickEmailVerification, most of the rest catch-all).

### Phones: add `"reveal_phone_number": true`

```sh
bh call apollo POST /people/bulk_match --strategy <id> --body '{"details":[…], "reveal_personal_emails": false, "reveal_phone_number": true}'
# apollo 200 · $0.0647 · 10 credits · 10 results · call <call-id>
# the rest arrives later, to the engine: bh call show <call-id> lists it under deliveries
```

- Apollo reveals phones **only to a webhook**: the engine adds its own `webhook_url` (never pass one)
  and books the delivery as a call of its own. The answer itself carries the emails at once; the
  phones arrive within seconds.
- Read them with `bh call show <call-id>`: `deliveries[].response.people[]` is
  `{id, phone_numbers: [{sanitized_number, type_cd, confidence_cd, status_cd, dnc_status_cd}]}`.
  Join `people[].id` to `matches[].id` of the answer; a person with empty `phone_numbers` has none.
- **When Apollo finds no number for anyone in the call, it sends nothing** — `deliveries` stays empty
  and no phone credits are charged. A delivery comes within seconds when there is one (production,
  2026-10-07: one in 2 s; none after 17 minutes for two people without numbers). So an empty
  `deliveries` ten minutes on means no numbers: record the miss (email-finding, section D).
- **Five credits ($0.032) per person a number was found for**, nothing otherwise — so there is no
  need to check first whether a phone exists.
- `type_cd`: `mobile`, `work_direct`, `home`, `other`. Take a mobile first, then `work_direct`.
- `dnc_status_cd: "found"` — the number is on the US Do Not Call registry: store `"dnc": true` with it
  and nobody dials it.
- Only the deployed engine can take a delivery (it needs an https `PUBLIC_URL`); a local one refuses
  the call with `no_callback_url` before anything is paid.
- Measured 2026-10-07 on Fuel Me's 280 contacts that BetterContact and FullEnrich had searched for
  phones: Apollo found 255 (91%) against their 207 (74%), for about $10 against $103.40. Where both
  had one, the number was the same for 100 of 198; nobody knows yet which is right in the other 98.

A number goes into the contact's `facts`, never a column:

```json
{"linkedinUrl": "https://www.linkedin.com/in/anna-berg",
 "facts": {"phone": {"value": "+12015550100", "source": "apollo", "seenAt": "2026-10-07T00:00:00Z",
                     "type": "mobile", "confidence": "high"}}}
```

A contact that already has a different number keeps it: Apollo's goes in `phone_alt` with the same
shape. Apollo's number agreeing with the one there adds `"confirmedBy": "apollo"` to `phone`.

## Which LinkedIn profile is this named person — `people/match`

```sh
bh call apollo POST /people/match --contact <contact-id> --body '{
  "first_name": "Anna", "last_name": "Berg",
  "organization_name": "Acme Logistics", "domain": "acme-logistics.com",
  "reveal_personal_emails": false
}'
```

- Answer: `{ "person": { "name", "title", "linkedin_url", "email", "organization": { "name", "primary_domain" }, … } }`
  or `person: null`. One credit when a person comes back.
- Measured on 40 conference speakers: 34 profiles with a link, **0 wrong people**, 6 right person
  with no link; median 0.3 s. Apollo is silent where it cannot answer — that is why it goes first.
- A `person` with no `linkedin_url` is not a profile found (you have the person, not the key).
  Then, and only then, try Generect realtime leads (generect.md) and check the employer yourself.
- Its `email` is a candidate like bulk_match's: Bouncer first. For many people, use bulk_match.
- You can also match by `linkedin_url`. Vanity `/in/<slug>` and Sales Navigator `/sales/lead/<URN>`
  match; a URN in the `/in/` form (`/in/ACwAAA…`, starts with `AC` and 25+ more characters)
  answers empty — rewrite it to `/sales/lead/<URN>` first.
- Both match calls are guarded against repeats (same body within 30 days → 409).

## People search — free, and not for sourcing

`POST /mixed_people/api_search` costs nothing (ten searches left the balance where it was,
2026-10-07). It takes its filters **only as query parameters with `[]`**
(`person_titles[]=…&q_organization_domains_list[]=acme.com&q_keywords=anna%20berg&per_page=25`);
**a JSON body is ignored** and the search becomes "anyone, anywhere". Its rows carry an `id`,
`first_name`, `last_name_obfuscated`, `has_email` and `has_direct_phone` — **no full name, no
LinkedIn URL** — and an address placeholder `email_not_unlocked@<domain>` that must never become a
contact's email.

- `has_direct_phone: "Yes"` was right 203 times of 203 on Fuel Me; `"Maybe: …"` 1 of 7. It is never
  "No", and 51 of 70 people the search did not find by name and domain still had a number. Use it to
  size a batch before ordering, not to skip people.
- Whether a company has anyone with a title at all:

```sh
bh call apollo POST "/mixed_people/api_search?q_organization_domains_list[]=acme.com&person_titles[]=head%20of%20support&per_page=10" --strategy <id>
```

## Limits and failures

- Treat 429 / 5xx as "try later"; bulk_match allows about 200 calls a minute.
- The credits are the account's, shared with whoever else uses the key; `bh spend` shows the balance.
- Apollo's matching behaviour can change without notice — if a match suddenly answers nothing for
  obvious people, note it (`bh note add --kind insight`) and tell a person.
