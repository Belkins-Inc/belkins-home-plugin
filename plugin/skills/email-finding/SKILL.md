---
name: email-finding
description: Finding and verifying email addresses and phone numbers — Apollo first, then BetterContact async enrichment (FullEnrich is off), Bouncer verification, catch-all and unknown handling (LinkedIn instead of email; Scrubby is off), the email_status values, and replacing an address after a hard bounce with up to three checked guesses. Use when contacts need addresses, when an address's status is in doubt, or when a "Replace the bounced address" task is open.
---

# Finding and verifying addresses

Provider mechanics: [apollo](../providers/references/apollo.md),
[bettercontact](../providers/references/bettercontact.md),
[fullenrich](../providers/references/fullenrich.md) (off), [bouncer](../providers/references/bouncer.md),
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
run the batch's company domains through `bh dnc check` first and drop what it names. Run the
addresses you found through `bh dnc check` too before writing them: an address on a parent group's
or another employer's domain passes a check of the company's own domain.

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
   from. A contact whose last name is missing or a single letter (with or without a period) —
   LinkedIn initials like "Karen A", "Grant R.", "Ben L" — is not submitted: several of 15 misses in a
   batch of 128 were these. **A two-letter last name is a real surname and goes in**: Wu, Li, Ng, Qu,
   Xu, Ha, La and the like are common in Chinese, Korean and Vietnamese names (BetterContact found
   addresses for 6 of 7 such people held back on one project). Record a held contact so the query
   above skips it,
   `"facts":{"email_search":{"value":"name_incomplete","source":"linkedin","note":"last name \"A\" on LinkedIn, 2026-09-24"}}`,
   then either find the full name first (the profile, the company's team page) and submit it in a
   later batch, or work that person through LinkedIn only.
3. **Read what was already paid for.** A `people/match` the people step made (to find who a person
   is) already holds Apollo's candidate address, free to read:

   ```sh
   bh sql "select c.contact_id, c.response->'person'->>'email' as email,
                  c.response->'person'->>'linkedin_url' as linkedin_url, c.at
           from provider_calls c
           where c.project_id = @project and c.provider = 'apollo' and c.endpoint = '/people/match'
             and c.status_code = 200 and c.response->'person'->>'email' is not null
             and c.at > now() - interval '30 days'" --limit 500
   ```

   Match rows to your contacts by `contact_id` or the LinkedIn URL and take those candidates straight
   to Bouncer (step 5). On one project stored answers covered 205 of 333 people for nothing.
4. **Ask Apollo** for the rest (`people/bulk_match`, 10 a call, $0.0065 per person matched;
   apollo.md): LinkedIn URL, name, domain, company name. Keep the contact id beside each `details[]`
   entry — `matches[]` comes back in the same order.
5. **Verify every Apollo address with Bouncer**, one call each, tied to the contact:
   `bh call bouncer GET "/email/verify?email=<urlencoded>&timeout=20" --contact <id>`. Map the answer
   (bouncer.md): deliverable → `valid`; undeliverable → `invalid`; risky + `acceptAll: "yes"` →
   `catch_all`; anything else → `unknown`. (For an address already on the contact,
   `bh address check <contact-id> --address <a> --reason new_contact` does the same check and writes
   the status itself.) **Only `deliverable` settles the contact**: write it
   (`"source":"apollo"`, step 8). Everyone else — no match, no email, catch-all, unknown,
   undeliverable — goes on to BetterContact; do not write Apollo's address for them.
   **Deliverable is not enough when the address is at another organisation** (section A2): Bouncer
   says only that the mailbox exists, and Apollo often answers with a person's address at a new or
   second employer.
6. **Submit the rest to BetterContact** (≤ 100 per batch; `custom_fields.contact` = the contact id;
   LinkedIn URL, name, domain, company name). One account serves every project: the engine refuses a
   batch that could take more credits than it holds (`409 credits_short`) — send a smaller batch or
   ask a person to top up. Keep the request id: write it down with
   `bh note add --kind todo --title "Collect BetterContact batch <id>" --body "<strategy>, <n> contacts"`
   so another session can collect it, and supersede the note once collected.
7. **Collect once**, when `status` is `terminated` (minutes, sometimes twenty). Match rows by the
   echoed `custom_fields` entry named `contact`, and verify every address it found with Bouncer as in
   step 5. BetterContact's catch-all and unknown addresses are written with that status (section B).
8. **Write** with the contact's existing key, so the upsert updates it instead of creating a second
   contact — always include the `linkedinUrl` the contact already has:

   ```json
   {"linkedinUrl":"https://www.linkedin.com/in/anna-berg","email":"anna.berg@acme.com","emailStatus":"valid",
    "facts":{"email_search":{"value":"found","source":"apollo","note":"bouncer deliverable 2026-10-07"},
             "mx":{"value":"aspmx.l.google.com","source":"bouncer"}}}
   ```

   `source` is the provider the address came from (`apollo`, `bettercontact`, `fullenrich`).
   Store `invalid` addresses too (with `emailStatus: "invalid"`) so nobody buys them again.
   The engine matches the URL by the profile it names (http or https, `www.`, a trailing slash or a
   query do not make another contact). A row whose address belongs to nobody but whose profile
   belongs to a contact with another live address is saved as a **new** contact without the
   profile, and its answer carries a warning: two people on one profile is a provider's error —
   find out which one the profile is before enrolling either.
   The contact keeps its company even when the address is on another domain (a group domain like
   `global.ntt` for a contact at `services.global.ntt`). A `companyDomain` other than the
   contact's company does not move them either: the row is warned. Add `"moveCompany": true` only
   when you know they changed companies; the answer then says `companyChanged`. Someone who left
   for another employer: `bh contacts depart <id> --reason "<what shows it>"`, and they are never
   enrolled again. One person held by two contacts: `bh contacts duplicates`, then a person
   decides and runs `bh contacts merge <keep-id> <drop-id>`.
9. **Not found** by either →
   `"facts":{"email_search":{"value":"not_found","source":"apollo,bettercontact","note":"2026-10-07"}}`.
   There is no third try: FullEnrich is off (the engine refuses a submission with
   `409 provider_off`). The contact goes LinkedIn-only.

## A2. An address at another organisation's domain

Before writing an address as `valid`, compare its domain with the company's domain. It belongs to
the company when it is the company's domain, a subdomain of it, or a domain the company's domain is
a subdomain of (`global.ntt` for `services.global.ntt`) — or a domain recorded as the same
organisation in the company's `related_domains` fact (a parent group, a sister brand, a former
domain). Anything else — a bank's, a university's, a city council's, another company's address for
a person at a consumer brand — is not the contact's work address:

