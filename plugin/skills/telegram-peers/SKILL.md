---
name: telegram-peers
description: Say which of a project's contacts each person a sender's Telegram already talks to is (a peer), with bh telegram peers / match / unmatch, so the plan's Telegram steps can reach them. Use when a sender's Telegram was just linked, before a strategy with a telegram_message step enrolls or its Telegram steps fall due, when leads' Telegram steps are skipped as no_telegram_peer, or when someone asks who a sender's Telegram knows.
---

# Telegram peers

A sender's own Telegram writes only to people it already talks to (docs/decisions/telegram.md). The
engine reads the account's one-to-one chats into **peers**: Telegram's id, the name the owner sees,
the username and the phone when Telegram shows them, whether they are a mutual contact, when they
last talked. It reads no message. Which of our contacts a peer is, it never guesses: that is a
judgement, and this skill is how an agent makes it.

A `telegram_message` step goes to a lead only when its sender's Telegram has a peer matched to the
lead's contact; otherwise the step is skipped as `no_telegram_peer` and the plan goes on. Enrolling
prefers a sender whose Telegram knows the lead. A match made before the step falls due still gets the
message, so match before a Telegram step's leads reach it (`bh behaviour telegram`).

## 1. The accounts

```
bh telegram
```

Each account: its sender, `status`, `peers` (people it may write to), `peersReadAt` and
`peersReadError`. A read runs every 15 minutes after linking, then every six hours. An account read
long ago, or just linked: `bh telegram peers <id> --refresh` reads it now. A `peersReadError` or a
`disconnected` account is a person's to fix (`bh telegram reconnect <id>` makes the link for its
owner): open a task (`bh task open`), do not match on stale peers.

## 2. The peers nobody matched

```
bh telegram peers <account-id> --unmatched
```

The latest first, at most 200 (`--search <text>` narrows by name, username or phone). Bots,
Telegram's own chats and accounts Telegram flags never appear; neither do peers set aside.

## 3. Find the contact each one is

For each peer, look for the contact in this project, strongest evidence first:

- **The phone.** A peer with a `phone` and a contact with the same number is a match. Compare
  digits only:

  ```
  bh sql "select c.id, c.first_name, c.last_name, c.title, co.name as company
          from contact_phones p join contacts c on c.id = p.contact_id
          left join companies co on co.id = c.company_id
          where p.project_id = @project and p.state = 'active'
            and regexp_replace(p.e164, '\D', '', 'g') = '<digits of the peer phone>'"
  ```

- **The name.** `bh contacts --q "<first> <last>"`. A full name that is one contact in the project,
  whose company and title fit what the sender's person would know them from, is a match. A first
  name alone, a nickname, an emoji, initials, or a name two contacts share is not: leave it.
- **The username.** A username that is the contact's name, or the one on their LinkedIn or site, backs
  a name match. It is never enough alone.

When unsure, leave the peer unmatched and list it for the sender's person: they know who their
chats are with. A wrong match writes to the wrong person from someone's own Telegram, which they
cannot take back; a missed one only skips a step.

## 4. Match

```
bh telegram match <peer-id> --contact <contact-id>
```

The engine refuses a contact of a project the account does not write for, a contact another peer
of the same account already is, and a peer that is no person. `bh telegram unmatch <peer-id>
--contact <contact-id>` takes a wrong match back. Each is recorded on the project with who made it.

## 5. What is not ours to do

- **Never set a peer aside on your own.** `bh telegram set-aside <peer-id>` is the owner's word that
  someone is family or a friend and must never be offered. An unmatched peer is never written to
  anyway; when a person says "not this one", set it aside then.
- **Never add a contact because a peer exists.** The owner's chats are not a source of leads: a peer
  is reached only when they already are a contact the project chose to write to.
- **Do not describe the owner's peers beyond the match.** Report what was matched and what was
  left, by name, to the people working the project; nothing about whom else the owner talks to.

## 6. Report

Tell the person what you matched (peer name → contact, and on what: phone, name and company) and
which peers you left and why, so they can match the rest. In a server run, open a task for the
sender's person with the unmatched peers that look like prospects.
