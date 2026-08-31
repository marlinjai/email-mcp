# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.5.0] - 2026-08-31

Merged four community contributions (thank you [@EduardF1](https://github.com/EduardF1) and [@JosueM1109](https://github.com/JosueM1109)):

### Fixed
- **IMAP/iCloud auto-reconnect after idle/server-side disconnect** (#11) — the adapter no longer throws "Not connected" after a dropped socket; it transparently rebuilds the connection on the next call, with concurrent callers sharing a single in-flight reconnect.
- **iCloud `search()` silently returned nothing for Junk/Trash** (#9) — iCloud reports `exists: 0` on `SELECT` for those folders even when they have messages. Now confirmed with `STATUS` before short-circuiting. This also repairs 17 IMAP/iCloud tests that were red on `main` (stale `fetchAll` mocks left behind when the adapter migrated off the old `fetch()` API) — full suite is green again.
- **`credentials.enc` could become permanently undecryptable after a hostname change** (#8, fixes #4) — the encryption key was derived from `os.hostname()`, which macOS can silently renumber (mDNS/Bonjour naming conflicts). Now derived from a stable machine identifier (`IOPlatformUUID` on macOS, `/etc/machine-id` on Linux, `MachineGuid` on Windows), with an `EMAIL_MCP_KEY` env var override for full portability. Existing credential files decrypt via the legacy seed and are transparently re-encrypted with the new one — no manual recovery needed.
- **`createDraft` failed on Gmail connected via generic IMAP** (#7, fixes #3) — hardcoded a top-level `Drafts` folder, which doesn't exist on Gmail (`[Gmail]/Drafts` or a localized name like `[Gmail]/Entwürfe`). Now resolved via the adapter's existing `resolveFolder()` helper.

### Added
- **`email_save_attachment` tool** (from #5, adapted) — downloads an attachment directly to disk and returns metadata only, avoiding the token cost of round-tripping large attachments as base64 through the calling LLM. The output path is restricted to a configurable base directory (`EMAIL_MCP_DOWNLOADS_DIR`, defaulting to `~/.email-mcp/downloads`) with path-traversal rejected — the original PR accepted any absolute path from the tool caller with no validation, which would have let a malicious or manipulated prompt write to arbitrary locations on the host filesystem.

## [1.4.4] - 2026-08-30

### Fixed
- **`email_create_block_rule` with `action: 'moveToJunk'` on Gmail failed live with "Invalid label SPAM in AddLabelIds"**, even with the 1.4.3 scope fix in place. Confirmed empirically against the real API (not just docs): Gmail's Filter Action rejects the SPAM label — only Gmail's own spam classifier can apply it, a standing filter cannot. `moveToJunk` on Gmail now maps to `removeLabelIds: ['INBOX']` (skip the inbox), the closest a filter can actually do; `email_report_spam` is unaffected and still applies SPAM correctly, since that's a direct per-message action, not a filter.

## [1.4.3] - 2026-08-30

### Fixed
- **`email_create_block_rule`/`email_list_block_rules` on Gmail failed with "Request had insufficient authentication scopes"**, even for freshly re-authenticated accounts. Google's Gmail Settings API (which the Filters resource lives under) is a separate permission domain from mailbox content access — the existing `https://mail.google.com/` scope does not cover it. Added `https://www.googleapis.com/auth/gmail.settings.basic` to `GMAIL_SCOPES`. Same shape of bug as the Outlook `MailboxSettings.ReadWrite` gap fixed in 1.4.0: existing Gmail accounts need one re-auth via `email-mcp-setup` to pick up the new scope.

## [1.4.2] - 2026-08-30

### Security
- **`email-mcp-setup`'s password prompt (iCloud/generic IMAP) echoed the typed password in plaintext instead of masking it as `*`**, when run via `npx` — the masking logic gated on `input.isTTY`, which reports falsy in at least one real, genuinely interactive session launched through `npx`, even though the OS terminal was still echoing keystrokes normally underneath. The fix no longer trusts that flag: it attempts `setRawMode(true)` directly and only falls back to plain (visible) input if that call itself throws. If you entered a real password/app-specific-password through `email-mcp-setup` on 1.4.1 or earlier, rotate it — it would have been visible in your terminal scrollback (and copied into anywhere that scrollback was captured, e.g. a chat transcript) instead of masked.
- Fixed a related process-hygiene bug found while fixing the above: the CLI could finish successfully but not exit on its own (a stray handle from the password prompt's raw-mode/interface-recreation cycle kept the event loop alive) — indistinguishable from a hang to anyone watching. The CLI now calls `process.exit()` explicitly once its work is done.

## [1.4.1] - 2026-08-30

### Fixed
- **`email-mcp-setup` hung silently with no output or error** in at least one real terminal. Replaced `inquirer` (whose list/rawlist prompts redraw via ANSI cursor movement and terminal-capability queries) with plain `node:readline/promises`-based prompts (`src/setup/prompts.ts`), removing that entire class of raw-mode-rendering risk. `inquirer` dropped as a dependency. Verified via piped smoke tests of the IMAP and iCloud setup flows (masked-password path only checked via its non-TTY fallback — the raw-mode `*`-echo path needs a real terminal to confirm).

## [1.4.0] - 2026-08-28

### Added
- **Spam moderation tools**: `email_report_spam` / `email_batch_report_spam` (trains the provider's own filter — the same signal "Report Junk" sends — instead of just deleting, which teaches the filter nothing), and `email_create_block_rule` / `email_list_block_rules` / `email_delete_block_rule` (standing rules that intercept future mail before it's filed). Backed by new optional provider primitives `reportSpam()` / `createBlockRule()` / `listBlockRules()` / `deleteBlockRule()`.
  - **Gmail**: `reportSpam` via `users.messages.modify` (SPAM label); block rules via `users.settings.filters` (the `query` field is the fallback for matching arbitrary header content, since Gmail's filter API has no dedicated field for it).
  - **Outlook**: `reportSpam` via move-to-`junkemail`; block rules via Graph `messageRules`, including native `headerContains` support — the right predicate for blocking a spam template family by its stable Reply-To/header domain when the visible "From" domain rotates. **Requires re-running the setup wizard once** for accounts authenticated before this release: the new `MailboxSettings.ReadWrite` scope (confirmed by Microsoft's docs to be supported on personal Microsoft accounts, not just work/school) wasn't previously requested, so cached tokens will 403 on block-rule calls until re-consent.
  - **iCloud/generic IMAP**: `reportSpam` only (best-effort move to the Junk-typed folder via existing alias resolution) — block rules are intentionally unsupported, since no standard server-side rule mechanism exists across IMAP servers.
- Design doc: `docs/plans/2026-08-27-spam-report-and-block-rules.md`.

## [1.3.0] - 2026-06-13

### Added
- **`email_transfer` tool** — move or copy emails between accounts (e.g. iCloud/Outlook into Gmail) while preserving the original message intact (sender, date, threading) by transferring the raw MIME. With `deleteAfter=true` the source copy is trashed only after a confirmed import, making it a safe cross-account move. Backed by new optional provider primitives `getRawMessage()` / `appendRawMessage()` implemented for Gmail (messages.get raw / messages.insert), IMAP+iCloud (FETCH source / APPEND), and Outlook (Graph `$value` / MIME import).

### Fixed
- **Gmail search `offset` was ignored**, so paginating an inbox returned the same first page every time. Gmail's API has no numeric offset (only an opaque `pageToken`), so `search()` now pages forward through the lightweight message-id list until it reaches `offset + limit` and fetches full bodies only for that window. IMAP and Outlook already honored `offset`.

## [1.2.8] - 2026-03-16

### Fixed
- **Root cause fix for iCloud Junk/Trash "Invalid message number"** — `fetchEmails()` now uses `fetchAll()` with `{ uid: true }` option instead of `for await ... fetch()`. The original code passed UID arrays without telling ImapFlow they were UIDs (not sequence numbers), causing iCloud to reject the FETCH command
- `collectUidsViaFetch()` also switched from async iterators to `fetchAll()` for reliable error handling
- Search and fetch fallback chain hardened — any failure at any level is caught and falls through gracefully

## [1.2.7] - 2026-03-16

### Fixed
- iCloud Junk/Trash folder search rewritten — `fetchAll()` replaces async iterators (`for await`) so IMAP errors are properly catchable instead of being lost in the stream
- Any SEARCH failure now triggers FETCH fallback (no longer requires "Invalid message number" pattern match)
- Empty folder defaults changed from `-1` to `0` so `effectiveCount` correctly detects empty folders

## [1.2.6] - 2026-03-16

### Fixed
- Empty folder detection now handles unknown message counts — `effectiveCount <= 0` instead of `=== 0` prevents search attempts when both `STATUS` and `mailbox.exists` return unknown (-1), which caused "Invalid message number" errors on empty iCloud folders

## [1.2.5] - 2026-03-15

### Fixed
- `email-mcp-setup` bin now includes shebang (`#!/usr/bin/env node`) and executable permissions — previously failed when invoked via `npx email-mcp-setup`

## [1.2.4] - 2026-03-15

### Fixed
- iCloud Junk folder search no longer fails with "Invalid message number" — uses `STATUS` command to get real message count when `mailbox.exists` reports 0 (iCloud server bug)
- SEARCH fallback now triggers on "Invalid message number" even when text-based search criteria are present (previously only triggered with no criteria)
- Multi-level FETCH fallback chain: `FETCH 1:*` → explicit range `FETCH 1:N` → individual sequence fetches (most resilient against iCloud quirks)

### Added
- `client.noop()` before search to refresh stale IMAP connection state
- `client.status()` pre-check to detect real message count independently of SELECT
- Comprehensive iCloud Junk folder fallback tests (6 new test cases)

## [1.2.3] - 2026-02-20

### Fixed
- IMAP/iCloud `deleteEmail()` and `batchDelete()` no longer hardcode `'Trash'` as move destination — now uses `resolveFolder('Trash')` to find the provider-specific trash folder (e.g., iCloud's "Deleted Messages")
- Deleting emails already in the trash folder now uses permanent delete instead of attempting to move trash→trash
- `sourceFolder` parameter in delete operations is now resolved through `resolveFolder()`, so passing "Trash" on iCloud correctly opens "Deleted Messages"

## [1.2.2] - 2026-02-20

### Fixed
- Outlook OAuth tokens now refresh automatically mid-session — `getProvider()` detects expired tokens and reconnects instead of failing with "JWT is not well formed"
- Token refresh errors now propagate instead of being silently swallowed, giving clear error messages when re-authentication is needed
- Invalid Date handling in token expiry check — `new Date('')` no longer bypasses the refresh logic

### Added
- Mid-session token expiry detection in `AccountManager.getProvider()` — automatically disconnects and reconnects when OAuth token expires
- Access token validation after refresh — empty tokens from MSAL are rejected with actionable error messages

## [1.2.1] - 2026-02-20

### Fixed
- iCloud IMAP search no longer fails with "Invalid message number" — falls back to direct FETCH when UID SEARCH is rejected
- Outlook "Id is malformed" errors on older messages — Graph API now uses immutable IDs (`Prefer: IdType="ImmutableId"`) that survive folder moves

### Added
- `collectUidsViaFetch()` fallback for IMAP servers that reject UID SEARCH ALL (e.g. iCloud)
- `fetchEmails()` extracted method for reusable UID-based email fetching
- Early return when IMAP mailbox reports zero messages (avoids unnecessary SEARCH on empty folders)

## [1.2.0] - 2026-02-20

### Fixed
- Outlook OAuth token renewal now works automatically — tokens no longer expire and require manual re-authentication
- IMAP search errors now surface actionable server messages instead of opaque "Command failed"

### Changed
- Outlook auth uses MSAL file-based cache persistence (`~/.email-mcp/msal-cache.json`) for refresh token survival across process restarts
- Token refresh uses `acquireTokenSilent()` instead of broken `acquireTokenByRefreshToken('')` approach
- `refreshTokenIfNeeded()` now logs refresh failures instead of silently swallowing them

### Added
- `OutlookAuth.refreshTokenSilent()` method using MSAL's persisted cache and `acquireTokenSilent()`
- `msal_home_account_id` field on `OAuthTokens` for identifying the cached MSAL account
- File-based `ICachePlugin` implementation for MSAL token cache persistence

## [1.1.2] - 2026-02-19

### Fixed
- IMAP folder search errors now surface actual server response instead of opaque "Command failed"
- Search on iCloud Junk folder no longer fails silently — added folder resolution that matches by path, name, special-use flag, or common aliases
- ImapFlow `search()` returning `false` on server rejection no longer crashes with TypeError on `.slice()`

### Added
- `formatImapError()` helper that extracts `responseText`, `serverResponseCode`, and `mailboxMissing` from ImapFlow errors
- `resolveFolder()` method that resolves folder names against the server's folder list, handling provider-specific naming (e.g., iCloud "Deleted Messages" vs "Trash")
- Outlook batch requests now use sequential numeric IDs to avoid case-insensitive collision on message IDs
- Outlook API endpoints now URL-encode message IDs and folder paths

## [1.1.1] - 2026-02-19

### Changed
- Reverted build-time credential injection — OAuth PKCE credentials are now directly in source (industry standard for public CLI clients)
- Removed `.env.example` (no longer needed)

## [1.1.0] - 2026-02-19

### Added
- Built-in OAuth credentials for Gmail and Outlook (PKCE) — users no longer need to create their own OAuth apps
- Zero-config setup for Gmail and Outlook via the interactive wizard

### Fixed
- Gmail PKCE flow now correctly passes `codeVerifier` to token exchange
- OAuth callback server accepts both `/callback` and `/` paths (fixes Outlook redirect)
- Build now produces correct shebangs (CLI entry only) and sets executable permissions
- Token refresh uses real OAuth credentials instead of empty strings

## [1.0.1] - 2026-02-19

### Fixed
- Added `mcpName` field to package.json for MCP Registry validation

## [1.0.0] - 2026-02-19

### Added
- Multi-provider email support: Gmail (REST API), Outlook (Microsoft Graph), iCloud (IMAP), generic IMAP/SMTP
- 24 MCP tools across 5 categories: account management, reading, sending, organization, batch operations
- Batch operations: `email_batch_delete`, `email_batch_move`, `email_batch_mark` with provider-native implementations
- Lightweight search mode (`returnBody=false` by default) reducing payload from ~1.4MB to ~20KB
- `sourceFolder` parameter for IMAP/iCloud move, delete, and mark operations
- Outlook folder resolution with localized display name support (English, German, Spanish, French)
- Interactive setup wizard with multi-account support ("add another?" loop)
- OAuth2 browser-based flows for Gmail and Outlook
- AES-256-GCM encrypted credential storage
- Sequential fallback for batch operations on providers without native batch support

[1.2.3]: https://github.com/marlinjai/email-mcp/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/marlinjai/email-mcp/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/marlinjai/email-mcp/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/marlinjai/email-mcp/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/marlinjai/email-mcp/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/marlinjai/email-mcp/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/marlinjai/email-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/marlinjai/email-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/marlinjai/email-mcp/releases/tag/v1.0.0
