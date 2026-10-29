---
title: Account signatures and a named From on outgoing mail
summary: >
  The sending tools add the Gmail signature of the send-as address, the way
  Gmail's web editor does, and the From header carries a display name.
  Outlook, iCloud and IMAP report that they have no signature to add.
type: plan
status: in-progress
tags: [email-mcp, gmail, signature, sending]
projects: [email-mcp]
date: 2026-10-29
---

# Account signatures and a named From on outgoing mail

## Why

Asked for by Marlin on 2026-10-29. A reply draft made with `email_draft_create` in the
founder account had no signature, because the Gmail API never appends one; only Gmail's
web editor does. The same draft carried a bare `From: founder@marlinjai.com`, and when it
was sent from Apple Mail the sent mail kept that nameless From.

## What it does

- `email_send`, `email_reply`, `email_forward`, `email_draft_create` and
  `email_draft_update` add the signature of the send-as address the mail goes out from
  (`users.settings.sendAs.list`, the entry matching the From address, else the default),
  in Gmail's markup (`gmail_signature_prefix` span plus a `gmail_signature` div), above
  any quoted history, and a plain-text rendering in the text part.
- A body that already holds a signature (a `gmail_signature` block, or an RFC 3676 `-- `
  line in text) is left alone, so `email_draft_update` never stacks one.
- `signature: false` turns it off per call. Every result carries `signature` with a status
  (`added`, `already_present`, `disabled`, `none_configured`, `unsupported`, `skipped`) and
  a reason where one applies. A failed read never blocks the mail or draft.
- The From header carries a display name: Gmail's send-as `displayName`, else the
  account's name, unless that name is only the provider label the setup wizard suggests.

## Decisions

- **Signatures are never copied out of sent mail**, always read from `sendAs`, on every
  call (no cache): older sent mail holds an outdated signature.
- **A text-only body gains an HTML part** when a signature is added. Gmail's editor always
  sends HTML, and the signature (logo, gold links) only exists as HTML. The text part stays
  as given, with the text signature appended.
- **Forward**: the signature goes on the note, so it lands between the note and the
  forwarded message. A text-only original is now escaped into the HTML part (before, the
  HTML part would have shown an empty forwarded message), and the header fields are
  HTML-escaped.
- **Reply** does not quote the original today; a caller-supplied `gmail_quote` block is
  respected (the signature goes above it). No quoting was added.
- **Outlook, iCloud, IMAP: no signature, reported as `unsupported`.** Graph has no
  signature API for Outlook.com accounts; IMAP servers keep none. A signature stored in
  email-mcp's account config was rejected: it would be a second copy that drifts from the
  mail client's, the same failure as the outdated signature in old sent mail.
- **From fallback skips provider labels.** The wizard suggests "Gmail", "Outlook",
  "iCloud" as account names; those, or the address itself, never become a display name.
  When the Gmail settings cannot be read, From falls back to the account name and the
  signature outcome reports the failure. Outlook sets From itself and is unchanged.
- **Default on** for every Gmail caller. Listed under "Changed" in the changelog.