1. Do not write it as the contact's address. Look for one at the company's own domain: the next
   provider in the waterfall, and Bouncer must call it deliverable.
2. Found none → no email for this contact: it goes LinkedIn-only (or nowhere without a profile).
   Record why, so nobody buys it again and someone checks where the person works now:
   `"facts":{"email_search":{"value":"other_domain","source":"apollo","note":"lena@bank.example, not at the company, 2026-11-09"},"employer_check":{"value":"needed","source":"email-finding"}}`.
3. The domain really is the same organisation (you checked: the company's site, its LinkedIn page,
   a group page) → record it on the company first, then write the address:
   `bh companies upsert` with `{"domain":"<company>","facts":{"related_domains":{"value":["<group domain>"],"source":"web","note":"parent group, <url>"}}}`.

The engine saves such an address anyway and says so: each row of the `bh contacts upsert` answer
whose address is not at its company carries a `warnings` entry. Read the warnings; a warned row you
did not mean is a contact to fix now (`bh behaviour contacts`).

Why Apollo goes first and Bouncer decides (measured 2026-10-07 against what our sends delivered and
bounced): Apollo agreed with 99 of 127 addresses BetterContact had found and we had delivered to, at
a seventh of the price — but its own `verified` covered 8 addresses that had bounced `no_such_user`,
and its catch-all patterns are plausible guesses verification cannot refuse. So an Apollo address is
taken only on Bouncer's `deliverable`, and a catch-all one goes to BetterContact instead.

