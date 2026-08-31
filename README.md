# @marlinjai/email-mcp

A unified MCP server for email access across Gmail, Outlook, iCloud, and generic IMAP providers.

## Features

- **Multi-provider support** -- Gmail (REST API), Outlook (Microsoft Graph), iCloud (IMAP), and generic IMAP/SMTP
- **OAuth2 authentication** -- Browser-based OAuth flows for Gmail and Outlook, with automatic token refresh
- **Full email client** -- Search, read, send, reply, forward, organize, and manage drafts
- **Batch operations** -- Delete, move, or mark hundreds of emails in a single call
- **Lightweight search** -- Compact search results by default (~20KB vs ~1.4MB) with optional full body retrieval
- **Encrypted credential storage** -- AES-256-GCM encryption at rest with machine-derived keys
- **Provider-native APIs** -- Uses Gmail API and Microsoft Graph where available for richer features, falls back to IMAP for universal compatibility

## Installation

Install globally from npm:

```bash
npm install -g @marlinjai/email-mcp
```

Or run directly with npx (no install needed):

```bash
npx @marlinjai/email-mcp
```

## Quick Start

1. Run the interactive setup wizard to add your email accounts:

```bash
npx -y -p @marlinjai/email-mcp@latest email-mcp-setup
```

> **The `-p`/`--package` flag is required.** This package declares two binaries (`email-mcp` for the MCP server, `email-mcp-setup` for this wizard). Without `-p`, npx runs the bin matching the *package's own name* (`email-mcp`, the server) and silently passes `email-mcp-setup` to it as an ignored argument — the server then sits waiting for MCP protocol input on stdin forever, producing no output at all. It looks exactly like a hang. `-p` tells npx explicitly which package to resolve and which of its binaries to actually run.

The wizard will walk you through provider selection and authentication. After each account, it asks if you'd like to add another — so you can set up Gmail, Outlook, and iCloud all in one go.

2. Add the server to your MCP configuration (`.mcp.json`):

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

3. Start using email tools in Claude Code — search your inbox, send emails, organize messages, and more.

## Provider Setup Guides

### Gmail

No configuration needed — the setup wizard handles everything using built-in OAuth credentials (PKCE):

```bash
npx -y -p @marlinjai/email-mcp@latest email-mcp-setup
# Select "Gmail" when prompted
# A browser window opens for Google authorization
# Grant the requested permissions and return to the terminal
```

> **Note:** If you prefer to use your own OAuth app, create a Desktop OAuth 2.0 Client in the [Google Cloud Console](https://console.cloud.google.com/) with the Gmail API enabled.

### Outlook

No configuration needed — the setup wizard handles everything using built-in OAuth credentials (PKCE):

```bash
npx -y -p @marlinjai/email-mcp@latest email-mcp-setup
# Select "Outlook" when prompted
# A browser window opens for Microsoft authorization
# Sign in and grant the requested permissions
```

> **Note:** If you prefer to use your own OAuth app, register one in the [Azure Portal](https://portal.azure.com/) with `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite` (needed for `email_create_block_rule`), and `offline_access` permissions.

### iCloud

1. Go to [appleid.apple.com](https://appleid.apple.com/) and sign in.
2. Navigate to **App-Specific Passwords** and generate a new password.
3. Run the setup wizard:

```bash
npx -y -p @marlinjai/email-mcp@latest email-mcp-setup
# Select "iCloud" when prompted
# Enter your iCloud email address
# Enter the app-specific password you generated
```

### Generic IMAP

Run the setup wizard with your IMAP/SMTP server details:

```bash
npx -y -p @marlinjai/email-mcp@latest email-mcp-setup
# Select "Other IMAP" when prompted
# Enter your IMAP host, port, and credentials
# Optionally enter SMTP host and port for sending
```

## Available Tools (30)

### Account Management (4)

| Tool | Description |
|------|-------------|
| `email_list_accounts` | List all configured accounts with connection status |
| `email_add_account` | Add a new IMAP or iCloud account (Gmail/Outlook require setup wizard) |
| `email_remove_account` | Remove an account and its stored credentials |
| `email_test_account` | Test connection to an account |

### Reading & Searching (5)

| Tool | Description |
|------|-------------|
| `email_list_folders` | List all folders/labels for an account |
| `email_search` | Search emails with filters. Returns compact results by default (`returnBody=false`). Set `returnBody=true` to include full email bodies |
| `email_get` | Get full email content by ID (headers, body, attachment metadata) |
| `email_get_thread` | Get an entire email thread/conversation |
| `email_get_attachment` | Download a specific attachment by ID (returns base64 data) |

### Sending & Drafts (5)

| Tool | Description |
|------|-------------|
| `email_send` | Compose and send a new email (to, cc, bcc, subject, body) |
| `email_reply` | Reply to an email (supports reply-all, preserves threading) |
| `email_forward` | Forward an email to new recipients |
| `email_draft_create` | Save a draft without sending |
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

### Batch Operations (3)

| Tool | Description |
|------|-------------|
| `email_batch_delete` | Delete multiple emails at once (up to 1000 for Gmail, batches of 20 for Outlook, UID ranges for IMAP) |
| `email_batch_move` | Move multiple emails to a folder in a single call |
| `email_batch_mark` | Mark multiple emails read/unread, starred, or flagged at once |

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

Account credentials are encrypted at rest with AES-256-GCM in `~/.email-mcp/credentials.enc`.

By default the encryption key is derived from a stable, machine-specific identifier
(the hardware UUID on macOS, `/etc/machine-id` on Linux, or the `MachineGuid` on
Windows), falling back to the hostname when none is available.

Set the `EMAIL_MCP_KEY` environment variable to supply your own passphrase instead.
This is recommended when the machine identifier may change (for example in
containers or CI), or when you want to move `credentials.enc` between machines:

```bash
export EMAIL_MCP_KEY="your-strong-passphrase"
```

When `EMAIL_MCP_KEY` is set, existing credential files are transparently
re-encrypted with the passphrase the next time they are read.

## Support

If this project is useful to you, consider supporting its development:

- [GitHub Sponsors](https://github.com/sponsors/marlinjai)
- [Buy Me a Coffee](https://buymeacoffee.com/marlinjai)

## License

MIT
