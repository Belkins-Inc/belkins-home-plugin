---
name: sending-domains
description: Buy lookalike sending domains and order mailboxes on them through `bh` — pick the names, quote them, have a person approve the purchase, order the mailboxes, follow them to connected. Use when a project needs a domain or mailboxes to send from ("buy this domain", "we need more mailboxes", "set up sending for the client"), when a domain or mailbox order is stuck or failed, or when a domain should be let go.
---

# Sending domains and mailboxes

We buy the domains ourselves and make the mailboxes on them in our own tenants: no registrar
account, card or payment form is involved. The engine holds the registrar's keys (Porkbun) and pays
from the prepaid credit there; `bh` asks for it. Never tell someone a domain cannot be bought from
here — quote it.

| Work | Who |
| --- | --- |
| The names, the TLD, the mailbox personas | you — it is judgement |
| Approving the spend (`bh domain approve`, `bh mailbox order`) | a person — refused on a scheduled agent's token |
| Buying, DNS, the redirect, the tenant, DKIM, connecting the mailboxes | the engine, every two minutes |
| What the engine cannot fix (credit, a name gone, a tenant refusing) | a task for a person |

In a person's session, a person asking for the purchase is the approval: run `bh domain approve`
yourself once they have seen the names and the price. Elsewhere, open a task with the quote.

## 1. Choose the names

Cold mail never goes from the client's own domain — a bounce or a complaint would follow it for
years. It goes from lookalikes that 301-redirect to the client's site:

- The brand plus a short word: `getacme.com`, `tryacme.com`, `acmehq.com`, `meetacme.com`,
  `acme-team.com`. Readable aloud, no digits, no misspellings of the brand.
- `.com` by default; `.co`, `.io`, `.net` when the `.com` is gone. Never the cheap zones (`.xyz`,
  `.top`, `.online` …): filters already distrust them.
- How many: at most 5 mailboxes go on one domain (the engine refuses a sixth), and each mailbox
  sends `dailyLimit` a day (30 by default, less while it ramps — the `strategy-and-plans` skill does
  the arithmetic). Fewer mailboxes per domain over more domains keeps one domain's reputation from
  carrying everyone's.
- A domain that resembles a client's brand needs the client's permission, which the contract
  carries. If the brief says nothing about it, ask the person before approving.
- Where the mailboxes live: `google` (our Workspace tenants, the default) or `microsoft` (our
  Microsoft 365 tenants). Mix them only when the person asks — `bh tenants` shows what we hold.

## 2. Quote

```sh
bh domain quote getacme.com tryacme.com acmehq.com     # free; up to 10 names
```

It answers each name's availability and price, and the registrar's credit (`balanceCents`). Drop
the names that are taken or `premium`, and quote replacements. Show the person the list,
the total, and the credit.

## 3. Approve the purchase (a person)

```sh
bh domain approve getacme.com tryacme.com --max-cents 1500 --redirect https://acme.com [--platform microsoft]
```

- `--max-cents` is the most one domain may cost — the quoted price plus a little, never a blank
  cheque.
- `--redirect` is the client's real site; set it now (or later with `bh domain redirect`): a domain
  that opens nothing reads as abandoned.
- `insufficient_credit` means the credit cannot carry these plus what is already approved. A person
  tops it up at porkbun.com/account/credit (the API cannot) and the same command is run again —
  nothing was half-done.
- `<name> is already …` means it is ours or in flight: `bh domains`.

Nothing is bought by the command itself: the row is the approval, and the engine buys on its next
pass.

## 4. Order the mailboxes (a person)

Mailboxes can be ordered right after the approval; each order waits until its domain is ready.
Every mailbox is a monthly seat, so order what the plan needs, not a stock.

```sh
bh senders                                    # who they write as
bh mailbox order getacme.com --sender <id> --first-name Jane --last-name Doe --username jane
bh mailbox order getacme.com --sender <id> --file mailboxes.jsonl   # [{"firstName","lastName","username"}]
```

- The persona is the sender's: the real person (or the name the client agreed) the copy signs as.
  Pass `--sender` — without it the engine guesses a sender by the mailbox's name.
- `username` is the local part: lowercase letters and digits, a single `.`, `_` or `-` between
  (`jane`, `jane.doe`). One sender may have mailboxes on several domains; at most 5 per domain.

## 5. Follow it to connected

```sh
bh domains           # each domain: state, tenant, DNS, cost, expiry
bh mailbox orders    # each mailbox order and where it has got to
```

```
domain:  approved → buying → registered → attaching → ready
mailbox: ordered → creating → created → connecting → connected   (a `bh mailboxes` row)
```

DKIM is minted in the tenant's console by our console service, and a task asks a person only when
it cannot. A domain never sends before `ready`.
Once mailboxes are connected: warm-up (`bh warmup status`, `bh warmup on` — a person's switch), then
the strategy can use them.

When something stops:

- **`failed`, with a task naming the cause.** A tenant refusing a domain another Google account
  still holds, a name taken between quote and purchase, a refusal by the registrar. Fix the cause
  (the task says how), then `bh domain retry <name>` — nothing is bought again. A failed purchase is
  approved again with `bh domain approve`, which places a new order.
- **Microsoft mailboxes waiting.** The tenant is out of licences: `bh tenant seats <id> --provider
microsoft` shows it. The engine buys them itself on the tenant's bill; it asks a person only when
it may not (the app lacks the billing role) or Microsoft refuses — the task says which.
- **A DKIM task.** Publish what the person minted: `bh domain dkim <name> --record "<TXT value>"`.

## Other DNS, and letting a domain go

- `bh domain dns <name>` lists its records; `bh domain dns <name> add --type TXT --host @ --content
"<value>"` adds a verification or a subdomain record (a person only). MX, SPF, DMARC and DKIM are
  the engine's and refused.
- `bh domain release <name>` lets a domain lapse at expiry (a person only; refused while a mailbox
  sends from it). Domains renew by themselves otherwise — a lapsed domain can be registered by
  anyone, who then receives the replies our leads send to it, so releasing is always a person's
  explicit decision, never inferred from disuse.

The agency's own domains, for senders who write for many clients, have the same commands under
`bh agency` (`agency quote`, `agency approve`, `agency order`, `agency orders`, `agency retry`),
and are an organisation admin's to buy.
