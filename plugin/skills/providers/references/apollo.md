# Apollo

Base `https://api.apollo.io/api/v1`; the engine sends the key as `x-api-key` (the only form Apollo
reads — anything else answers `422 Api key required`).

Apollo is used for **one question: which LinkedIn profile is this named person.** It is not a
sourcing search here.

## People match — a name and an employer to a profile ($0.0065 per call, found or not)

```sh
bh call apollo POST /people/match --contact <contact-id> --body '{
  "first_name": "Anna", "last_name": "Berg",
  "organization_name": "Acme Logistics", "domain": "acme-logistics.com",
  "reveal_personal_emails": false, "reveal_phone_number": false
}'
```

- Answer: `{ "person": { "name", "title", "linkedin_url", "organization": { "name", "primary_domain" }, … } }`
  or `person: null`.
- Measured on 40 conference speakers: 34 profiles with a link, **0 wrong people**, 6 right person
  with no link; median 0.3 s. Apollo is silent where it cannot answer — that is why it goes first.
- A `person` with no `linkedin_url` is not a profile found (you have the person, not the key).
  Then, and only then, try Generect realtime leads (generect.md) and check the employer yourself.
- **Never set the reveal flags** — a reveal is a second charge for an address this step ignores.
- **Ignore the email in the answer.** A profile provider's incidental address was the right person's
  74% of the time against 91% from BetterContact; the wrong ones are plausible patterns on catch-all
  domains that verification cannot refuse. Find the address with BetterContact.
- You can also match by `linkedin_url`. Vanity `/in/<slug>` and Sales Navigator `/sales/lead/<URN>`
  match; a URN in the `/in/` form (`/in/ACwAAA…`, starts with `AC` and 25+ more characters)
  answers empty — rewrite it to `/sales/lead/<URN>` first.
- The call is guarded against repeats (same body within 30 days → 409).

## People search — do not use for sourcing

`POST /mixed_people/api_search` takes its filters **only as query parameters with `[]`**
(`person_titles[]=…&q_organization_domains_list[]=acme.com&per_page=25`); **a JSON body is ignored**
and the search becomes "anyone, anywhere". Even spelled right, its rows carry **no name and no
LinkedIn URL** — identity is a second paid call per person — and the address is the placeholder
`email_not_unlocked@<domain>`, which must never become a contact's email. Its price is not in the
engine's catalog (`cost unknown`). People are found with Generect (generect.md).

If you must use it (e.g. to check whether a company has anyone with a title at all):

```sh
bh call apollo POST "/mixed_people/api_search?q_organization_domains_list[]=acme.com&person_titles[]=head%20of%20support&per_page=10" --strategy <id>
```

## Limits and failures

- The previous generation had no timeout or retry around Apollo; treat 429 / 5xx as "try later".
- Apollo's matching behaviour can change without notice — if people/match suddenly answers nothing
  for obvious people, note it (`bh note add --kind insight`) and tell a person.
