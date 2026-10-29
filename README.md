# @marlinjai/email-mcp

<p align="center"><img src="assets/icon-512.png" width="120" height="120" alt="email-mcp logo"></p>

A unified MCP server for email access across Gmail, Outlook, iCloud, and generic IMAP providers.

## Features

- **Multi-provider support** -- Gmail (REST API), Outlook (Microsoft Graph), iCloud (IMAP), and generic IMAP/SMTP
- **OAuth2 authentication** -- Browser-based OAuth flows for Gmail and Outlook, with automatic token refresh
- **Full email client** -- Search, read, send, reply, forward, organize, and manage drafts
- **Batch operations** -- Delete, move, or mark hundreds of emails in a single call
- **Lightweight search** -- Compact search results by default (~20KB vs ~1.4MB) with optional full body retrieval
- **Encrypted credential storage** -- AES-256-GCM encryption at rest with a required independent secret
- **Provider-native APIs** -- Uses Gmail API and Microsoft Graph where available for richer features, falls back to IMAP for universal compatibility

## Installation

This checkout includes local security changes that are not published to npm. Build and run this checkout to use them; `npx @marlinjai/email-mcp` runs the upstream package instead.

```bash
npm ci --ignore-scripts
npm run build
```

## Quick Start

1. Generate a random key once (for example, `openssl rand -hex 32`), store it in your password manager, and supply the same `EMAIL_MCP_KEY` to setup and the MCP process through a trusted environment or secret manager. Do not regenerate it on every startup or commit it to a config file. A missing or shorter-than-32-character key is rejected.
2. Run `node dist/setup/wizard.js` to authorize an account. Gmail and Outlook default to read-only permissions.
3. Configure your MCP host to launch the local build, inheriting the key:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/absolute/path/to/email-mcp/dist/index.js"],
      "env": {
        "EMAIL_MCP_ACCOUNT_IDS": "<account-id-from-setup>"
      }
    }
  }
}
```

If your desktop host does not inherit shell environment variables, inject the key using its private secret configuration. The default tool set is read-only. Explicitly enabling send/reply and migrating existing accounts are covered in [SECURITY.md](SECURITY.md).

## HTTP MCP

Keep the same `EMAIL_MCP_KEY`, data directory, account allowlist and tool allowlist used by stdio. Supply a **separate** random `EMAIL_MCP_HTTP_TOKEN` (32–256 URL-safe characters) through your private environment/secret manager, then start:

```bash
node dist/index.js --transport http
```

The endpoint is `http://127.0.0.1:3000/mcp`. You can also set `EMAIL_MCP_TRANSPORT=http`; `--transport stdio` explicitly selects the original transport. HTTP startup never opens the setup wizard; authorize accounts locally beforehand.

Configure a client that supports Streamable HTTP and custom headers:

```json
{
  "mcpServers": {
    "email": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <HTTP_TOKEN_FROM_YOUR_PRIVATE_SECRET_STORE>"
      }
    }
  }
}
```

The header value above is a placeholder; keep the actual token out of tracked files. This is static Bearer authentication, not an OAuth login/discovery endpoint. The HTTP token grants the same process-wide mailbox permissions to every client that holds it.

| Setting | Default | Purpose |
| --- | --- | --- |
| `EMAIL_MCP_HTTP_TOKEN` | Required | HTTP access secret, distinct from the encryption key |
| `EMAIL_MCP_HTTP_HOST` | `127.0.0.1` | Listening IP or `localhost` |
| `EMAIL_MCP_HTTP_PORT` | `3000` | Listening port (`0` selects a free port) |
| `EMAIL_MCP_HTTP_ALLOWED_HOSTS` | Loopback names with the listening port | Exact comma-separated Host headers, including ports when present |

For remote access, keep the listener private behind an HTTPS reverse proxy or encrypted tunnel. If the proxy preserves a public Host header, configure it explicitly, for example `EMAIL_MCP_HTTP_ALLOWED_HOSTS=mail.example.com`. Binding to a non-loopback address also requires an explicit host allowlist; this option does not enable TLS. Forward `Authorization` and the MCP headers, and disable caching. Do not expose unencrypted HTTP to an untrusted network.

