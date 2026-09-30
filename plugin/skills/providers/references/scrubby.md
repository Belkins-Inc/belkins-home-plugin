# Scrubby

**Off for now.** The engine refuses a submission with `409 provider_off`; `bh address collect`
still fetches answers to checks submitted before. Bouncer decides, and an address it does not call
`valid` goes by LinkedIn (see the `email-finding` skill).

Deep verification for addresses a real-time checker cannot settle: catch-all domains, `unknown`
(greylisted) addresses, and guesses after a hard bounce. Scrubby sends to the address and waits for
real bounce data, so answers take **24 to 72 hours**. Base `https://api.scrubby.io`; key as
`x-api-key`. **A scheduled agent may call it.**

Price: charged per address submitted; the dollar price is not in the catalog yet (`cost unknown`).

## The normal way: through `bh address`

```sh
bh address check <contact-id> --address anna@acme.com --provider scrubby --reason catch_all
bh address check <contact-id> --address a.berg@acme.com --provider scrubby --reason bounce_replacement
bh address checks <contact-id>        # what was checked and the verdicts
bh address collect                    # fetch Scrubby's answers for every pending check in the project
```

`bh address check` submits one address, stores `status = pending` with Scrubby's identifier, and
`bh address collect` later settles it: `valid`, `invalid`, `risky` or `unknown`. Run `collect` at the
start of a session (and in the scheduled agent's run) — it is free.

- `reason`: `bounce_replacement` (a guess after a hard bounce — at most **three distinct addresses per
  contact**, counted across providers), `catch_all` (a found address on a catch-all domain),
  `new_contact`.
- `risky` / `unknown` from Scrubby settle nothing: the address stays where the first check left it.
  Never treat either as valid.

## Directly (for a batch of many addresses)

```sh
bh call scrubby POST /validate_bulk_emails/deep/ --body '{"email": ["anna@acme.com", "bo@beta.io"]}'
# → {"identifier": "…", "retry_after_seconds": 86400, "remaining_credits": …}

bh call scrubby POST /fetch_bulk_results/deep --body '{"identifier": "…"}'     # free
# → {"status": "completed" | …, "results": {"anna@acme.com": {"result": "Valid"}, …}, "retry_after_seconds": …}
```

- Results are keyed **by address**; `result` is `Valid`, `Invalid`, `Risky` or `Unknown`. Only
  `Valid` and `Invalid` are verdicts.
- Ready when `status` is `"completed"`; before that, respect `retry_after_seconds`.
- A batch submitted directly is not in `address_checks`, so `bh address collect` will not settle it
  and `bh address replace` will not accept it — use `bh address check` for anything that must lead
  to a replacement. Save the identifier (a note) when you submit directly.

## Errors

- **`400` means either a malformed address or no credits** — Scrubby does not say which. Check the
  address; if it is well-formed, treat it as "no balance" and tell a person.
- 429 / 5xx: wait and retry.
