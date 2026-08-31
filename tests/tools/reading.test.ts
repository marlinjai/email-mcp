import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from '../../src/account-manager.js';
import { registerReadingTools } from '../../src/tools/reading.js';
import type { EmailProvider } from '../../src/providers/provider.js';
import type { Email, Folder, Thread, AttachmentMeta } from '../../src/models/types.js';

// --- helpers ---

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'msg-1',
    accountId: 'acct-1',
    folder: 'INBOX',
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'bob@example.com', name: 'Bob' }],
    subject: 'Hello',
    date: '2026-01-15T10:00:00Z',
    body: { text: 'Hi Bob', html: '<p>Hi Bob</p>' },
    attachments: [],
    flags: { read: true, starred: false, flagged: false, draft: false },
    ...overrides,
  };
}

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'INBOX',
    name: 'INBOX',
    path: 'INBOX',
    type: 'inbox',
    unreadCount: 5,
    totalCount: 100,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    subject: 'Thread Subject',
    participants: [
      { email: 'alice@example.com', name: 'Alice' },
      { email: 'bob@example.com', name: 'Bob' },
    ],
    messageCount: 2,
    messages: [makeEmail({ id: 'msg-1' }), makeEmail({ id: 'msg-2' })],
    lastMessageDate: '2026-01-16T10:00:00Z',
    ...overrides,
  };
}

function makeMockProvider(overrides: Partial<EmailProvider> = {}): EmailProvider {
  return {
    providerType: 'imap',
    connect: vi.fn(),
    disconnect: vi.fn(),
    testConnection: vi.fn(),
    listFolders: vi.fn().mockResolvedValue([
      makeFolder(),
      makeFolder({ id: 'Sent', name: 'Sent', path: 'Sent', type: 'sent', unreadCount: 0, totalCount: 50 }),
    ]),
    createFolder: vi.fn(),
    search: vi.fn().mockResolvedValue([makeEmail({ id: 'msg-1' }), makeEmail({ id: 'msg-2' })]),
    getEmail: vi.fn().mockResolvedValue(makeEmail()),
    getThread: vi.fn().mockResolvedValue(makeThread()),
    getAttachment: vi.fn().mockResolvedValue({
      data: Buffer.from('file-content'),
      meta: {
        id: 'att-1',
        filename: 'document.pdf',
        contentType: 'application/pdf',
        size: 12,
      } as AttachmentMeta,
    }),
    sendEmail: vi.fn(),
    createDraft: vi.fn(),
    listDrafts: vi.fn(),
    moveEmail: vi.fn(),
    deleteEmail: vi.fn(),
    markEmail: vi.fn(),
    ...overrides,
  } as unknown as EmailProvider;
}

// Extract registered tool handlers from the McpServer
function getRegisteredTools(server: McpServer): Record<string, { handler: Function }> {
  return (server as any)._registeredTools;
}

function hasRegisteredTool(server: McpServer, toolName: string): boolean {
  const tools = getRegisteredTools(server);
  return toolName in tools;
}

async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const tools = getRegisteredTools(server);
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  const result = await (tool.handler as Function)(args, {});
  return result as { content: Array<{ type: string; text: string }> };
}

// --- tests ---

