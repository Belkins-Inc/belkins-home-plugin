# Twilio Lookup

Checks a phone number before anyone dials it: whether the number exists, what kind of line it is,
the carrier, and the name it is registered to (US numbers). Base `https://lookups.twilio.com/v2`;
the engine signs in with an API key (HTTP Basic). **Off until a person sets `TWILIO_LOOKUP_KEY`** on
the engine: until then the call answers `503 not_configured`.

## Check a contact's number (a person's session)

```sh
bh phones <contact-id>                 # the numbers, with their ids
bh phones check <phone-id>
```

The engine asks Twilio for `line_type_intelligence` and `caller_name`, keeps the answer on the
number (`lookup` in `bh phones <contact-id>`) and acts on it:

- `valid: false` → the number is marked dead (`state: invalid`); no call list takes it.
- a line that is not a person's own phone (`landline`, `fixedVoip`, `nonFixedVoip`, `tollFree`,
  `voicemail`, …) → it goes last in the contact's dial order. `mobile` stays where it was.
- `callerMatches`: `person` when the registered name carries the contact's last name, `company`
  when it shares a word with the company's name, `other` for someone else's name, null when Twilio
  has no name. A mobile registered to someone else is the strongest sign Apollo's number reaches
  the wrong person — say so to whoever calls, or mark it dead with `bh phones set <phone-id>
  --state invalid --reason "<why>"` when you are sure.

Only a person may ask (it spends); a scheduled agent is refused. The same number checked within 30
days, for any contact of the organisation, is not paid again: its earlier answer is used
(`costUsd: 0`); `--again` asks afresh.

## Price

Twilio's list prices per request: line type $0.008, caller name $0.01 (US only); the format and
validity are free. A check is $0.018, booked as `phone_check` in `bh spend`. Not yet measured on our
account.

## Raw calls

`bh call twilio GET "/PhoneNumbers/%2B13125550100?Fields=line_type_intelligence,caller_name" --contact <id>`
works too, but writes nothing on the number: use `bh phones check`.
