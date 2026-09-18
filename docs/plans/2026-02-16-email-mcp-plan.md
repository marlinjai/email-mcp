---
type: plan
status: completed
date: 2026-02-16
projects: [email-mcp]
---

# Email MCP Server — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Reality update (2026-09-10)

Shipped. `@marlinjai/email-mcp` is live on npm at v1.8.0 (published 2026-09-18), all four providers
(Gmail, Outlook, iCloud, generic IMAP) built, 334 passing tests, `tsc --noEmit`
clean as of this session (11 pre-existing type errors fixed, see
`backlog/intents/email-mcp-pre-existing-test-and-tsc-failures.md` in
knowledge-base). Well past the founding task list; subsequent work is tracked on
the repo's own `ROADMAP.md`, not this plan.

**Goal:** Build a unified MCP server for email access across Gmail (REST API), Outlook (Graph API), iCloud (IMAP), and generic IMAP providers.

**Architecture:** Provider adapter pattern with a common `EmailProvider` interface. Each provider (Gmail, Outlook, iCloud, generic IMAP) implements this interface using its native API. An account manager coordinates multi-account access. MCP tools call through the account manager, never directly to providers.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `googleapis`, `@azure/msal-node`, `@microsoft/microsoft-graph-client`, `imapflow`, `nodemailer`, `mailparser`, `inquirer`, `esbuild`, `vitest`

**Design doc:** `docs/plans/2026-02-16-email-mcp-design.md`

---

## Phase 1: Project Scaffold & Core Types

### Task 1: Wipe old code and initialize project

**Files:**
- Delete: everything except `.git/`, `docs/`, `.claude/`
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `build.mjs`, `.gitignore`, `README.md`, `LICENSE`

**Step 1: Remove old project files**

```bash
cd /path/to/project
rm -rf config mcp-server .mcp.json README.md
```

**Step 2: Create package.json**

```json
{
  "name": "email-mcp",
  "version": "0.1.0",
  "description": "Unified MCP server for email access across Gmail, Outlook, iCloud, and IMAP",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "email-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "node build.mjs",
    "dev": "node build.mjs --watch",
    "start": "node dist/index.js",
    "setup": "node dist/setup.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "EMAIL_MCP_INTEGRATION=1 vitest run tests/integration"
  },
  "keywords": ["mcp", "email", "gmail", "outlook", "imap", "icloud"],
  "license": "MIT"
}
```

**Step 3: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk googleapis google-auth-library @microsoft/microsoft-graph-client @azure/msal-node imapflow nodemailer mailparser inquirer
npm install -D typescript @types/node @types/nodemailer @types/mailparser @types/inquirer vitest esbuild
```

**Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
```

**Step 6: Create build.mjs**

```javascript
import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/index.ts', 'src/setup/wizard.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  sourcemap: true,
  external: ['inquirer'],
  banner: {
    js: '#!/usr/bin/env node',
  },
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await build(options);
  console.log('Build complete.');
}
```

**Step 7: Create .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
.env
credentials.enc
```

**Step 8: Create placeholder README.md**

```markdown
# email-mcp

Unified MCP server for email access across Gmail, Outlook, iCloud, and IMAP providers.

## Status

Under development.
```

**Step 9: Create src directory structure**

```bash
mkdir -p src/{tools,providers/{gmail,outlook,icloud,imap},auth,models,setup}
mkdir -p tests/{providers,tools,auth}
```

**Step 10: Commit**

```bash
git add -A
git commit -m "feat: initialize email-mcp project scaffold"
```

---

### Task 2: Define common data models and types

**Files:**
- Create: `src/models/types.ts`
- Test: `tests/models/types.test.ts`

**Step 1: Write type validation tests**

Create `tests/models/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  type Email,
  type Contact,
  type Folder,
  type Thread,
  type SearchQuery,
  type Account,
  type AttachmentMeta,
  type AccountCredentials,
  ProviderType,
  FolderType,
  isProviderSupported,
} from '../src/models/types.js';

describe('ProviderType', () => {
  it('has all expected providers', () => {
    expect(ProviderType.Gmail).toBe('gmail');
    expect(ProviderType.Outlook).toBe('outlook');
    expect(ProviderType.ICloud).toBe('icloud');
    expect(ProviderType.IMAP).toBe('imap');
  });
});

describe('FolderType', () => {
  it('has all expected folder types', () => {
    expect(FolderType.Inbox).toBe('inbox');
    expect(FolderType.Sent).toBe('sent');
    expect(FolderType.Drafts).toBe('drafts');
    expect(FolderType.Trash).toBe('trash');
    expect(FolderType.Spam).toBe('spam');
    expect(FolderType.Archive).toBe('archive');
    expect(FolderType.Other).toBe('other');
  });
});