This uses [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) with stateless JSON responses. Each request gets its own transport and account connections. GET/DELETE return 405; legacy `/sse`, resumable streams and browser/CORS clients are not supported. Requests with an Origin header are rejected. Request bodies are limited to 1 MiB and there are at most 16 in-flight requests; use path-based attachments or stdio for larger inputs. SIGINT/SIGTERM drain requests for up to 10 seconds. A disconnected or interrupted send may already have reached the provider: check Sent before retrying.

## Provider Setup Guides

### Gmail

After configuring the encryption key, the setup wizard uses the built-in OAuth client (PKCE):

```bash
node dist/setup/wizard.js
# Select "Gmail" when prompted
# Choose "Read only" (default), or explicitly authorize additional capabilities
# A browser window opens for Google authorization
# Grant the requested permissions and return to the terminal
```

The wizard asks which Gmail permission scope to authorize:

- **Read only** (default) — mailbox reads (`gmail.readonly`).
- **Read and send** — reads plus sending (`gmail.readonly` + `gmail.send`), without message modification or settings access.
- **Full** — everything below, plus immediate, Trash-bypassing permanent deletion (`https://mail.google.com/`, Gmail's maximum-permission scope).
- **Restricted** — read, send, label, archive, and move-to-trash (`gmail.modify` + `gmail.settings.basic`), but no permanent deletion. Every tool in this server works identically under Restricted except an explicit `permanent: true` delete, which fails with a Gmail API error instead of succeeding.

Pass `--scope readonly|read-send|restricted|full` to skip the prompt, or set `EMAIL_MCP_GMAIL_SCOPE` in the setup environment. An unknown mode is rejected.

> **Verification status (1 October 2026):** Google's review of the shared OAuth app is still running, so Google currently only lets accounts on its test-user list sign in through it; everyone else sees the "has not completed the Google verification process" screen and needs their own OAuth app (next note). The last open step for the shared app is a yearly independent security assessment (CASA, Cloud Application Security Assessment) that Google has requested. Because email-mcp has no server of its own, its applicability is being clarified with Google. Details and current status: [email.lumitra.co/privacy#google-verification](https://email.lumitra.co/privacy#google-verification), tracked in [issue #1](https://github.com/marlinjai/email-mcp/issues/1).

> **Note:** If you prefer to use your own OAuth app instead of the shared one this package ships with, create a Desktop OAuth 2.0 Client in the [Google Cloud Console](https://console.cloud.google.com/) with the Gmail API enabled, then set `EMAIL_MCP_GMAIL_CLIENT_ID` and `EMAIL_MCP_GMAIL_CLIENT_SECRET` in the environment before running the setup wizard (and in the MCP server's environment, since re-authentication uses the same variables). This gives you your own token lifecycle, independent of the publisher's Cloud project, and sidesteps Google's unverified-app warning and 100-test-user cap for your own account(s) once you add yourself as a test user on your own app.

### Outlook

`EMAIL_MCP_OUTLOOK_SCOPE` accepts `readonly` (default: `Mail.Read`), `read-send` (`Mail.Read` + `Mail.Send`, new messages only), `read-write` (`Mail.ReadWrite` + `Mail.Send`, needed for the current reply/draft flow), or `full` (`Mail.ReadWrite` + `Mail.Send` + `MailboxSettings.ReadWrite`). All modes request `offline_access`. Use the same setting for setup and the MCP process.

After configuring the encryption key, the setup wizard uses the built-in OAuth client (PKCE):

```bash
node dist/setup/wizard.js
# Select "Outlook" when prompted
# A browser window opens for Microsoft authorization
# Sign in and grant the requested permissions
```

> **Note:** If you prefer to use your own OAuth app, register one in the [Azure Portal](https://portal.azure.com/) with `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite` (needed for `email_create_block_rule`), and `offline_access` permissions, then set `EMAIL_MCP_OUTLOOK_CLIENT_ID` in the environment before running the setup wizard.

### iCloud

1. Go to [appleid.apple.com](https://appleid.apple.com/) and sign in.
2. Navigate to **App-Specific Passwords** and generate a new password.
3. Run the setup wizard:

```bash
node dist/setup/wizard.js
# Select "iCloud" when prompted
# Enter your iCloud email address
# Enter the app-specific password you generated
```

### Generic IMAP

Run the setup wizard with your IMAP/SMTP server details:

```bash
node dist/setup/wizard.js
# Select "Other IMAP" when prompted
# Enter your IMAP host, port, and credentials
# Optionally enter SMTP host and port for sending
```

## Available Tools (36)

### Account Management (4)

| Tool | Description |
|------|-------------|
| `email_list_accounts` | List all configured accounts with connection status |
| `email_add_account` | Add a new IMAP or iCloud account (Gmail/Outlook require setup wizard) |
| `email_remove_account` | Remove an account and its stored credentials; revokes the Google grant for Gmail, removes Outlook tokens from the local token cache, and reports the outcome |
| `email_test_account` | Test connection to an account |

### Reading & Searching (6)

| Tool | Description |
|------|-------------|
| `email_list_folders` | List all folders/labels for an account |
| `email_search` | Search emails with filters. Returns compact results by default (`returnBody=false`). Set `returnBody=true` to include full email bodies |
| `email_get` | Get full email content by ID (headers, body, attachment metadata). `sourceFolder` names the folder on iCloud/IMAP when the message is not in INBOX |
| `email_get_thread` | Get an entire email thread/conversation. On iCloud/IMAP a thread is searched in one folder: INBOX, or the one named in `sourceFolder` |
| `email_get_attachment` | Download a specific attachment by ID (returns base64 data). `sourceFolder` names the folder on iCloud/IMAP when the message is not in INBOX |
| `email_save_attachment` | Download an attachment directly to disk, returning metadata only, which avoids the token cost of round-tripping large files as base64. `outputPath` is relative to a fixed downloads directory (`~/.email-mcp/downloads`, override with `EMAIL_MCP_DOWNLOADS_DIR`) and cannot escape it. `sourceFolder` as on `email_get_attachment` |

### Sending & Drafts (6)

`email_send`, `email_reply`, `email_forward`, `email_draft_create` and `email_draft_update` take an optional `attachments` list. Each entry is either `{ path }` (a file in the attachments folder, see below) or `{ content, filename }` (base64), with an optional `contentType` (inferred from the extension otherwise). The total is capped at 25 MB; Outlook accepts up to 3 MB per message through this server. On `email_draft_update` a list replaces the draft's files, an empty list removes them, and no list keeps the files the draft has.

**Gmail adds your signature, like Gmail's own editor.** The Gmail API never appends one, so `email_send`, `email_reply`, `email_forward`, `email_draft_create` and `email_draft_update` read the signature of the send-as address the mail goes out from (Gmail settings, read on every call, so a changed signature applies at once) and add it in Gmail's own markup (`gmail_signature`), above any quoted history, plus a plain-text rendering in the text part. A text-only body gains an HTML part for it, as the signature's logo and links only exist as HTML. A body that already holds a signature (a `gmail_signature` block, or a `-- ` line in text) is left alone, so passing a draft's body back to `email_draft_update` never stacks a second one. `signature: false` turns it off for one call. Each of these tools returns a `signature` field saying what happened: `added`, `already_present`, `disabled`, `none_configured`, `unsupported`, or `skipped` with the reason (for example a missing permission); a failed read never blocks the mail or draft.

**Outlook, iCloud and IMAP add no signature.** Microsoft Graph has no signature API for Outlook.com accounts (signatures live in the Outlook clients, out of reach for a server), and an IMAP or iCloud server keeps no signature at all. The tools report `unsupported` there instead of inventing one; put the signature in the body when the mail needs it. A signature stored in email-mcp's own account settings was considered and left out on purpose: it would be a second copy that drifts from the one in the mail client, which is exactly how old mail ends up with an outdated signature.

**From names you.** The From header carries a display name, not just the address: on Gmail the send-as display name from Gmail's settings, otherwise the account's name in email-mcp (unless that is only a label: a provider name such as "Gmail" or "iCloud", or the address's local part such as "founder"). Gmail often keeps no display name for an account's primary address (its web editor then uses the Google profile name, which this server cannot read); set one under Settings, Accounts, "Send mail as", edit info, and the tools use it. This also holds for a draft sent later from another mail program, which keeps the draft's From. Outlook sets From itself.

Replies stay in their thread: `email_reply` sends inside the original conversation on Gmail and Outlook (and sets the `In-Reply-To` and `References` headers everywhere), `email_draft_create` with `inReplyToEmailId` saves a reply draft in that thread, and `email_draft_update` keeps a reply draft there.

**Forwarding the original message's attachments is opt-in.** `email_forward` sends the text of the original; its files go along only with `includeOriginalAttachments: true`, so one call does not pass files the assistant never looked at on to another address. Forwarded files count against the 25 MB cap together with added ones.

**Attaching files by path is off until you name a folder.** The path comes from the assistant, and an assistant that reads mail can be asked by a mail to attach something it should not (a private key, for example). So files are only read from the one folder you set in `EMAIL_MCP_ATTACHMENTS_DIR`, in the environment of the server; no tool can change it. Put the file there and ask for it by name:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["@marlinjai/email-mcp"],
      "env": { "EMAIL_MCP_ATTACHMENTS_DIR": "~/Documents/email-outbox" }
    }
  }
}
```

A path outside that folder is refused, as is a symbolic link that leads out of it, and email-mcp's own data files are never attachable.

| Tool | Description |
|------|-------------|
| `email_send` | Compose and send a new email (to, cc, bcc, subject, body, attachments) |
| `email_reply` | Reply to an email in its thread. `replyAll` addresses the sender and all To/Cc recipients except your own address, each once. Optional `to`/`cc`/`bcc` overrides and `additionalRecipients`, e.g. when replying to your own sent message. Attachments supported. `sourceFolder` names the folder on iCloud/IMAP when the message is not in INBOX |
| `email_forward` | Forward an email to new recipients (`to`, `cc`, `bcc`, optional text on top, attachments). The original's attachments are left out unless `includeOriginalAttachments: true`. `sourceFolder` names the folder on iCloud/IMAP when the message is not in INBOX |
| `email_draft_create` | Save a draft without sending (attachments supported). `inReplyToEmailId` saves it as a reply inside that message's thread (`inReplyToSourceFolder` names that message's folder on iCloud/IMAP when it is not in INBOX) |
| `email_draft_update` | Update an existing draft in place. A reply draft stays in its thread. On Gmail/Outlook the draft id is unchanged; on iCloud/generic IMAP there's no in-place update (IMAP messages are immutable), so the old draft is deleted and a new one appended: the returned id is a **new** id, always use it going forward |
| `email_draft_list` | List all drafts |

### Organization (8)

| Tool | Description |
|------|-------------|
| `email_move` | Move an email to a different folder. Supports `sourceFolder` for IMAP/iCloud |
| `email_transfer` | Move or copy emails **between accounts**, preserving the original message (sender, date, threading) via raw MIME transfer. `deleteAfter=true` trashes the source only after a confirmed import (safe cross-account move) |
| `email_delete` | Delete an email (trash or permanent). Supports `sourceFolder` for IMAP/iCloud |
| `email_mark` | Mark as read/unread, starred, or flagged. Supports `sourceFolder` for IMAP/iCloud |
| `email_label` | Add/remove labels (Gmail only) |
| `email_folder_create` | Create a new folder |
| `email_get_labels` | List all labels with counts (Gmail only) |
| `email_get_categories` | List all categories (Outlook only) |

### Batch Operations (4)

| Tool | Description |
|------|-------------|
| `email_batch_delete` | Delete multiple emails at once (up to 1000 for Gmail, batches of 20 for Outlook, UID ranges for IMAP) |
| `email_batch_move` | Move multiple emails to a folder in a single call |
| `email_batch_mark` | Mark multiple emails read/unread, starred, or flagged at once |
| `email_batch_label` | Add or remove labels on multiple emails at once (native batch call on Gmail, one by one elsewhere) |

All batch tools accept a `sourceFolder` parameter for IMAP/iCloud and include a sequential fallback for maximum compatibility.

### Spam Moderation (5)

| Tool | Description |
|------|-------------|
| `email_report_spam` | Report an email as spam/junk, training the provider's own filter — the same signal the "Report Junk" button sends in Gmail/Outlook. This is different from `email_delete`, which removes the message but teaches the filter nothing. **Not** an abuse report to the provider's security team; it only trains this account's filter |
| `email_batch_report_spam` | Report multiple emails as spam/junk at once |
| `email_create_block_rule` | Create a standing rule that intercepts future mail matching a pattern (sender domain/address, subject, or arbitrary header content) and either deletes it or moves it. Use `headerContains` (e.g. a Reply-To domain) to block a spam template family whose visible "From" domain rotates — matching the rotating domain directly stops working within days. **Not supported on iCloud/generic IMAP** (no standard server-side rule mechanism exists across IMAP servers). On Outlook, `moveToJunk` files straight to the Junk Email folder and requires the `MailboxSettings.ReadWrite` scope. On Gmail, `moveToJunk` skips the inbox (archives) rather than literally filing to Spam — Gmail's filter API rejects the SPAM label on standing rules (only Gmail's own classifier can apply it; `email_report_spam` still can, since that's a direct per-message action, not a filter) — and requires the `gmail.settings.basic` scope. Accounts authenticated before these scopes existed need to re-run the setup wizard once to re-consent |
| `email_list_block_rules` | List the standing block rules on an account, for auditing or before deleting one |
| `email_delete_block_rule` | Delete a standing block rule — use to undo a rule that turned out too broad |

Gmail and Outlook only for the rule tools; `email_report_spam`/`email_batch_report_spam` work on every provider (iCloud/IMAP fall back to a best-effort move into the account's Junk-typed folder, with no vendor ML training signal since generic IMAP has none to train).

### Forwarding Rules (3)

| Tool | Description |
|------|-------------|
| `email_create_forward_rule` | Create a standing rule that forwards future mail matching a pattern (sender domain/address, subject, or header content) to another address, for example vendor invoices to a bookkeeping address. The original stays in the inbox unless `keepInInbox` is `false`. Creating the same rule twice returns the existing one |
| `email_list_forward_rules` | List every rule on an account that forwards mail elsewhere, including rules made by hand in Gmail or Outlook: an audit of where mail is being sent |
| `email_delete_forward_rule` | Delete a forwarding rule by id |

Gmail and Outlook only. iCloud and generic IMAP have no server-side rule mechanism; set the rule in the provider's own settings there.

**Forwarding is off until you allow a target.** A standing forward rule copies future mail out of your mailbox, and an assistant that reads mail can be asked to create one by the mail it reads. So `email_create_forward_rule` only accepts addresses you listed yourself in `EMAIL_MCP_FORWARD_ALLOWLIST` (comma-separated), in the environment of the server. No tool can change that list:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["@marlinjai/email-mcp"],
      "env": { "EMAIL_MCP_FORWARD_ALLOWLIST": "expenses@example.com" }
    }
  }
}
```

On Gmail the target must also be a forwarding address of the account: add it once under Gmail Settings, "Forwarding and POP/IMAP", "Add a forwarding address", and confirm the email Google sends to it. Outlook needs no such step, which is why the allowlist exists. Outlook accounts authenticated before the block-rule tools existed need to re-run the setup wizard once, as for those tools.

## Usage with Claude Code

Add the following to your `.mcp.json` file (project-level or global `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["@marlinjai/email-mcp"]
    }
  }
}
```

Once configured, you can ask Claude to interact with your email:

- "Check my inbox for unread messages"
- "Search for emails from alice@example.com in the last week"
- "Reply to the latest email from Bob and thank him"
- "Move all newsletters to the Archive folder"
- "Delete all spam emails" (uses batch operations for speed)
- "Draft a follow-up email to the team about the meeting"

## Development

```bash
# Install dependencies
pnpm install

# Build the project
pnpm build

# Run in development mode (watch for changes)
pnpm dev

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run integration tests (requires real email accounts)
pnpm test:integration
```

## Credential Storage

Credentials and the Outlook MSAL cache are encrypted with AES-256-GCM using the required `EMAIL_MCP_KEY`. Machine identifiers are accepted only during an explicitly enabled one-time legacy migration. The data directory defaults to `~/.email-mcp`; set `EMAIL_MCP_DATA_DIR` to keep deployments separate.

Outlook cache transactions are locked across server and setup processes. After a crash, a lock timeout may require stopping every process sharing the cache and removing the empty `msal-cache.enc.lock` directory. Conflicting encrypted/plaintext caches stop migration and preserve both files. See [SECURITY.md](SECURITY.md) for recovery instructions.

See [SECURITY.md](SECURITY.md) for migration, tool and account allowlists, OAuth scopes, and the trust boundary. Existing grants are not automatically narrowed by this upgrade.

## Support

email-mcp is free and has no paid tier. Its one fixed cost is the independent security assessment Google requires every year for the shared Gmail sign-in (CASA, Cloud Application Security Assessment): 675 US dollars a year. It is the last open step before Google lets everyone use the one-command Gmail setup. Donations are collected until 2 November 2026, the day the assessment has to start, and the maintainer pays what is missing then. Progress is shown at [email.lumitra.co](https://email.lumitra.co/#fund-the-audit).

- [GitHub Sponsors](https://github.com/sponsors/marlinjai)
- [Buy Me a Coffee](https://buymeacoffee.com/marlinjai)

## License

MIT