describe('Reading tools', () => {
  let server: McpServer;
  let accountManager: AccountManager;
  let mockProvider: EmailProvider;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
    mockProvider = makeMockProvider();
    accountManager = {
      getProvider: vi.fn().mockResolvedValue(mockProvider),
    } as unknown as AccountManager;
    registerReadingTools(server, accountManager);
  });

  describe('email_list_folders', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_list_folders')).toBe(true);
    });

    it('calls provider.listFolders and returns folder list', async () => {
      const result = await callTool(server, 'email_list_folders', {
        accountId: 'acct-1',
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.listFolders).toHaveBeenCalled();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe('INBOX');
      expect(parsed[0].type).toBe('inbox');
      expect(parsed[0].unreadCount).toBe(5);
      expect(parsed[1].id).toBe('Sent');
    });
  });

  describe('email_search', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_search')).toBe(true);
    });

    it('calls provider.search with all params', async () => {
      const result = await callTool(server, 'email_search', {
        accountId: 'acct-1',
        folder: 'INBOX',
        from: 'alice@example.com',
        to: 'bob@example.com',
        subject: 'Hello',
        body: 'content',
        since: '2026-01-01',
        before: '2026-02-01',
        unreadOnly: true,
        starredOnly: false,
        hasAttachment: true,
        limit: 20,
        offset: 10,
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.search).toHaveBeenCalledWith({
        folder: 'INBOX',
        from: 'alice@example.com',
        to: 'bob@example.com',
        subject: 'Hello',
        body: 'content',
        since: '2026-01-01',
        before: '2026-02-01',
        unreadOnly: true,
        starredOnly: false,
        hasAttachment: true,
        limit: 20,
        offset: 10,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe('msg-1');
    });

    it('works with minimal params (only accountId)', async () => {
      const result = await callTool(server, 'email_search', {
        accountId: 'acct-1',
      });

      expect(mockProvider.search).toHaveBeenCalledWith({});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
    });

    it('passes only provided optional params', async () => {
      await callTool(server, 'email_search', {
        accountId: 'acct-1',
        folder: 'INBOX',
        unreadOnly: true,
      });

      expect(mockProvider.search).toHaveBeenCalledWith({
        folder: 'INBOX',
        unreadOnly: true,
      });
    });
  });

  describe('email_get', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_get')).toBe(true);
    });

    it('calls provider.getEmail and returns email', async () => {
      const result = await callTool(server, 'email_get', {
        accountId: 'acct-1',
        emailId: 'msg-1',
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.getEmail).toHaveBeenCalledWith('msg-1');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('msg-1');
      expect(parsed.from.email).toBe('alice@example.com');
      expect(parsed.subject).toBe('Hello');
    });
  });

  describe('email_get_thread', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_get_thread')).toBe(true);
    });

    it('calls provider.getThread and returns thread', async () => {
      const result = await callTool(server, 'email_get_thread', {
        accountId: 'acct-1',
        threadId: 'thread-1',
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.getThread).toHaveBeenCalledWith('thread-1');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('thread-1');
      expect(parsed.subject).toBe('Thread Subject');
      expect(parsed.messageCount).toBe(2);
      expect(parsed.messages).toHaveLength(2);
      expect(parsed.participants).toHaveLength(2);
    });
  });

  describe('email_get_attachment', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_get_attachment')).toBe(true);
    });

    it('calls provider.getAttachment and returns base64 data', async () => {
      const result = await callTool(server, 'email_get_attachment', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        attachmentId: 'att-1',
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.getAttachment).toHaveBeenCalledWith('msg-1', 'att-1');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data).toBe(Buffer.from('file-content').toString('base64'));
      expect(parsed.meta.id).toBe('att-1');
      expect(parsed.meta.filename).toBe('document.pdf');
      expect(parsed.meta.contentType).toBe('application/pdf');
      expect(parsed.meta.size).toBe(12);
    });
  });

  describe('email_save_attachment', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-downloads-test-'));
      vi.stubEnv('EMAIL_MCP_DOWNLOADS_DIR', tmpDir);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_save_attachment')).toBe(true);
    });

    it('writes the attachment to disk under the downloads dir and returns metadata only', async () => {
      const result = await callTool(server, 'email_save_attachment', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        attachmentId: 'att-1',
        outputPath: 'document.pdf',
      });

      expect(mockProvider.getAttachment).toHaveBeenCalledWith('msg-1', 'att-1');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.path).toBe(path.join(tmpDir, 'document.pdf'));
      expect(parsed.filename).toBe('document.pdf');
      expect(parsed.mimeType).toBe('application/pdf');
      expect(parsed.bytes).toBe(Buffer.from('file-content').length);
      expect(parsed.data).toBeUndefined();

      expect(fs.readFileSync(path.join(tmpDir, 'document.pdf'), 'utf-8')).toBe('file-content');
    });

    it('creates nested subdirectories under the downloads dir', async () => {
      const result = await callTool(server, 'email_save_attachment', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        attachmentId: 'att-1',
        outputPath: 'invoices/2026/document.pdf',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.path).toBe(path.join(tmpDir, 'invoices', '2026', 'document.pdf'));
      expect(fs.existsSync(parsed.path)).toBe(true);
    });

    it('rejects an outputPath that escapes the downloads directory via traversal', async () => {
      const result = await callTool(server, 'email_save_attachment', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        attachmentId: 'att-1',
        outputPath: '../../../etc/passwd',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('must resolve inside');
      expect(mockProvider.getAttachment).not.toHaveBeenCalled();
    });

    it('rejects an absolute outputPath outside the downloads directory', async () => {
      const result = await callTool(server, 'email_save_attachment', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        attachmentId: 'att-1',
        outputPath: '/etc/passwd',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('must resolve inside');
    });
  });

  describe('error handling', () => {
    it('returns error when accountId is invalid', async () => {
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Account nonexistent not found'),
      );

      const result = await callTool(server, 'email_list_folders', {
        accountId: 'nonexistent',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Account nonexistent not found');
    });

    it('returns error when provider.search throws', async () => {
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(mockProvider);
      (mockProvider.search as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Search failed'),
      );

      const result = await callTool(server, 'email_search', {
        accountId: 'acct-1',
        folder: 'INBOX',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Search failed');
    });

    it('returns error when provider.getEmail throws', async () => {
      (mockProvider.getEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Email not found'),
      );

      const result = await callTool(server, 'email_get', {
        accountId: 'acct-1',
        emailId: 'nonexistent',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Email not found');
    });

    it('returns error when provider.getThread throws', async () => {
      (mockProvider.getThread as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Thread not found'),
      );

      const result = await callTool(server, 'email_get_thread', {
        accountId: 'acct-1',
        threadId: 'nonexistent',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Thread not found');
    });

    it('returns error when provider.getAttachment throws', async () => {
      (mockProvider.getAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Attachment not found'),
      );

      const result = await callTool(server, 'email_get_attachment', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        attachmentId: 'nonexistent',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Attachment not found');
    });
  });
});