describe('isProviderSupported', () => {
  it('returns true for supported providers', () => {
    expect(isProviderSupported('gmail')).toBe(true);
    expect(isProviderSupported('outlook')).toBe(true);
    expect(isProviderSupported('icloud')).toBe(true);
    expect(isProviderSupported('imap')).toBe(true);
  });

  it('returns false for unsupported providers', () => {
    expect(isProviderSupported('yahoo')).toBe(false);
    expect(isProviderSupported('')).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/models/types.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement types**

Create `src/models/types.ts`:

```typescript
export const ProviderType = {
  Gmail: 'gmail',
  Outlook: 'outlook',
  ICloud: 'icloud',
  IMAP: 'imap',
} as const;

export type ProviderTypeValue = (typeof ProviderType)[keyof typeof ProviderType];

export const FolderType = {
  Inbox: 'inbox',
  Sent: 'sent',
  Drafts: 'drafts',
  Trash: 'trash',
  Spam: 'spam',
  Archive: 'archive',
  Other: 'other',
} as const;

export type FolderTypeValue = (typeof FolderType)[keyof typeof FolderType];

export function isProviderSupported(provider: string): provider is ProviderTypeValue {
  return Object.values(ProviderType).includes(provider as ProviderTypeValue);
}

export interface Contact {
  name?: string;
  email: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface Email {
  id: string;
  accountId: string;
  threadId?: string;
  folder: string;
  from: Contact;
  to: Contact[];
  cc?: Contact[];
  bcc?: Contact[];
  subject: string;
  date: string;
  body: { text?: string; html?: string };
  snippet?: string;
  attachments: AttachmentMeta[];
  labels?: string[];
  categories?: string[];
  flags: {
    read: boolean;
    starred: boolean;
    flagged: boolean;
    draft: boolean;
  };
  headers?: Record<string, string>;
  truncated?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  path: string;
  type?: FolderTypeValue;
  unreadCount?: number;
  totalCount?: number;
  children?: Folder[];
}

export interface Thread {
  id: string;
  subject: string;
  participants: Contact[];
  messageCount: number;
  messages: Email[];
  lastMessageDate: string;
}

export interface SearchQuery {
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
  limit?: number;
  offset?: number;
}

export interface Account {
  id: string;
  name: string;
  provider: ProviderTypeValue;
  email: string;
  connected: boolean;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expiry: string;
}

export interface PasswordCredentials {
  password: string;
  host: string;
  port: number;
  tls: boolean;
  smtpHost?: string;
  smtpPort?: number;
}

export interface AccountCredentials {
  id: string;
  name: string;
  provider: ProviderTypeValue;
  email: string;
  oauth?: OAuthTokens;
  password?: PasswordCredentials;
}

export interface ProviderError {
  success: false;
  error: string;
  provider?: string;
  supportedProviders?: string[];
}

export interface ProviderSuccess<T> {
  success: true;
  data: T;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderError;
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/models/types.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/models/types.ts tests/models/types.test.ts
git commit -m "feat: add common data models and types"
```

---

### Task 3: Build the encrypted credential store

**Files:**
- Create: `src/auth/credential-store.ts`
- Test: `tests/auth/credential-store.test.ts`

**Step 1: Write credential store tests**

Create `tests/auth/credential-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialStore } from '../src/auth/credential-store.js';
import { ProviderType } from '../src/models/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('CredentialStore', () => {
  let store: CredentialStore;
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-test-'));
    store = new CredentialStore(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('saves and loads an account', async () => {
    const creds = {
      id: 'test-1',
      name: 'Test Gmail',
      provider: ProviderType.Gmail as const,
      email: 'test@gmail.com',
      oauth: {
        access_token: 'at-123',
        refresh_token: 'rt-456',
        expiry: '2026-12-31T00:00:00Z',
      },
    };

    await store.save(creds);
    const loaded = await store.get('test-1');
    expect(loaded).toEqual(creds);
  });

  it('lists all accounts', async () => {
    await store.save({
      id: 'a1',
      name: 'Gmail',
      provider: ProviderType.Gmail as const,
      email: 'a@gmail.com',
      oauth: { access_token: 'x', refresh_token: 'y', expiry: '' },
    });
    await store.save({
      id: 'a2',
      name: 'iCloud',
      provider: ProviderType.ICloud as const,
      email: 'b@icloud.com',
      password: { password: 'p', host: 'imap.mail.me.com', port: 993, tls: true },
    });

    const accounts = await store.list();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('removes an account', async () => {
    await store.save({
      id: 'del-1',
      name: 'ToDelete',
      provider: ProviderType.IMAP as const,
      email: 'x@test.com',
      password: { password: 'p', host: 'imap.test.com', port: 993, tls: true },
    });

    await store.remove('del-1');
    const loaded = await store.get('del-1');
    expect(loaded).toBeNull();
  });

  it('returns null for nonexistent account', async () => {
    const loaded = await store.get('nope');
    expect(loaded).toBeNull();
  });

  it('persists across instances', async () => {
    await store.save({
      id: 'persist-1',
      name: 'Persist',
      provider: ProviderType.Gmail as const,
      email: 'p@gmail.com',
      oauth: { access_token: 'a', refresh_token: 'r', expiry: '' },
    });

    const store2 = new CredentialStore(testDir);
    const loaded = await store2.get('persist-1');
    expect(loaded?.email).toBe('p@gmail.com');
  });

  it('encrypts the file on disk', async () => {
    await store.save({
      id: 'enc-1',
      name: 'Encrypted',
      provider: ProviderType.Gmail as const,
      email: 'enc@gmail.com',
      oauth: { access_token: 'secret-token', refresh_token: 'secret-refresh', expiry: '' },
    });

    const filePath = path.join(testDir, 'credentials.enc');
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('secret-refresh');
  });

  it('updates an existing account', async () => {
    const creds = {
      id: 'upd-1',
      name: 'Original',
      provider: ProviderType.Gmail as const,
      email: 'u@gmail.com',
      oauth: { access_token: 'old', refresh_token: 'r', expiry: '' },
    };
    await store.save(creds);
    await store.save({ ...creds, name: 'Updated', oauth: { access_token: 'new', refresh_token: 'r', expiry: '' } });

    const loaded = await store.get('upd-1');
    expect(loaded?.name).toBe('Updated');
    expect(loaded?.oauth?.access_token).toBe('new');

    const all = await store.list();
    expect(all).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/auth/credential-store.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement credential store**

Create `src/auth/credential-store.ts`:

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AccountCredentials } from '../models/types.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

function getMachineSeed(): string {
  return `email-mcp:${os.hostname()}:${os.userInfo().username}`;
}

function deriveKey(salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(getMachineSeed(), salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

function encrypt(plaintext: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted,
  });
}

function decrypt(ciphertext: string): string {
  const { salt, iv, authTag, data } = JSON.parse(ciphertext);
  const key = deriveKey(Buffer.from(salt, 'hex'));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(data, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

interface StoredData {
  accounts: Record<string, AccountCredentials>;
}

export class CredentialStore {
  private filePath: string;

  constructor(dir?: string) {
    const baseDir = dir ?? path.join(os.homedir(), '.email-mcp');
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    }
    this.filePath = path.join(baseDir, 'credentials.enc');
  }

  private read(): StoredData {
    if (!fs.existsSync(this.filePath)) {
      return { accounts: {} };
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const json = decrypt(raw);
    return JSON.parse(json);
  }

  private write(data: StoredData): void {
    const json = JSON.stringify(data);
    const encrypted = encrypt(json);
    fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
  }

  async save(creds: AccountCredentials): Promise<void> {
    const data = this.read();
    data.accounts[creds.id] = creds;
    this.write(data);
  }

  async get(id: string): Promise<AccountCredentials | null> {
    const data = this.read();
    return data.accounts[id] ?? null;
  }

  async list(): Promise<AccountCredentials[]> {
    const data = this.read();
    return Object.values(data.accounts);
  }

  async remove(id: string): Promise<void> {
    const data = this.read();
    delete data.accounts[id];
    this.write(data);
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/auth/credential-store.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/auth/credential-store.ts tests/auth/credential-store.test.ts
git commit -m "feat: add encrypted credential store"
```

---

### Task 4: Define the EmailProvider interface

**Files:**
- Create: `src/providers/provider.ts`

**Step 1: Write the interface**

Create `src/providers/provider.ts`:

```typescript
import type {
  Email,
  Folder,
  Thread,
  SearchQuery,
  Contact,
  AttachmentMeta,
  AccountCredentials,
  ProviderTypeValue,
} from '../models/types.js';

export interface SendEmailParams {
  to: Contact[];
  cc?: Contact[];
  bcc?: Contact[];
  subject: string;
  body: { text?: string; html?: string };
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  inReplyTo?: string;
  references?: string[];
}

export interface EmailProvider {
  readonly providerType: ProviderTypeValue;

  connect(credentials: AccountCredentials): Promise<void>;
  disconnect(): Promise<void>;
  testConnection(): Promise<{ success: boolean; folderCount: number; error?: string }>;

  listFolders(): Promise<Folder[]>;
  createFolder(name: string, parentPath?: string): Promise<Folder>;

  search(query: SearchQuery): Promise<Email[]>;
  getEmail(id: string): Promise<Email>;
  getThread(threadId: string): Promise<Thread>;
  getAttachment(emailId: string, attachmentId: string): Promise<{ data: Buffer; meta: AttachmentMeta }>;

  sendEmail(params: SendEmailParams): Promise<{ id: string; threadId?: string }>;
  createDraft(params: SendEmailParams): Promise<{ id: string }>;
  listDrafts(limit?: number, offset?: number): Promise<Email[]>;

  moveEmail(emailId: string, targetFolder: string): Promise<void>;
  deleteEmail(emailId: string, permanent?: boolean): Promise<void>;
  markEmail(emailId: string, flags: { read?: boolean; starred?: boolean; flagged?: boolean }): Promise<void>;

  // Provider-specific (optional)
  addLabels?(emailId: string, labels: string[]): Promise<void>;
  removeLabels?(emailId: string, labels: string[]): Promise<void>;
  listLabels?(): Promise<Array<{ id: string; name: string; messageCount: number }>>;
  getCategories?(): Promise<string[]>;
}
```

**Step 2: Commit**

```bash
git add src/providers/provider.ts
git commit -m "feat: define EmailProvider interface"
```

---

## Phase 2: IMAP Provider (iCloud & Generic)

### Task 5: Build the generic IMAP adapter — connection and folder listing

**Files:**
- Create: `src/providers/imap/adapter.ts`
- Create: `src/providers/imap/mapper.ts`
- Test: `tests/providers/imap.test.ts`

**Step 1: Write tests for IMAP connection and folder listing**

Create `tests/providers/imap.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapAdapter } from '../src/providers/imap/adapter.js';
import { ProviderType } from '../src/models/types.js';

// Mock imapflow
vi.mock('imapflow', () => {
  return {
    ImapFlow: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([
        { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', status: { messages: 10, unseen: 3 } },
        { path: 'Sent', name: 'Sent', specialUse: '\\Sent', status: { messages: 50, unseen: 0 } },
        { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', status: { messages: 2, unseen: 0 } },
        { path: 'Trash', name: 'Trash', specialUse: '\\Trash', status: { messages: 5, unseen: 0 } },
        { path: 'Junk', name: 'Junk', specialUse: '\\Junk', status: { messages: 8, unseen: 8 } },
      ]),
      usable: true,
    })),
  };
});

describe('ImapAdapter', () => {
  let adapter: ImapAdapter;

  beforeEach(() => {
    adapter = new ImapAdapter();
  });

  it('has correct provider type', () => {
    expect(adapter.providerType).toBe(ProviderType.IMAP);
  });

  it('connects with password credentials', async () => {
    await adapter.connect({
      id: 'test-1',
      name: 'Test',
      provider: 'imap',
      email: 'test@example.com',
      password: {
        password: 'pass123',
        host: 'imap.example.com',
        port: 993,
        tls: true,
      },
    });

    const result = await adapter.testConnection();
    expect(result.success).toBe(true);
    expect(result.folderCount).toBe(5);
  });

  it('lists folders with correct types', async () => {
    await adapter.connect({
      id: 'test-1',
      name: 'Test',
      provider: 'imap',
      email: 'test@example.com',
      password: {
        password: 'pass123',
        host: 'imap.example.com',
        port: 993,
        tls: true,
      },
    });

    const folders = await adapter.listFolders();
    expect(folders).toHaveLength(5);

    const inbox = folders.find((f) => f.path === 'INBOX');
    expect(inbox?.type).toBe('inbox');
    expect(inbox?.totalCount).toBe(10);
    expect(inbox?.unreadCount).toBe(3);

    const spam = folders.find((f) => f.path === 'Junk');
    expect(spam?.type).toBe('spam');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/providers/imap.test.ts
```

Expected: FAIL — module not found.

**Step 3: Implement IMAP mapper**

Create `src/providers/imap/mapper.ts`:

```typescript
import type { Folder, Email, Contact, AttachmentMeta, FolderTypeValue } from '../../models/types.js';
import { FolderType } from '../../models/types.js';

const SPECIAL_USE_MAP: Record<string, FolderTypeValue> = {
  '\\Inbox': FolderType.Inbox,
  '\\Sent': FolderType.Sent,
  '\\Drafts': FolderType.Drafts,
  '\\Trash': FolderType.Trash,
  '\\Junk': FolderType.Spam,
  '\\Archive': FolderType.Archive,
};

export function mapImapFolder(imapFolder: any): Folder {
  return {
    id: imapFolder.path,
    name: imapFolder.name,
    path: imapFolder.path,
    type: (imapFolder.specialUse && SPECIAL_USE_MAP[imapFolder.specialUse]) || FolderType.Other,
    totalCount: imapFolder.status?.messages,
    unreadCount: imapFolder.status?.unseen,
  };
}

export function mapParsedEmail(parsed: any, folder: string, accountId: string): Email {
  const mapContact = (addr: any): Contact => ({
    name: addr.name || undefined,
    email: addr.address,
  });

  const mapContacts = (addrs: any): Contact[] => {
    if (!addrs?.value) return [];
    return addrs.value.map(mapContact);
  };

  const attachments: AttachmentMeta[] = (parsed.attachments || []).map((att: any, i: number) => ({
    id: att.contentId || `att-${i}`,
    filename: att.filename || `attachment-${i}`,
    contentType: att.contentType || 'application/octet-stream',
    size: att.size || 0,
  }));

  const from = parsed.from?.value?.[0];

  return {
    id: String(parsed.uid || parsed.messageId || ''),
    accountId,
    threadId: parsed.references?.[0] || parsed.messageId,
    folder,
    from: from ? mapContact(from) : { email: 'unknown' },
    to: mapContacts(parsed.to),
    cc: parsed.cc ? mapContacts(parsed.cc) : undefined,
    bcc: parsed.bcc ? mapContacts(parsed.bcc) : undefined,
    subject: parsed.subject || '(no subject)',
    date: parsed.date?.toISOString() || new Date().toISOString(),
    body: {
      text: parsed.text,
      html: parsed.html || undefined,
    },
    snippet: parsed.text?.substring(0, 200),
    attachments,
    flags: {
      read: parsed.flags?.has('\\Seen') || false,
      starred: parsed.flags?.has('\\Flagged') || false,
      flagged: parsed.flags?.has('\\Flagged') || false,
      draft: parsed.flags?.has('\\Draft') || false,
    },
  };
}
```

**Step 4: Implement IMAP adapter (connection + folders)**

Create `src/providers/imap/adapter.ts`:

```typescript
import { ImapFlow } from 'imapflow';
import type { EmailProvider, SendEmailParams } from '../provider.js';
import type {
  Email,
  Folder,
  Thread,
  SearchQuery,
  AttachmentMeta,
  AccountCredentials,
  ProviderTypeValue,
} from '../../models/types.js';
import { ProviderType } from '../../models/types.js';
import { mapImapFolder, mapParsedEmail } from './mapper.js';

export class ImapAdapter implements EmailProvider {
  readonly providerType: ProviderTypeValue = ProviderType.IMAP;
  protected client: InstanceType<typeof ImapFlow> | null = null;
  protected accountId: string = '';
  protected email: string = '';

  async connect(credentials: AccountCredentials): Promise<void> {
    if (!credentials.password) {
      throw new Error('IMAP adapter requires password credentials');
    }
    this.accountId = credentials.id;
    this.email = credentials.email;

    this.client = new ImapFlow({
      host: credentials.password.host,
      port: credentials.password.port,
      secure: credentials.password.tls,
      auth: {
        user: credentials.email,
        pass: credentials.password.password,
      },
      logger: false,
    });

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.logout();
      this.client = null;
    }
  }

  async testConnection(): Promise<{ success: boolean; folderCount: number; error?: string }> {
    try {
      const folders = await this.listFolders();
      return { success: true, folderCount: folders.length };
    } catch (error: any) {
      return { success: false, folderCount: 0, error: error.message };
    }
  }

  async listFolders(): Promise<Folder[]> {
    if (!this.client) throw new Error('Not connected');
    const imapFolders = await this.client.list();
    return imapFolders.map(mapImapFolder);
  }

  // Remaining methods — stubbed for now, implemented in later tasks
  async createFolder(_name: string, _parentPath?: string): Promise<Folder> {
    throw new Error('Not implemented yet');
  }
  async search(_query: SearchQuery): Promise<Email[]> {
    throw new Error('Not implemented yet');
  }
  async getEmail(_id: string): Promise<Email> {
    throw new Error('Not implemented yet');
  }
  async getThread(_threadId: string): Promise<Thread> {
    throw new Error('Not implemented yet');
  }
  async getAttachment(_emailId: string, _attachmentId: string): Promise<{ data: Buffer; meta: AttachmentMeta }> {
    throw new Error('Not implemented yet');
  }
  async sendEmail(_params: SendEmailParams): Promise<{ id: string; threadId?: string }> {
    throw new Error('Not implemented yet');
  }
  async createDraft(_params: SendEmailParams): Promise<{ id: string }> {
    throw new Error('Not implemented yet');
  }
  async listDrafts(_limit?: number, _offset?: number): Promise<Email[]> {
    throw new Error('Not implemented yet');
  }
  async moveEmail(_emailId: string, _targetFolder: string): Promise<void> {
    throw new Error('Not implemented yet');
  }
  async deleteEmail(_emailId: string, _permanent?: boolean): Promise<void> {
    throw new Error('Not implemented yet');
  }
  async markEmail(_emailId: string, _flags: { read?: boolean; starred?: boolean; flagged?: boolean }): Promise<void> {
    throw new Error('Not implemented yet');
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/providers/imap.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/providers/imap/ tests/providers/imap.test.ts
git commit -m "feat: add IMAP adapter with connection and folder listing"
```

---

### Task 6: IMAP adapter — search and get email

**Files:**
- Modify: `src/providers/imap/adapter.ts`
- Modify: `tests/providers/imap.test.ts`

**Step 1: Add search and getEmail tests**

Append to `tests/providers/imap.test.ts`:

```typescript
describe('ImapAdapter search and getEmail', () => {
  // These tests require more detailed imapflow mocking.
  // Mock the mailbox open, fetch, and search methods.
  // Test that SearchQuery fields map to correct IMAP search criteria.
  // Test that fetched messages are mapped through mapParsedEmail.
  // Test limit/offset pagination.
  // Test getEmail fetches a single message by UID.
});
```

Full test code should mock `client.getMailboxLock()`, `client.fetch()`, `client.search()` and verify:
- `search({ folder: 'INBOX', from: 'alice@test.com' })` passes correct IMAP search criteria
- Results are mapped to `Email[]` via mapper
- `getEmail('123')` fetches message by UID and returns a full `Email`
- `limit` and `offset` work correctly

**Step 2: Implement search and getEmail in adapter**

Replace the stub methods in `src/providers/imap/adapter.ts` with real implementations using `imapflow`'s `search()`, `fetch()`, and `mailboxOpen()`.

Key implementation notes:
- `SearchQuery.folder` → `client.getMailboxLock(folder)`
- `SearchQuery.from` → `{ from: query.from }`
- `SearchQuery.since` → `{ since: new Date(query.since) }`
- `SearchQuery.unreadOnly` → `{ unseen: true }`
- Use `simpleParser` from `mailparser` to parse raw IMAP messages
- Apply `limit` and `offset` after search (IMAP search returns all matching UIDs, then fetch a slice)

**Step 3: Run tests**

```bash
npx vitest run tests/providers/imap.test.ts
```

Expected: PASS

**Step 4: Commit**

```bash
git add src/providers/imap/adapter.ts tests/providers/imap.test.ts
git commit -m "feat: add IMAP search and getEmail"
```

---

### Task 7: IMAP adapter — send, move, delete, mark, createFolder

**Files:**
- Create: `src/providers/imap/smtp.ts`
- Modify: `src/providers/imap/adapter.ts`
- Modify: `tests/providers/imap.test.ts`

**Step 1: Write tests for SMTP sending, move, delete, mark, createFolder**

Test that:
- `sendEmail()` calls `nodemailer.createTransport().sendMail()` with correct params
- `moveEmail(uid, targetFolder)` calls `client.messageMove(uid, targetFolder)`
- `deleteEmail(uid)` moves to Trash, `deleteEmail(uid, true)` expunges
- `markEmail(uid, { read: true })` calls `client.messageFlagsAdd(uid, ['\\Seen'])`
- `createFolder(name)` calls `client.mailboxCreate(name)`

**Step 2: Implement SMTP helper**

Create `src/providers/imap/smtp.ts` using `nodemailer`:

```typescript
import nodemailer from 'nodemailer';
import type { SendEmailParams } from '../provider.js';
import type { PasswordCredentials } from '../../models/types.js';

export function createSmtpTransport(email: string, creds: PasswordCredentials) {
  return nodemailer.createTransport({
    host: creds.smtpHost || creds.host.replace('imap', 'smtp'),
    port: creds.smtpPort || 587,
    secure: creds.smtpPort === 465,
    auth: { user: email, pass: creds.password },
  });
}

export async function sendViaSmtp(
  transport: nodemailer.Transporter,
  from: string,
  params: SendEmailParams
): Promise<string> {
  const result = await transport.sendMail({
    from,
    to: params.to.map((c) => (c.name ? `"${c.name}" <${c.email}>` : c.email)).join(', '),
    cc: params.cc?.map((c) => c.email).join(', '),
    bcc: params.bcc?.map((c) => c.email).join(', '),
    subject: params.subject,
    text: params.body.text,
    html: params.body.html,
    inReplyTo: params.inReplyTo,
    references: params.references?.join(' '),
    attachments: params.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
  return result.messageId;
}
```

**Step 3: Implement remaining adapter methods**

Replace stubs in `src/providers/imap/adapter.ts`.

**Step 4: Run tests**

```bash
npx vitest run tests/providers/imap.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/imap/ tests/providers/imap.test.ts
git commit -m "feat: add IMAP send, move, delete, mark, createFolder"
```

---

### Task 8: IMAP adapter — threads, drafts, attachments

**Files:**
- Modify: `src/providers/imap/adapter.ts`
- Modify: `tests/providers/imap.test.ts`

**Step 1: Write tests**

Test that:
- `getThread(messageId)` searches by References/In-Reply-To headers and returns grouped `Thread`
- `createDraft(params)` appends to Drafts folder with `\Draft` flag
- `listDrafts()` fetches from Drafts folder
- `getAttachment(emailId, attachmentId)` returns the binary content and metadata

**Step 2: Implement**

- Thread: search IMAP for messages with matching `References` or `In-Reply-To` headers, group into `Thread`
- Drafts: use `client.append()` to save to Drafts folder
- Attachments: fetch full message, parse with `simpleParser`, extract attachment by ID

**Step 3: Run tests, commit**

```bash
npx vitest run tests/providers/imap.test.ts
git add src/providers/imap/ tests/providers/imap.test.ts
git commit -m "feat: add IMAP threads, drafts, and attachments"
```

---

### Task 9: iCloud adapter (extends IMAP)

**Files:**
- Create: `src/providers/icloud/adapter.ts`
- Create: `src/providers/icloud/mapper.ts`
- Test: `tests/providers/icloud.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ICloudAdapter } from '../src/providers/icloud/adapter.js';
import { ProviderType } from '../src/models/types.js';

// Same imapflow mock as imap.test.ts

describe('ICloudAdapter', () => {
  it('has icloud provider type', () => {
    const adapter = new ICloudAdapter();
    expect(adapter.providerType).toBe(ProviderType.ICloud);
  });

  it('uses iCloud IMAP defaults when not specified', async () => {
    // Verify it sets host=imap.mail.me.com, port=993, tls=true
    // and smtpHost=smtp.mail.me.com, smtpPort=587
  });
});
```

**Step 2: Implement**

Create `src/providers/icloud/adapter.ts`:

```typescript
import { ImapAdapter } from '../imap/adapter.js';
import { ProviderType } from '../../models/types.js';
import type { AccountCredentials, ProviderTypeValue } from '../../models/types.js';

export class ICloudAdapter extends ImapAdapter {
  override readonly providerType: ProviderTypeValue = ProviderType.ICloud;

  override async connect(credentials: AccountCredentials): Promise<void> {
    const withDefaults: AccountCredentials = {
      ...credentials,
      password: {
        host: 'imap.mail.me.com',
        port: 993,
        tls: true,
        smtpHost: 'smtp.mail.me.com',
        smtpPort: 587,
        ...credentials.password!,
      },
    };
    return super.connect(withDefaults);
  }
}
```

**Step 3: Run tests, commit**

```bash
npx vitest run tests/providers/icloud.test.ts
git add src/providers/icloud/ tests/providers/icloud.test.ts
git commit -m "feat: add iCloud adapter extending IMAP"
```

---

## Phase 3: Gmail Provider

### Task 10: Gmail OAuth2 auth flow

**Files:**
- Create: `src/providers/gmail/auth.ts`
- Create: `src/auth/oauth-server.ts`
- Test: `tests/providers/gmail-auth.test.ts`

**Step 1: Write tests**

Test that:
- `GmailAuth.getAuthUrl()` returns a valid Google OAuth URL with correct scopes and PKCE
- `GmailAuth.exchangeCode(code, codeVerifier)` returns tokens
- `GmailAuth.refreshToken(refreshToken)` returns new access token
- `OAuthCallbackServer` starts on a random port, receives callback, extracts auth code, shuts down

**Step 2: Implement OAuth callback server**

Create `src/auth/oauth-server.ts` — a minimal HTTP server that:
- Starts on a random available port
- Listens for `GET /callback?code=...`
- Resolves a promise with the auth code
- Serves a "success" HTML page to the browser
- Auto-shuts down after receiving the code or after a timeout

**Step 3: Implement Gmail auth**

Create `src/providers/gmail/auth.ts` using `google-auth-library`:
- `getAuthUrl()`: generates authorization URL with PKCE
- `exchangeCode()`: exchanges auth code for tokens
- `refreshToken()`: refreshes access token
- Stores client ID/secret as constants (bundled in package)

**Step 4: Run tests, commit**

```bash
npx vitest run tests/providers/gmail-auth.test.ts
git add src/providers/gmail/auth.ts src/auth/oauth-server.ts tests/providers/gmail-auth.test.ts
git commit -m "feat: add Gmail OAuth2 auth and callback server"
```

---

### Task 11: Gmail adapter — connection, folders, search, get

**Files:**
- Create: `src/providers/gmail/adapter.ts`
- Create: `src/providers/gmail/mapper.ts`
- Test: `tests/providers/gmail.test.ts`

**Step 1: Write tests**

Mock `googleapis` gmail client. Test that:
- `connect()` initializes Gmail API client with OAuth tokens
- `listFolders()` calls `gmail.users.labels.list()` and maps labels to `Folder[]`
- `search({ from: 'alice', unreadOnly: true })` calls `gmail.users.messages.list({ q: 'from:alice is:unread' })`
- `getEmail(id)` calls `gmail.users.messages.get()` with `format: 'full'` and maps to `Email`
- `getThread(id)` calls `gmail.users.threads.get()` and maps to `Thread`

**Step 2: Implement Gmail mapper**

Create `src/providers/gmail/mapper.ts`:
- `mapGmailLabel(label)` → `Folder` (map label type to folder type: INBOX, SENT, DRAFT, TRASH, SPAM, etc.)
- `mapGmailMessage(message, accountId)` → `Email` (decode base64url body, parse headers, extract attachments)
- `buildGmailQuery(searchQuery)` → string (convert `SearchQuery` to Gmail search syntax like `from:x after:2026/01/01 has:attachment`)

**Step 3: Implement Gmail adapter**

Create `src/providers/gmail/adapter.ts`:
- Initialize `google.gmail({ version: 'v1', auth: oauthClient })`
- Map all `EmailProvider` methods to Gmail API calls
- Native threading via `gmail.users.threads.get()`
- Native labels via `addLabels()` / `removeLabels()` / `listLabels()`

**Step 4: Run tests, commit**

```bash
npx vitest run tests/providers/gmail.test.ts
git add src/providers/gmail/ tests/providers/gmail.test.ts
git commit -m "feat: add Gmail adapter with full API support"
```

---

### Task 12: Gmail adapter — send, drafts, move, delete, mark, labels

**Files:**
- Modify: `src/providers/gmail/adapter.ts`
- Modify: `tests/providers/gmail.test.ts`

**Step 1: Write tests**

Test that:
- `sendEmail()` calls `gmail.users.messages.send()` with RFC 2822 encoded message
- `createDraft()` calls `gmail.users.drafts.create()`
- `listDrafts()` calls `gmail.users.drafts.list()`
- `moveEmail(id, folder)` adds target label, removes source label
- `deleteEmail(id)` calls `gmail.users.messages.trash()`, permanent calls `gmail.users.messages.delete()`
- `markEmail(id, { read: true })` calls `gmail.users.messages.modify()` removing UNREAD label
- `addLabels()` / `removeLabels()` / `listLabels()` work correctly

**Step 2: Implement, run tests, commit**

```bash
npx vitest run tests/providers/gmail.test.ts
git add src/providers/gmail/ tests/providers/gmail.test.ts
git commit -m "feat: add Gmail send, drafts, organize, and labels"
```

---

## Phase 4: Outlook Provider

### Task 13: Outlook OAuth2 auth flow

**Files:**
- Create: `src/providers/outlook/auth.ts`
- Test: `tests/providers/outlook-auth.test.ts`

**Step 1: Write tests**

Test that:
- `OutlookAuth.getAuthUrl()` returns valid Microsoft auth URL with `consumers` tenant, correct scopes, PKCE
- `OutlookAuth.exchangeCode()` returns tokens
- `OutlookAuth.refreshToken()` returns new access token

**Step 2: Implement**

Create `src/providers/outlook/auth.ts` using `@azure/msal-node`:
- Use `PublicClientApplication` with `consumers` authority
- Scopes: `Mail.ReadWrite`, `Mail.Send`, `offline_access`
- Reuse `OAuthCallbackServer` from Task 10

**Step 3: Run tests, commit**

```bash
npx vitest run tests/providers/outlook-auth.test.ts
git add src/providers/outlook/auth.ts tests/providers/outlook-auth.test.ts
git commit -m "feat: add Outlook OAuth2 auth"
```

---

### Task 14: Outlook adapter — connection, folders, search, get

**Files:**
- Create: `src/providers/outlook/adapter.ts`
- Create: `src/providers/outlook/mapper.ts`
- Test: `tests/providers/outlook.test.ts`

**Step 1: Write tests**

Mock `@microsoft/microsoft-graph-client`. Test that:
- `connect()` initializes Graph client with bearer token
- `listFolders()` calls `GET /me/mailFolders` and maps to `Folder[]`
- `search()` calls `GET /me/messages?$filter=...&$search=...` with OData filters
- `getEmail(id)` calls `GET /me/messages/{id}` and maps to `Email`
- `getThread(id)` calls `GET /me/messages?$filter=conversationId eq '{id}'` and maps to `Thread`

**Step 2: Implement mapper**

Create `src/providers/outlook/mapper.ts`:
- `mapGraphFolder(folder)` → `Folder` (map `wellKnownName` to folder type)
- `mapGraphMessage(message, accountId)` → `Email` (map Graph message fields)
- `buildGraphFilter(searchQuery)` → OData filter string

**Step 3: Implement adapter**

Create `src/providers/outlook/adapter.ts`:
- Use `Client.init()` from `@microsoft/microsoft-graph-client`
- Map `EmailProvider` methods to Graph API endpoints
- Threading via `conversationId`
- Categories via `getCategories()`

**Step 4: Run tests, commit**

```bash
npx vitest run tests/providers/outlook.test.ts
git add src/providers/outlook/ tests/providers/outlook.test.ts
git commit -m "feat: add Outlook adapter with Graph API"
```

---

### Task 15: Outlook adapter — send, drafts, move, delete, mark, categories

**Files:**
- Modify: `src/providers/outlook/adapter.ts`
- Modify: `tests/providers/outlook.test.ts`

**Step 1: Write tests**

Test that:
- `sendEmail()` calls `POST /me/sendMail`
- `createDraft()` calls `POST /me/messages` (creates draft)
- `moveEmail(id, folderId)` calls `POST /me/messages/{id}/move`
- `deleteEmail(id)` moves to Deleted Items, permanent calls `DELETE /me/messages/{id}`
- `markEmail(id, { read: true })` calls `PATCH /me/messages/{id}` with `isRead: true`
- `getCategories()` returns message categories

**Step 2: Implement, run tests, commit**

```bash
npx vitest run tests/providers/outlook.test.ts
git add src/providers/outlook/ tests/providers/outlook.test.ts
git commit -m "feat: add Outlook send, drafts, organize, and categories"
```

---

## Phase 5: Account Manager & MCP Server

### Task 16: Account Manager

**Files:**
- Create: `src/account-manager.ts`
- Test: `tests/account-manager.test.ts`

**Step 1: Write tests**

Test that:
- `listAccounts()` returns accounts from credential store with `connected` status
- `getProvider(accountId)` returns the correct adapter instance
- `connectAccount(accountId)` connects the right adapter type based on `provider` field
- `addAccount(credentials)` saves to store and connects
- `removeAccount(accountId)` disconnects and removes from store
- Token refresh is triggered transparently when OAuth tokens near expiry
- One provider failing doesn't affect others

**Step 2: Implement**

Create `src/account-manager.ts`:

```typescript
import { CredentialStore } from './auth/credential-store.js';
import { GmailAdapter } from './providers/gmail/adapter.js';
import { OutlookAdapter } from './providers/outlook/adapter.js';
import { ICloudAdapter } from './providers/icloud/adapter.js';
import { ImapAdapter } from './providers/imap/adapter.js';
import type { EmailProvider } from './providers/provider.js';
import type { Account, AccountCredentials } from './models/types.js';

export class AccountManager {
  private store: CredentialStore;
  private providers: Map<string, EmailProvider> = new Map();

  constructor(store?: CredentialStore) {
    this.store = store ?? new CredentialStore();
  }

  // Creates correct provider instance based on credentials.provider
  // Manages connection lifecycle
  // Handles token refresh for OAuth providers
}
```

**Step 3: Run tests, commit**

```bash
npx vitest run tests/account-manager.test.ts
git add src/account-manager.ts tests/account-manager.test.ts
git commit -m "feat: add account manager"
```

---

### Task 17: MCP Server — account tools

**Files:**
- Create: `src/server.ts`
- Create: `src/tools/accounts.ts`
- Test: `tests/tools/accounts.test.ts`

**Step 1: Write tests**

Test that MCP tool handlers:
- `email_list_accounts` returns account list from AccountManager
- `email_test_account` calls `testConnection()` on the provider
- `email_remove_account` calls `removeAccount()` on the AccountManager

**Step 2: Implement server skeleton**

Create `src/server.ts`:
- Initialize `McpServer` from `@modelcontextprotocol/sdk`
- Use stdio transport
- Register tools from `tools/*.ts`

Create `src/tools/accounts.ts`:
- Register `email_list_accounts`, `email_add_account`, `email_remove_account`, `email_test_account`
- Each tool takes `accountId` param, routes to AccountManager

**Step 3: Run tests, commit**

```bash
npx vitest run tests/tools/accounts.test.ts
git add src/server.ts src/tools/accounts.ts tests/tools/accounts.test.ts
git commit -m "feat: add MCP server with account tools"
```

---

### Task 18: MCP tools — reading (search, get, thread, attachment)

**Files:**
- Create: `src/tools/reading.ts`
- Test: `tests/tools/reading.test.ts`

**Step 1: Write tests**

Test that:
- `email_search` validates params, routes to `provider.search(query)`
- `email_get` routes to `provider.getEmail(id)`
- `email_get_thread` routes to `provider.getThread(threadId)`
- `email_get_attachment` routes to `provider.getAttachment(emailId, attachmentId)`
- `email_list_folders` routes to `provider.listFolders()`
- Invalid `accountId` returns clear error
- Results are properly serialized to MCP content format

**Step 2: Implement**

Create `src/tools/reading.ts`:
- Register each tool with `server.tool(name, schema, handler)`
- Zod schemas for input validation
- Route to correct provider via AccountManager

**Step 3: Run tests, commit**

```bash
npx vitest run tests/tools/reading.test.ts
git add src/tools/reading.ts tests/tools/reading.test.ts
git commit -m "feat: add MCP reading tools"
```

---

### Task 19: MCP tools — sending (send, reply, forward, drafts)

**Files:**
- Create: `src/tools/sending.ts`
- Test: `tests/tools/sending.test.ts`

**Step 1: Write tests**

Test that:
- `email_send` validates params (requires to, subject), routes to `provider.sendEmail()`
- `email_reply` fetches original email first, then sends with inReplyTo and references
- `email_forward` wraps original body, sends to new recipients
- `email_draft_create` routes to `provider.createDraft()`
- `email_draft_list` routes to `provider.listDrafts()`

**Step 2: Implement, run tests, commit**

```bash
npx vitest run tests/tools/sending.test.ts
git add src/tools/sending.ts tests/tools/sending.test.ts
git commit -m "feat: add MCP sending tools"
```

---

### Task 20: MCP tools — organizing (move, delete, mark, label, folder)

**Files:**
- Create: `src/tools/organizing.ts`
- Test: `tests/tools/organizing.test.ts`

**Step 1: Write tests**

Test that:
- `email_move` routes to `provider.moveEmail()`
- `email_delete` routes to `provider.deleteEmail()`, accepts `permanent` flag
- `email_mark` routes to `provider.markEmail()`, accepts read/starred/flagged
- `email_label` calls `provider.addLabels()` / `provider.removeLabels()`, returns "not supported" for non-Gmail
- `email_folder_create` routes to `provider.createFolder()`
- `email_get_labels` calls `provider.listLabels()`, returns "not supported" for non-Gmail
- `email_get_categories` calls `provider.getCategories()`, returns "not supported" for non-Outlook

**Step 2: Implement, run tests, commit**

```bash
npx vitest run tests/tools/organizing.test.ts
git add src/tools/organizing.ts tests/tools/organizing.test.ts
git commit -m "feat: add MCP organizing tools"
```

---

### Task 21: Wire up entry point and build

**Files:**
- Create: `src/index.ts`
- Modify: `build.mjs` if needed

**Step 1: Create entry point**

Create `src/index.ts`:

```typescript
import { createServer } from './server.js';

async function main() {
  const server = await createServer();
  // Server runs on stdio — started by MCP host
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

**Step 2: Build and verify**

```bash
npm run build
node dist/index.js --help  # should start without errors
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up MCP server entry point"
```

---

## Phase 6: Setup Wizard

### Task 22: Interactive setup wizard

**Files:**
- Create: `src/setup/wizard.ts`
- No automated tests (interactive CLI — manual QA only)

**Step 1: Implement wizard**

Create `src/setup/wizard.ts` using `inquirer`:
- Prompt for provider selection (Gmail / Outlook / iCloud / Other IMAP)
- Gmail/Outlook: launch OAuth flow via `OAuthCallbackServer`, open browser with auth URL
- iCloud: prompt for email + app-specific password
- Generic IMAP: prompt for host, port, tls, email, password, SMTP settings
- Test connection after setup
- Prompt for account name
- Save to `CredentialStore`
- Support `--list` flag to show accounts, `--remove <id>` to remove

**Step 2: Build and test manually**

```bash
npm run build
node dist/setup.js
```

**Step 3: Commit**

```bash
git add src/setup/wizard.ts
git commit -m "feat: add interactive setup wizard"
```

---

## Phase 7: Polish & Documentation

### Task 23: Write README

**Files:**
- Modify: `README.md`

Write complete README with:
- Project description
- Features list
- Installation: `npx email-mcp setup`
- Usage with Claude Code (`.mcp.json` config)
- Provider setup guides (Google Cloud Console, Azure portal, iCloud app passwords)
- Available tools reference
- Development setup

**Commit:**

```bash
git add README.md
git commit -m "docs: add comprehensive README"
```

---

### Task 24: End-to-end smoke test

**Files:**
- Create: `tests/integration/smoke.test.ts`

Manual/integration test that:
1. Builds the project
2. Starts the MCP server
3. Sends a `tools/list` request via stdin
4. Verifies all expected tools are registered
5. Sends `email_list_accounts` and verifies empty response

This test doesn't need real email accounts — it validates the server boots and responds.

**Commit:**

```bash
git add tests/integration/smoke.test.ts
git commit -m "test: add end-to-end smoke test"
```

---

## Task Dependency Graph

```
Task 1 (scaffold)
  └── Task 2 (types)
       ├── Task 3 (credential store)
       │    └── Task 16 (account manager)
       │         ├── Task 17 (MCP account tools)
       │         ├── Task 18 (MCP reading tools)
       │         ├── Task 19 (MCP sending tools)
       │         └── Task 20 (MCP organizing tools)
       │              └── Task 21 (entry point)
       │                   └── Task 22 (setup wizard)
       │                        └── Task 23 (README)
       │                             └── Task 24 (smoke test)
       ├── Task 4 (provider interface)
       │    ├── Task 5 (IMAP connect + folders)
       │    │    ├── Task 6 (IMAP search + get)
       │    │    │    ├── Task 7 (IMAP send/move/delete)
       │    │    │    │    └── Task 8 (IMAP threads/drafts/attachments)
       │    │    │    └── Task 9 (iCloud adapter)
       │    │    └── Task 9 (iCloud adapter)
       │    ├── Task 10 (Gmail auth)
       │    │    └── Task 11 (Gmail adapter read)
       │    │         └── Task 12 (Gmail adapter write)
       │    └── Task 13 (Outlook auth)
       │         └── Task 14 (Outlook adapter read)
       │              └── Task 15 (Outlook adapter write)
       └── (all above feed into Task 16)
```

## Parallelization Opportunities

These task groups can be worked on in parallel by different agents:

- **Agent A**: Tasks 5-9 (IMAP + iCloud providers)
- **Agent B**: Tasks 10-12 (Gmail provider)
- **Agent C**: Tasks 13-15 (Outlook provider)

All three converge at Task 16 (Account Manager). Tasks 3 (credential store) and 4 (provider interface) must complete first.

Tasks 17-20 (MCP tools) can also be parallelized once Task 16 is done.
