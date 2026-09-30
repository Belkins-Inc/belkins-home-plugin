---
name: email-finding
description: Finding and verifying email addresses — BetterContact / FullEnrich async enrichment, Bouncer verification, catch-all and unknown handling (LinkedIn instead of email; Scrubby is off), the email_status values, and replacing an address after a hard bounce with up to three checked guesses. Use when contacts need addresses, when an address's status is in doubt, or when a "Replace the bounced address" task is open.
---

# Finding and verifying addresses

Provider mechanics: [bettercontact](../providers/references/bettercontact.md),
[fullenrich](../providers/references/fullenrich.md), [bouncer](../providers/references/bouncer.md),
[scrubby](../providers/references/scrubby.md) (off for now).

**Email goes only to an address Bouncer called valid.** Scrubby is off for now, so nothing settles
an `unknown` or a catch-all later: those, `invalid` and unchecked addresses go by LinkedIn, and the
engine chooses that by itself at `bh enroll`. **Nothing is sent to an address nobody checked.** Every bounce costs the sending domain's
reputation, and strategy health opens a task at 3% hard bounces.

## `contacts.email_status`

| Status | Means | The engine at enrollment |
| --- | --- | --- |
| `valid` | Bouncer `deliverable` | email steps go |
| `catch_all` | the domain accepts every address; this mailbox is unconfirmed | the strategy's `catch_all_policy`: `hold` (held when there is no LinkedIn), `linkedin_only`, or `send` |
| `unknown` | the check could not settle (greylisting, timeout, a low score) | no email; LinkedIn only if there is a profile |
| `invalid` | Bouncer `undeliverable` | no email; LinkedIn only if there is a profile |
| none | never checked | no email; LinkedIn only if there is a profile — check it with Bouncer first |
| `bounced` | set by the engine after a `no_such_user` bounce | no email; a replacement task is opened |

## Read first

```sh
bh brief                                  # open tasks (bounce replacements), rules
bh address collect                        # settle Scrubby checks submitted before it was switched off (free)
bh strategy show <strategy-id>            # catch_all_policy, personas
bh dnc check <domain|address>…            # or --file <csv>: which of them do-not-contact blocks
```

Do not buy an address for a contact at a DNC domain, or for one already `rejected` in the strategy:
run the batch's company domains through `bh dnc check` first and drop what it names.

## A. Addresses for new contacts

1. **Who needs one**: contacts for the strategy with no address and no earlier attempt:

   ```sh
   bh sql "select k.id, k.first_name, k.last_name, k.linkedin_url, c.domain, c.name
           from strategy_contacts x join contacts k on k.id = x.contact_id
           left join companies c on c.id = k.company_id
           where x.strategy_id = '<strategy>' and x.status = 'candidate'
             and k.email is null and not (k.facts ? 'email_search')" --limit 100
   ```

   (Contacts just found and not yet in `strategy_contacts`: select them by `company_id` or
   `created_at` instead.)
2. **Hold out incomplete names before paying.** A waterfall needs a last name to build an address
   from. A contact whose last name is missing or one or two characters — LinkedIn names like "Karen
   A", "Grant R", "Ben L" — is not submitted: several of 15 misses in a batch of 128 were these.
   Record it so the query above skips it,
   `"facts":{"email_search":{"value":"name_incomplete","source":"linkedin","note":"last name \"A\" on LinkedIn, 2026-09-24"}}`,
   then either find the full name first (the profile, the company's team page) and submit it in a
   later batch, or work that person through LinkedIn only.
3. **Submit to BetterContact** (≤ 100 per batch; `custom_fields.contact` = the contact id; LinkedIn
   URL, name, domain, company name). Keep the request id: write it down with
   `bh note add --kind todo --title "Collect BetterContact batch <id>" --body "<strategy>, <n> contacts"`
   so another session can collect it, and supersede the note once collected.
4. **Collect once**, when `status` is `terminated` (minutes, sometimes twenty). Match rows by the echoed
   `custom_fields` entry named `contact`.
5. **Verify every found address with Bouncer**, one call each, tied to the contact:
   `bh call bouncer GET "/email/verify?email=<urlencoded>&timeout=20" --contact <id>`. Map the answer
   (bouncer.md): deliverable → `valid`; undeliverable → `invalid`; risky + `acceptAll: "yes"` →
   `catch_all`; anything else → `unknown`. (For an address already on the contact,
   `bh address check <contact-id> --address <a> --reason new_contact` does the same check and writes
   the status itself.)
6. **Write** with the contact's existing key, so the upsert updates it instead of creating a second
   contact — always include the `linkedinUrl` the contact already has:

   ```json
   {"linkedinUrl":"https://www.linkedin.com/in/anna-berg","email":"anna.berg@acme.com","emailStatus":"valid",
    "facts":{"email_search":{"value":"found","source":"bettercontact","note":"bouncer deliverable 2026-09-24"},
             "mx":{"value":"aspmx.l.google.com","source":"bouncer"}}}
   ```

   Store `invalid` addresses too (with `emailStatus: "invalid"`) so nobody buys them again.
   The contact keeps its company even when the address is on another domain (a group domain like
   `global.ntt` for a contact at `services.global.ntt`); only `companyDomain` moves it.
7. **Not found** → `"facts":{"email_search":{"value":"not_found","source":"bettercontact","note":"2026-09-24"}}`.
   For contacts worth a second try (top persona, strong signal) submit them to FullEnrich
   (`contact.emails` only) and verify the same way. Otherwise the contact goes LinkedIn-only.

Never take an address from Apollo, Generect or a web page as found: provider-incidental addresses
were right 74% of the time against 91% for BetterContact, and the wrong ones are plausible patterns
on catch-all domains. Never write `email_not_unlocked@…`. Never write a guessed pattern as an
address without a check.

## B. Catch-all and unknown

Scrubby is off for now (the engine refuses its paid calls), so neither is settled by a deep check.

- `unknown`: the engine does not email it; the contact goes LinkedIn-only when it has a profile and
  is skipped otherwise. Nothing to do — do not hold it for a check that will not come.
- `catch_all`: the strategy's `catch_all_policy` decides at `bh enroll` — `linkedin_only` and `hold`
  send by LinkedIn when there is a profile; `hold` without one keeps the contact held. `send` emails
  it: that is a person's choice for the strategy, not yours.
- Checks submitted before Scrubby was switched off still come back: `bh address collect`, then
  `bh address checks <contact-id>`; a `valid` → upsert the contact with `emailStatus: "valid"`.
  A Bouncer verdict on the contact's own address updates `contacts.email_status` by itself (`valid`,
  `invalid`, `catch_all` when `acceptAll` is yes, `unknown` for other risky); Scrubby's answers from
  `bh address collect` do not — write those with the upsert.

