---
type: plan
status: completed
date: 2026-02-16
projects: [email-mcp]
---

# Email MCP Server — Design Document

A unified MCP server for email access across Gmail, Outlook, iCloud, and generic IMAP providers. Uses provider-native APIs where available (Gmail REST API, Microsoft Graph) for richer features, falling back to IMAP for iCloud and generic providers.

## Reality update (2026-09-10)

Shipped. `@marlinjai/email-mcp` is live on npm at v1.7.2 with the provider-adapter
architecture this document specifies (Gmail REST, Microsoft Graph, IMAP for iCloud
and generic providers), 301 passing tests, and `tsc --noEmit` now clean.

## Architecture

Provider adapter pattern — a common `EmailProvider` interface with provider-specific implementations:

```
┌─────────────────────────────────┐
│        MCP Server Layer         │
│   (tools, resources, prompts)   │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│     Account Manager             │
│  (multi-account, credentials)   │
└──────────────┬──────────────────┘
               │
┌──────────────▼──────────────────┐
│     EmailProvider Interface     │
│  listFolders, search, getEmail, │
│  send, move, delete, ...        │
└───┬──────┬──────┬──────┬────────┘
    │      │      │      │
┌───▼──┐┌──▼───┐┌─▼────┐┌▼──────┐
│Gmail ││Outlook││iCloud││Generic│
│ API  ││Graph  ││ IMAP ││ IMAP  │
└──────┘└──────┘└──────┘└───────┘
```

- **Gmail adapter**: `googleapis` npm package, Gmail REST API, OAuth2
- **Outlook adapter**: `@microsoft/microsoft-graph-client` + `@azure/msal-node`, Graph API, OAuth2
- **iCloud adapter**: `imapflow` + `nodemailer`, IMAP/SMTP, app-specific password
- **Generic IMAP adapter**: `imapflow` + `nodemailer`, IMAP/SMTP, password auth

Each adapter normalizes responses into common data models so the MCP tools are provider-agnostic.

## MCP Tools

### Account Management

| Tool | Description |
|------|-------------|
| `email_list_accounts` | List all configured accounts with connection status |
| `email_add_account` | Add a new account (launches OAuth flow or accepts credentials) |
| `email_remove_account` | Remove an account and its stored credentials |
| `email_test_account` | Test connection and return folder list |

### Reading & Searching

| Tool | Description |
|------|-------------|
| `email_list_folders` | List all folders/labels for an account |
| `email_search` | Search emails with filters (folder, from, to, subject, date range, body text, read/unread) |
| `email_get` | Get full email content by ID (headers, body, attachments metadata) |
| `email_get_thread` | Get full thread/conversation (Gmail: native threading, Outlook: conversationId, IMAP: References header) |
| `email_get_attachment` | Download a specific attachment by ID |

### Writing & Sending

| Tool | Description |
|------|-------------|
| `email_send` | Compose and send a new email (to, cc, bcc, subject, body, attachments) |
| `email_reply` | Reply to an email (preserves threading) |
| `email_forward` | Forward an email to new recipients |
| `email_draft_create` | Save a draft without sending |
| `email_draft_list` | List drafts |

### Organization

| Tool | Description |
|------|-------------|
| `email_move` | Move email to a different folder/label |
| `email_delete` | Delete an email (move to trash or permanent) |
| `email_mark` | Mark as read/unread/starred/flagged |
| `email_label` | Add/remove Gmail labels (Gmail-specific, no-op on other providers) |
| `email_folder_create` | Create a new folder |

### Provider-Specific Extras

| Tool | Description |
|------|-------------|
| `email_get_categories` | Get Outlook categories (Outlook only) |
| `email_get_labels` | List Gmail labels with counts (Gmail only) |

Provider-specific tools return a structured "not supported" response on wrong providers rather than erroring.

## Common Data Models

```typescript
interface Email {
  id: string;
  accountId: string;
  threadId?: string;
  folder: string;
  from: Contact;
  to: Contact[];
  cc?: Contact[];
  bcc?: Contact[];
  subject: string;
  date: string;                  // ISO 8601
  body: { text?: string; html?: string };
  snippet?: string;
  attachments: AttachmentMeta[];
  labels?: string[];             // Gmail
  categories?: string[];         // Outlook
  flags: {
    read: boolean;
    starred: boolean;
    flagged: boolean;
    draft: boolean;
  };
  headers?: Record<string, string>;
}

interface Contact {
  name?: string;
  email: string;
}

interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

interface Folder {
  id: string;
  name: string;
  path: string;
  type?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'other';
  unreadCount?: number;
  totalCount?: number;
  children?: Folder[];
}

interface Thread {
  id: string;
  subject: string;
  participants: Contact[];
  messageCount: number;
  messages: Email[];
  lastMessageDate: string;
}

interface SearchQuery {
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  hasAttachment?: boolean;
  limit?: number;                // default 20, max 100
  offset?: number;
}

interface Account {
  id: string;
  name: string;
  provider: 'gmail' | 'outlook' | 'icloud' | 'imap';
  email: string;
  connected: boolean;
}
```

## Authentication & Credential Storage

### OAuth2 Flows

**Gmail:**
- Desktop App registered in Google Cloud Console
- Scopes: `https://mail.google.com/`, `https://www.googleapis.com/auth/gmail.modify`
- Authorization Code flow with PKCE
- Library: `google-auth-library`