Never take an address from Generect or a web page as found. Never write `email_not_unlocked@…`.
Never write a guessed pattern as an address without a check.

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
Apollo — and the domain is catch-all, verification accepts both and one of them goes nowhere.
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
new BetterContact search is a person's session.

## D. Phone numbers (when a person wants phones)

1. **Apollo first**: the same `bulk_match` with `"reveal_phone_number": true` — the emails come at
   once, the phones within seconds to the engine, **which puts them on the contacts itself** (by the
   LinkedIn URL you asked with, else Apollo's address) and puts a number on the Do Not Call registry
   on do-not-contact. Check with `bh phones <contact-id>`; a person who is not yet a contact keeps
   their numbers only in `bh call show <call-id>` (`deliveries`, apollo.md) — upsert the contact,
   then add them by hand (3). Five credits ($0.032) per person a number was found for.
2. **BetterContact for whom Apollo found none** (`enrich_phone_number: true`, about $0.50 a number),
   and nothing after it (FullEnrich is off).
3. **Write** a number that did not come from Apollo with `bh phones add` (`contactId`, `number` with
   its country code, `kind` mobile|direct|company|other, `source`, `confidence`, `dnc`). Each goes
   after the contact's numbers already there, so the first found is dialled first; `bh phones set
   <phone-id> --rank 1` reorders. A number is never a fact: `facts.phone` is refused.
4. **Check before anyone dials** (when the key is set, a person's session): `bh phones check
   <phone-id>` asks Twilio Lookup for the line type and the registered name, $0.018 a number
   (twilio.md). Apollo marks nearly every number `valid_number` / `high`, so its flags tell nothing
   apart; the lookup marks a number that does not exist dead, sends a landline or VoIP number last
   in the dial order, and says whether the registered name is the contact's (`callerMatches`).
   Check the numbers a call list will dial first, not every number found.
5. **Do Not Call**: a provider saying a number is on a registry → `"dnc": true` on the row; the
   number goes on do-not-contact and no call list takes it.
6. Record a miss — no delivery ten minutes on means Apollo found no number for anyone in the call:
   `"facts":{"phone_search":{"result":"not_found","source":"apollo,bettercontact","seenAt":"…"}}`.

## Before you stop

- Collect every submitted batch, or leave its request id in a `todo` note.
- `bh session end --summary`: addresses found / valid / catch-all / unknown / invalid, what was
  spent, which went LinkedIn-only for want of a valid address, which bounce tasks are closed or
  waiting.

## Common mistakes

- Upserting an address without the contact's LinkedIn URL — a second contact is created.
- Writing the first deliverable address without comparing its domain with the company's (A2).
- Ignoring `warnings` in the upsert answer: a profile that stayed with another contact, or an
  address at another organisation's domain.
- Holding an `unknown` or catch-all contact for a deep check — Scrubby is off; it goes by LinkedIn.
- Paying to search a contact whose last name is an initial (one letter; two letters is a surname).
- Choosing between two spellings on a catch-all domain because both "verified".
- Reading Bouncer's `risky` as invalid (it is catch-all or unknown) or Scrubby's `Risky` as valid.
- Paying `--again` for an address the organisation checked within 30 days: `bh address check`
  takes that earlier verdict as this contact's by itself, for free (`reusedCall` in its answer).
  `--again` pays for a fresh check — only when something changed.
- Submitting a BetterContact batch again because it is `on hold`: it runs by itself after a top-up,
  and a second submit pays twice.
- Buying phones nobody asked for: only when a person wants phones, and from Apollo first (section D).
- Writing an Apollo address that Bouncer called catch-all, unknown or undeliverable — that contact
  goes to BetterContact.
