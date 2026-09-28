# Bouncer

Real-time address verification. Base `https://api.usebouncer.com/v1.1`; the engine sends the key
as `x-api-key`. **A scheduled agent may call it** (address checks after a bounce).

Price: one credit per address, $0.0056 ($28 for 5,000 credits; credits do not expire).

## Verify one address ($0.0056)

Two ways in:

```sh
# a new contact, when you need the whole answer (catch-all flag):
bh call bouncer GET "/email/verify?email=anna.berg%40acme.com&timeout=20" --contact <contact-id>

# recorded as an address check on the contact (bounce replacement, confirming a guess):
bh address check <contact-id> --address anna.berg@acme.com --reason new_contact
```

`bh address check` stores the verdict in `address_checks` (`valid`, `invalid`, `risky`,
`unknown`). When the address is the contact's own (already its `email`), it also sets the
contact's `email_status`: `valid`, `invalid`, `catch_all` when Bouncer says `acceptAll: "yes"`,
`unknown` for other risky. For an address not yet on the contact, use `bh call`, read the answer
and write the status with `bh contacts upsert`.

URL-encode the address (`@` → `%40`, `+` → `%2B`). Keep `timeout=20`: Bouncer's own deadline, so a
greylisted address comes back as `unknown` instead of a cut connection.

## The answer, and what it means for `contacts.email_status`

```json
{ "email": "anna.berg@acme.com", "status": "deliverable",
  "reason": "accepted_email", "domain": { "name": "acme.com", "acceptAll": "no", "disposable": "no", "free": "no" },
  "account": { "role": "no", "disabled": "no", "fullMailbox": "no" },
  "dns": { "type": "MX", "record": "aspmx.l.google.com." }, "provider": "google.com",
  "score": 100, "toxicity": 0 }
```

| Bouncer `status` | `domain.acceptAll` | `email_status` |
| --- | --- | --- |
| `deliverable` | — | `valid` |
| `undeliverable` | — | `invalid` |
| `risky` | `"yes"` | `catch_all` — the domain accepts everything; no verifier can confirm this mailbox without sending |
| `risky` | not `"yes"` | `unknown` — scored low, nothing found wrong. **Not** invalid |
| `unknown` (incl. greylisting, timeouts) | — | `unknown` |

- `score` and `toxicity` are Bouncer's own gradings; do not decide on them.
- `provider` (the mail service) and `dns.record` (MX host) are worth keeping in the contact's
  `facts` when present (e.g. `mx`: a Proofpoint or Mimecast host is a hint of heavy filtering).
- `account.role: "yes"` (info@, support@) is a role address — not a person; do not enroll it as one.

## Balance (free)

```sh
bh call bouncer GET /credits      # → {"credits": 18240}
```

## Repeats and limits

- Guarded: the same address within 30 days is refused with 409, naming the earlier call. The
  verdict should already be on the contact
  (`bh sql "select email, email_status, email_verified_at from contacts where id = '…'"`), and
  `bh call show <call-id>` prints Bouncer's whole answer again. Re-check with `--again` (both
  `bh call` and `bh address check` take it) only when something changed, e.g. an address older than
  ~90 days.
- 402 (balance), 429, 5xx: wait and retry. Other 4xx: the address or request is malformed.