**Outlook:**
- App registered in Azure/Entra portal, `consumers` tenant
- Scopes: `Mail.ReadWrite`, `Mail.Send`, `offline_access`
- Authorization Code flow with PKCE
- Library: `@azure/msal-node`

**iCloud & Generic IMAP:**
- App-specific password (iCloud) or regular password
- No OAuth flow

### Setup Wizard

```
$ npx email-mcp setup

? Select provider:  Gmail / Outlook / iCloud / Other IMAP

[Gmail/Outlook]
→ Opening browser for authorization...
→ Waiting for callback on http://localhost:{port}/callback
→ Authorization successful! Connected as user@gmail.com
→ Testing connection... ✓ 47 folders found

[iCloud]
→ Generate an app-specific password at https://appleid.apple.com
? Enter your iCloud email: user@icloud.com
? Enter app-specific password: ****-****-****-****
→ Testing connection... ✓ 12 folders found

? Give this account a name [Gmail]: My Gmail
→ Account saved and encrypted.
```

### Credential Storage

Stored in `~/.email-mcp/credentials.enc`:
- Encrypted at rest with AES-256-GCM
- Master key derived from machine-specific seed (hostname + user) via PBKDF2
- Access tokens auto-refreshed transparently when expired
- OAuth client IDs/secrets bundled in the package

## Project Structure

```
email-mcp/
├── src/
│   ├── index.ts                    # entry point, tool registration
│   ├── server.ts                   # MCP server setup (stdio transport)
│   ├── tools/
│   │   ├── accounts.ts             # account management tools
│   │   ├── reading.ts              # search, get, get-thread, get-attachment
│   │   ├── sending.ts              # send, reply, forward, drafts
│   │   └── organizing.ts           # move, delete, mark, label, folder-create
│   ├── providers/
│   │   ├── provider.ts             # EmailProvider interface
│   │   ├── gmail/
│   │   │   ├── adapter.ts          # Gmail API adapter
│   │   │   ├── auth.ts             # Gmail OAuth2 flow
│   │   │   └── mapper.ts           # Gmail API → common models
│   │   ├── outlook/
│   │   │   ├── adapter.ts          # Graph API adapter
│   │   │   ├── auth.ts             # Microsoft OAuth2 flow
│   │   │   └── mapper.ts           # Graph API → common models
│   │   ├── icloud/
│   │   │   ├── adapter.ts          # IMAP adapter for iCloud
│   │   │   └── mapper.ts           # IMAP → common models
│   │   └── imap/
│   │       ├── adapter.ts          # Generic IMAP adapter
│   │       ├── smtp.ts             # SMTP sending
│   │       └── mapper.ts           # IMAP → common models
│   ├── auth/
│   │   ├── oauth-server.ts         # Local HTTP server for OAuth callbacks
│   │   └── credential-store.ts     # Encrypted credential storage
│   ├── models/
│   │   └── types.ts                # all shared types
│   └── setup/
│       └── wizard.ts               # Interactive CLI setup wizard
├── tests/
│   ├── providers/
│   │   ├── gmail.test.ts
│   │   ├── outlook.test.ts
│   │   └── imap.test.ts
│   ├── tools/
│   │   ├── reading.test.ts
│   │   ├── sending.test.ts
│   │   └── organizing.test.ts
│   └── auth/
│       └── credential-store.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── build.mjs
├── README.md
└── LICENSE
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server SDK |
| `googleapis` | Gmail REST API client |
| `google-auth-library` | Gmail OAuth2 |
| `@microsoft/microsoft-graph-client` | Outlook Graph API client |
| `@azure/msal-node` | Microsoft OAuth2 |
| `imapflow` | IMAP client for iCloud + generic |
| `nodemailer` | SMTP sending for iCloud + generic |
| `mailparser` | Parse raw IMAP emails |
| `inquirer` | Interactive CLI prompts |
| `esbuild` | TypeScript bundling |
| `vitest` | Testing |

## Error Handling

### Provider Unavailability
- Clear error message with provider name and reason
- One failed provider never affects others

### Token Refresh
- Auto-refresh access tokens within 5 minutes of expiry
- If refresh token is revoked, prompt user to re-run setup
- No silent failures

### Rate Limiting

| Provider | Limits | Strategy |
|----------|--------|----------|
| Gmail API | 250 quota units/second | Exponential backoff, max 3 retries |
| Graph API | 10,000 requests/10 min | Respect `Retry-After` header |
| IMAP | Connection-based | Keep-alive, reconnect on drop |

### Large Results
- Search defaults to 20 results, max 100, with offset pagination
- HTML bodies truncated at 50KB with `truncated: true` flag
- Attachments are metadata-only by default, fetched on demand

### Connection Lifecycle
- IMAP: pooled persistent connections, reconnect on drop
- Gmail/Outlook: stateless HTTP, no pooling needed
- Graceful disconnect on server shutdown

## Testing Strategy

### Unit Tests
- Mock API/IMAP responses per adapter, verify mapping to common types
- Credential store encrypt/decrypt round-trip
- Tool handler input validation and routing

### Integration Tests
- Gated behind `EMAIL_MCP_TEST_ACCOUNTS` env var
- Connect, list folders, search, read, send-to-self, delete
- Skipped in CI, run manually

### Not Tested Automatically
- OAuth browser flows (manual QA)
- Setup wizard UX (manual QA)

```bash
npm test                  # unit tests
npm run test:integration  # requires real accounts
```
