---
title: Forwarding rules with an allowlist guard
summary: >
  Adds email_create_forward_rule, email_list_forward_rules and
  email_delete_forward_rule on Gmail and Outlook. Forwarding only works for
  target addresses the user listed in EMAIL_MCP_FORWARD_ALLOWLIST, outside
  the reach of any tool.
type: plan
status: in-progress
tags: [email-mcp, gmail, outlook, forwarding, security]
projects: [email-mcp]
date: 2026-10-02
---

# Forwarding rules with an allowlist guard

## Why

Marlin collects all invoice mail in one address. Many vendors (first case: Anthropic)
send invoices only to the account's login address and offer no separate billing
address, so the mailbox needs a standing forward rule per vendor. email-mcp had block
rules (delete or archive) but no forward action.

## Decision

Marlin decided on 2026-10-02 (decision page
`~/software-dev/decision-pages/2026-10-02-email-mcp-forward-rules.html`): build it now,
with a guard, update the privacy policy in the same change, and tell Google in the
pending reply on the verification thread.

The reason for the guard: a standing forward rule copies future mail out of a mailbox
without anyone noticing, and an assistant that reads mail can be asked to create one by
the mail it reads (prompt injection). Gmail limits this, because it only forwards to
addresses the user confirmed in Gmail's settings. Outlook forwards anywhere.

## Design

| Piece | What it does |
|---|---|
| `EMAIL_MCP_FORWARD_ALLOWLIST` | Comma-separated addresses, read from the server's environment on every call. Unset or empty: forwarding is off. No tool, file or stored credential can add to it. |
| `email_create_forward_rule` | Checks the allowlist first (exact address, case-insensitive), then asks the provider. Same four match types as block rules. `keepInInbox` defaults to true, because forwarding and hiding the original is the stealthy variant. |
| Gmail | Looks the target up in `users.settings.forwardingAddresses` (readable with `gmail.settings.basic`). Missing or unconfirmed: the error names the manual step. Then a filter with `action.forward`. |
| Outlook | An inbox message rule with `actions.forwardTo`; archive plus stop-processing when `keepInInbox` is false. Same `MailboxSettings.ReadWrite` scope as block rules. |
| Idempotency | The same match forwarding to the same address returns the existing rule with `alreadyExisted: true`. |
| `email_list_forward_rules` | Every rule that forwards, identified by its action, so rules made by hand also show up. Works without an allowlist. |
| `email_delete_forward_rule` | Deletes by id, refuses an id that is not a forwarding rule. Works without an allowlist. |
| `email_list_block_rules` | No longer lists forwarding rules (it used to show them as `moveToJunk`). |
| iCloud, generic IMAP | No rule mechanism: the tools say so and point to the provider's settings. |

No new OAuth scope on either provider.

## Paths covered by tests

Allowlist unset, target not listed, target that only contains a listed address, case
differences, provider without the methods, Gmail address missing or pending, rule
already there, same match with a different target, missing permission (re-run the
setup wizard), delete of an id that is a block rule, empty accounts.

## Done in this change

Code, 40 tests, README, changelog, privacy policy section on what
`gmail.settings.basic` is used for, homepage and demo page tool lists.

## Open

- Tag v1.9.0 after the release pull request merges, and confirm the npm workflow
  published it (npm latest is 1.9.0). Version 1.9.0 is prepared, not yet published.
- Live check on a real Gmail account and a real Outlook account after the release:
  create, list, see the rule in the provider's settings, delete. The filter with
  `action.forward` under `gmail.settings.basic` follows Google's reference but has not
  run against the real API yet.
- The sentence to Google is in the reply drafted in Marlin's Gmail; it counts once
  he has sent it.