**Two spellings on a catch-all domain is not an address.** When two sources give one person two
addresses at the same domain — our waterfall against the client's list, BetterContact against
FullEnrich — and the domain is catch-all, verification accepts both and one of them goes nowhere.
Seen on five of thirteen people found by both sides: `asmith@` against
`anna.smith@acme.com`, `rjones@` against `robert.jones@northwind.com`, and three more like them.
Never pick one. Keep the contact off email — upsert it with `emailStatus: "unknown"` and both
spellings in `facts.email_search.note` — so it goes LinkedIn-only; ask the person there if the
address matters.

Held contacts to revisit:
`bh sql "select contact_id, reason, updated_at from strategy_contacts where strategy_id = '<id>' and status = 'held'"`.

## C. After a hard bounce — a scheduled agent may do this

The engine marks the contact `bounced`, ends its email steps (LinkedIn steps go on) and opens a
task **"Replace the bounced address <address>"**.

1. Find them: `bh task list`, then
   `bh sql "select k.id, k.first_name, k.last_name, k.email, c.domain from contacts k left join companies c on c.id = k.company_id where k.email_status = 'bounced' and k.project_id = @project"`
   and `bh address checks <contact-id>` (guesses already made count toward the three).
2. **Guess up to three addresses** — three distinct addresses per contact, across providers; the
   engine refuses a fourth. Base them on evidence, most likely first:
   - the pattern of **valid** addresses at the same domain
     (`bh sql "select email from contacts where email like '%@<domain>' and email_status = 'valid'"`);
   - otherwise the common patterns: `first.last`, `first`, `flast`, `firstlast`, `first_last`,
     `firstl`, `f.last`;
   - never the address that bounced; a changed domain (the company rebranded, the person moved) is a
     different question — check the company first.
3. **Check each**: `bh address check <contact-id> --address <guess> --reason bounce_replacement`
   (Bouncer, instant). `valid` → go to 4. `risky` means the domain is catch-all: Bouncer cannot
   confirm a guess there, and with Scrubby off nothing can — treat it as not confirmed.
4. **Replace**: `bh address replace <contact-id> --address <confirmed>`. It refuses an address with no
   `valid` check. The engine then updates the contact, re-sends the bounced step to the new address,
   restores the remaining email steps (reopening the lead if the bounce had ended it) and closes the
   task.
5. **No guess confirmed** after three: let the email channel go —
   `bh task close <task-id> --status cancelled --note "three guesses checked, none valid"`. The lead
   continues on LinkedIn if it has a plan there.

A scheduled agent can call only Bouncer (Scrubby is off), so it replaces by guessing and checking; a
new BetterContact or FullEnrich search is a person's session.

## Before you stop

- Collect every submitted batch, or leave its request id in a `todo` note.
- `bh session end --summary`: addresses found / valid / catch-all / unknown / invalid, what was
  spent, which went LinkedIn-only for want of a valid address, which bounce tasks are closed or
  waiting.

## Common mistakes

- Upserting an address without the contact's LinkedIn URL — a second contact is created.
- Holding an `unknown` or catch-all contact for a deep check — Scrubby is off; it goes by LinkedIn.
- Paying to search a contact whose last name is an initial.
- Choosing between two spellings on a catch-all domain because both "verified".
- Reading Bouncer's `risky` as invalid (it is catch-all or unknown) or Scrubby's `Risky` as valid.
- Checking the same address twice within 30 days (refused as a repeat; the verdict is already in
  `bh address checks`, the answer in `bh call show <call-id>`). `--again` pays for a fresh check —
  only when something changed.
- Buying phones with addresses (`enrich_phone_number: true`) — ten times the cost, only when a person asks.
