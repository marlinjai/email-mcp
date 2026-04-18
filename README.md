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
npx @marlinjai/email-mcp setup
```

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
npx @marlinjai/email-mcp setup
# Select "Gmail" when prompted
# A browser window opens for Google authorization
# Grant the requested permissions and return to the terminal
```

> **Note:** If you prefer to use your own OAuth app, create a Desktop OAuth 2.0 Client in the [Google Cloud Console](https://console.cloud.google.com/) with the Gmail API enabled.

### Outlook

No configuration needed — the setup wizard handles everything using built-in OAuth credentials (PKCE):

```bash
npx @marlinjai/email-mcp setup
# Select "Outlook" when prompted
# A browser window opens for Microsoft authorization
# Sign in and grant the requested permissions
```

> **Note:** If you prefer to use your own OAuth app, register one in the [Azure Portal](https://portal.azure.com/) with `Mail.ReadWrite`, `Mail.Send`, and `offline_access` permissions.

### iCloud

1. Go to [appleid.apple.com](https://appleid.apple.com/) and sign in.
2. Navigate to **App-Specific Passwords** and generate a new password.
3. Run the setup wizard:

```bash
npx @marlinjai/email-mcp setup
# Select "iCloud" when prompted
# Enter your iCloud email address
# Enter the app-specific password you generated
```

### Generic IMAP

Run the setup wizard with your IMAP/SMTP server details:

```bash
npx @marlinjai/email-mcp setup
# Select "Other IMAP" when prompted
# Enter your IMAP host, port, and credentials
# Optionally enter SMTP host and port for sending
```

## Available Tools (24)

### Account Management (4)

| Tool | Description |
|------|-------------|
| `email_list_accounts` | List all configured accounts with connection status |
| `email_add_account` | Add a new IMAP or iCloud account (Gmail/Outlook require setup wizard) |
| `email_remove_account` | Remove an account and its stored credentials |
| `email_test_account` | Test connection to an account |

### Reading & Searching (6)

| Tool | Description |
|------|-------------|
| `email_list_folders` | List all folders/labels for an account |
| `email_search` | Search emails with filters. Returns compact results by default (`returnBody=false`). Set `returnBody=true` to include full email bodies |
| `email_get` | Get full email content by ID (headers, body, attachment metadata) |
| `email_get_thread` | Get an entire email thread/conversation |
| `email_get_attachment` | Download a specific attachment by ID (returns base64 data) |
| `email_save_attachment` | Download an attachment and save directly to a file path. Returns metadata only — avoids base64 in response (fast for large files) |

### Sending & Drafts (5)

| Tool | Description |
|------|-------------|
| `email_send` | Compose and send a new email (to, cc, bcc, subject, body) |
| `email_reply` | Reply to an email (supports reply-all, preserves threading) |
| `email_forward` | Forward an email to new recipients |
| `email_draft_create` | Save a draft without sending |
| `email_draft_list` | List all drafts |

### Organization (7)

| Tool | Description |
|------|-------------|
| `email_move` | Move an email to a different folder. Supports `sourceFolder` for IMAP/iCloud |
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

## Support

If this project is useful to you, consider supporting its development:

- [GitHub Sponsors](https://github.com/sponsors/marlinjai)
- [Buy Me a Coffee](https://buymeacoffee.com/marlinjai)

## License

MIT
