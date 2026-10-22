# External calendars

An external calendar is a client's booking page Home has no integration with: a Calendly link, a
HubSpot meetings page, a Google booking page. The engine keeps only the link, whose it is (the
sender), how long a meeting on it lasts and its time zone. It reads nothing from the page and books
nothing there. **You** read its free times and book it, in a browser, and record each booking in
Home against that calendar so the goal, the reports and the colleague pause count it.

`bh calendars` shows one as `provider: external`, with `bookingUrl`, `name` (Calendly, HubSpot…),
`sender` and `meetingMinutes`. `bh slots` never lists its times: they are on its page.

## Adding one (a person)

`bh calendar add-external --url <booking link> --sender <id> [--minutes <n>] [--name <t>]
[--timezone <iana>]`. The link is the one a lead would open, for the sender who takes the meetings;
`--minutes` is the length the page books (30 when left out). Open it once in the browser first:
it must be a page that books with a name and an email, not a form that waits for someone to
confirm. Fix a setting later with `bh calendar update <id> [--minutes] [--name] [--sender]`; take
it out with `bh calendar archive <id>`.

## Reading free times

Only a session with a browser can: a person's Claude Code with the app's browser or Claude in
Chrome. A server agent cannot (below).

1. Open `bookingUrl`. If the page lets you choose the time zone, choose the lead's
   (`contacts.timezone`, else the company's, else where the company sits); otherwise note the zone
   the page shows and convert.
2. Read the next working days' free times. Choose two or three that suit what the lead asked, in
   their working hours.
3. Offer them as answers.md, Meetings says: the lead's own clock in the body, no zone label, no link.
   `bh slots offer` does not apply (it holds Cal.com slots only): put the times, in the page's zone
   and in UTC, and the calendar's name in the draft's `--note`. Nothing holds them for this lead, so
   they are read again before booking.

## Booking

When the lead plainly confirms one of the offered times:

1. Open the page again and find that time. Gone: offer again, never another time on your own.
2. Choose it and fill in the lead as the invitee: the name and the address from `bh thread` (the
   lead's own, never ours). Add a guest only where the project's rules say to. Answer a required
   question only with a fact from the thread or the brief; one you cannot answer goes to a person.
3. The final "Schedule" / "Confirm" is the booking: the page sends the lead the invitation. Say in
   chat what you are about to book (the lead, the time in their zone, the page) and press it only
   when the person said yes, or already asked you to book this lead at this time.
4. A CAPTCHA, a payment or a sign-in on the page: stop, and leave the booking to the person with
   what you found.
5. Record it at once, at the instant the page confirmed:
   `bh meeting record --thread <thread id> --calendar <calendar id> --at <iso, UTC>`. The calendar
   gives the meeting its name, length and sender (`--minutes` / `--sender` only when the page
   differed). The meeting then shows in `bh meetings` with the calendar and its `bookingUrl`, and the
   lead's colleagues pause as for any meeting.
6. Draft the confirmation: one line that the invite was sent and the time, as the lead reads it
   ("Great, I just sent over the invite for 1 pm. See you Monday!").

A meeting the lead booked on the page by themselves (a booking notice arrives in the thread) is
recorded the same way, step 5.

## Moving and cancelling

Home cannot change the booking: it is moved or cancelled on the page (the salesperson's own account,
or the reschedule / cancel link of the booking), usually by a person. Then, and only then, in Home:
`bh meeting move <id> --at <iso>` (a person; Home tells the lead nothing) or
`bh meeting cancel <id> [--reason <t>]` (the lead hears it from the page, not from us).
`bh meeting retry` does not apply: nothing of ours holds the event.

## The server agent

A scheduled run has no browser and may not record a meeting. When a reply needs times or a booking
and `bh slots` is empty while `bh calendars` lists an active external calendar:

- leave the answer undrafted, or draft only what needs no time;
- open an urgent task for the person who launched the strategy (their email as in SKILL.md, The
  server agent): `bh task open --title "Offer times to <lead> from <calendar name>" --assignee
  <email> --priority urgent --done-when "times are offered, or the meeting is booked" --body
  "<thread id>, <bookingUrl>, the lead's zone, what they asked"`; once they confirmed a time, the
  title is "Book <lead> at <time> on <calendar name>" and the body names the time in UTC.

The person's session then runs this file from "Reading free times" or "Booking".
