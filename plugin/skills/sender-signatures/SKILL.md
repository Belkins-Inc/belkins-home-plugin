---
name: sender-signatures
description: Build a sender's email signature — the plain-text one and an HTML one with links, a layout and a photo — and put it on the sender or on one project through `bh`. Use when a signature should have clickable links or a photo, when someone hands over a signature (a screenshot, an HTML file, a description) to reproduce, or when a signature shows raw URLs.
---

# Sender signatures

Every email carries its sender's signature after the body. A sender has two:

- **`signature`** — plain text. Always set: it is the text part of every email, and the whole
  email for a sender without the HTML one.
- **`signatureHtml`** — optional. When set, the engine sends each email as text **and** HTML
  (multipart/alternative): the text part is exactly the body plus `signature`, the HTML part is the
  body laid out as a mail client lays out what a person types, with `signatureHtml` after it. A
  mail client shows the HTML one.

An agency sender put on a project signs there with the project's own signature (it names the
client); each of the two falls back to the sender's own when the project leaves it empty.

Setting either is a person's decision: `bh` refuses it on a scheduled agent's token. Work in a
person's session, show them the result, set it when they agree.

## 1. Gather what goes in

From the screenshot, file or description: name, title, company, the link(s) with their text
("Book a meeting with me." → the calendar URL), phone numbers, email, a tagline, a photo. Ask for
what is missing rather than inventing it — a wrong phone number goes to every lead.

A postal address and an opt-out line are not required: put them in only when the client asks.
Do not ask for them, and do not hold a signature or a strategy back for them — which laws apply
(CAN-SPAM, GDPR, PECR) is the client's call, not ours.

Keep it short: one or two links (a calendar, a site), no link shorteners, no tracking parameters,
no social icon rows. Every link and picture is weighed by spam filters on a cold first touch.

## 2. The photo (only when asked for)

A picture is sent inside every message (never from a server: Outlook blocks remote pictures, and one
host in every client's mail is a fingerprint). It must be small.

```sh
# 2× the size it shows at: a photo shown 100 px wide is saved 200 px wide, JPEG.
sips -Z 200 -s format jpeg -s formatOptions 80 photo.png --out photo-200.jpg   # macOS
magick photo.png -resize 200x200 -quality 80 photo-200.jpg                    # ImageMagick
bh sender image <sender-id> photo-200.jpg        # PNG, JPEG or GIF, 100 KB at most
```

It answers `{"id", "src": "cid:<id>"}` — the `src` goes into the HTML as it is. `bh sender images
<id>` lists what a sender has; `bh sender image-remove <id> <image-id>` removes one no signature
shows.

## 3. Write the HTML

What every mail client renders the same way — as a person's own signature would be:

- **Tables** for layout (`cellpadding="0" cellspacing="0" border="0"`), no divs positioned by CSS.
- **Inline styles only** (`style="…"`), no `<style>` block. Web-safe fonts: Arial, Helvetica,
  Verdana, Georgia. 13–14 px text.
- A picture: `<img src="cid:<id>" width="100" alt="<name>" style="display:block;border:0">` — the
  `width` attribute, because Outlook ignores CSS sizes.
- Links: `<a href="https://…" style="color:#1a0dab">text</a>`; phone as `tel:`, email as `mailto:`.
- The engine refuses scripts, event handlers, forms, iframes, web fonts, and any picture or
  background loaded from an address — it says what and where.

A photo on the left, the details on the right:

```html
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#222">
  <tr>
    <td style="padding-right:12px;vertical-align:top">
      <img src="cid:<image-id>" width="100" alt="<Name>" style="display:block;border:0">
    </td>
    <td style="vertical-align:top;line-height:18px">
      <b style="color:#1f3c88;font-size:14px"><Name></b><br>
      <Title><br>
      <a href="<calendar-url>" style="color:#1a0dab">Book a meeting with me.</a><br><br>
      <Tagline><br><br>
      <b>P:</b> <a href="tel:<+phone>" style="color:#1a0dab"><phone></a><br>
      <b>E:</b> <a href="mailto:<email>" style="color:#1a0dab"><email></a>
    </td>
  </tr>
</table>
```

And its plain text, the same details in order, links as bare URLs:

```text
<Name>
<Title>
Book a meeting with me: <calendar-url>
P: <phone>
```

## 4. Set it

```sh
# the sender's own (a project's sender, or an agency sender's fallback)
bh sender update <sender-id> --signature "$(cat signature.txt)" --signature-html-file signature.html
# an agency sender's, on this project only
bh sender share <sender-id> --signature "$(cat signature.txt)" --signature-html-file signature.html
# a new sender: the HTML may show a photo only once it is uploaded, so add, upload, then update
```

An empty `--signature-html-file` clears the HTML one: the sender goes back to plain text.

## 5. Check it as the lead will see it

```sh
bh sender signature <sender-id> --out signature-preview.html && open signature-preview.html
bh preview <message-id>        # a written message: its text, and `html` with the photo inlined
```

Show the person the preview before any strategy sends with it. The web app shows it on the
project's Senders screen too.
