import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from '../../src/account-manager.js';
import { registerSendingTools } from '../../src/tools/sending.js';
import type { EmailProvider, SendEmailParams } from '../../src/providers/provider.js';
import type { Email } from '../../src/models/types.js';

// --- helpers ---

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'msg-1',
    accountId: 'acct-1',
    folder: 'INBOX',
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'bob@example.com', name: 'Bob' }],
    cc: [{ email: 'carol@example.com' }],
    subject: 'Hello',
    date: '2026-01-15T10:00:00Z',
    body: { text: 'Hi Bob', html: '<p>Hi Bob</p>' },
    attachments: [],
    flags: { read: true, starred: false, flagged: false, draft: false },
    headers: { 'message-id': '<msg-1@example.com>' },
    ...overrides,
  };
}

function makeMockProvider(overrides: Partial<EmailProvider> = {}): EmailProvider {
  return {
    providerType: 'imap',
    connect: vi.fn(),
    disconnect: vi.fn(),
    testConnection: vi.fn(),
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    search: vi.fn(),
    getEmail: vi.fn().mockResolvedValue(makeEmail()),
    getThread: vi.fn(),
    getAttachment: vi.fn(),
    sendEmail: vi.fn().mockResolvedValue({ id: 'sent-1', threadId: 'thread-1' }),
    createDraft: vi.fn().mockResolvedValue({ id: 'draft-1' }),
    updateDraft: vi.fn().mockResolvedValue({ id: 'draft-1' }),
    listDrafts: vi.fn().mockResolvedValue([]),
    moveEmail: vi.fn(),
    deleteEmail: vi.fn(),
    markEmail: vi.fn(),
    ...overrides,
  } as unknown as EmailProvider;
}

// Extract registered tool handlers from the McpServer
function getRegisteredTools(server: McpServer): Record<string, { handler: Function }> {
  // Access internal _registeredTools object
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

describe('Sending tools', () => {
  let server: McpServer;
  let accountManager: AccountManager;
  let mockProvider: EmailProvider;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
    mockProvider = makeMockProvider();
    accountManager = {
      getProvider: vi.fn().mockResolvedValue(mockProvider),
    } as unknown as AccountManager;
    registerSendingTools(server, accountManager);
  });

  describe('email_send', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_send')).toBe(true);
    });

    it('calls provider.sendEmail with correct params', async () => {
      const result = await callTool(server, 'email_send', {
        accountId: 'acct-1',
        to: [{ email: 'bob@example.com', name: 'Bob' }],
        subject: 'Test Subject',
        body: { text: 'Hello world' },
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [{ email: 'bob@example.com', name: 'Bob' }],
          subject: 'Test Subject',
          body: { text: 'Hello world' },
        }),
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('sent-1');
      expect(parsed.threadId).toBe('thread-1');
    });

    it('passes cc and bcc to provider', async () => {
      await callTool(server, 'email_send', {
        accountId: 'acct-1',
        to: [{ email: 'bob@example.com' }],
        cc: [{ email: 'carol@example.com' }],
        bcc: [{ email: 'dave@example.com' }],
        subject: 'Test',
        body: { text: 'Hi' },
      });

      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: [{ email: 'carol@example.com' }],
          bcc: [{ email: 'dave@example.com' }],
        }),
      );
    });

    it('supports html body', async () => {
      await callTool(server, 'email_send', {
        accountId: 'acct-1',
        to: [{ email: 'bob@example.com' }],
        subject: 'HTML Test',
        body: { html: '<p>Hello</p>' },
      });

      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { html: '<p>Hello</p>' },
        }),
      );
    });
  });

  describe('email_reply', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_reply')).toBe(true);
    });

    it('fetches original email and sends with threading headers', async () => {
      const originalEmail = makeEmail({
        id: 'orig-1',
        from: { email: 'alice@example.com', name: 'Alice' },
        to: [{ email: 'me@example.com' }],
        subject: 'Original Subject',
        headers: { 'message-id': '<orig-1@example.com>' },
      });
      (mockProvider.getEmail as ReturnType<typeof vi.fn>).mockResolvedValue(originalEmail);

      const result = await callTool(server, 'email_reply', {
        accountId: 'acct-1',
        emailId: 'orig-1',
        body: { text: 'Thanks for your message!' },
      });

      // Should fetch the original email
      expect(mockProvider.getEmail).toHaveBeenCalledWith('orig-1');

      // Should send with threading headers and reply to sender
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [{ email: 'alice@example.com', name: 'Alice' }],
          subject: 'Re: Original Subject',
          body: { text: 'Thanks for your message!' },
          inReplyTo: '<orig-1@example.com>',
          references: ['<orig-1@example.com>'],
        }),
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('sent-1');
    });

    it('does not duplicate Re: prefix', async () => {
      const originalEmail = makeEmail({
        subject: 'Re: Already a reply',
        headers: { 'message-id': '<orig-2@example.com>' },
      });
      (mockProvider.getEmail as ReturnType<typeof vi.fn>).mockResolvedValue(originalEmail);

      await callTool(server, 'email_reply', {
        accountId: 'acct-1',
        emailId: 'orig-2',
        body: { text: 'Reply again' },
      });

      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Re: Already a reply',
        }),
      );
    });

    it('reply-all includes cc recipients', async () => {
      const originalEmail = makeEmail({
        from: { email: 'alice@example.com', name: 'Alice' },
        to: [{ email: 'me@example.com' }, { email: 'bob@example.com' }],
        cc: [{ email: 'carol@example.com' }],
        subject: 'Group discussion',
        headers: { 'message-id': '<group-1@example.com>' },
      });
      (mockProvider.getEmail as ReturnType<typeof vi.fn>).mockResolvedValue(originalEmail);

      await callTool(server, 'email_reply', {
        accountId: 'acct-1',
        emailId: 'group-1',
        body: { text: 'My reply to all' },
        replyAll: true,
      });

      const sendCall = (mockProvider.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0] as SendEmailParams;
      // To should include sender + original to recipients
      expect(sendCall.to).toEqual(
        expect.arrayContaining([
          { email: 'alice@example.com', name: 'Alice' },
          { email: 'me@example.com' },
          { email: 'bob@example.com' },
        ]),
      );
      // CC should include original CC
      expect(sendCall.cc).toEqual([{ email: 'carol@example.com' }]);
    });
  });

  describe('email_forward', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_forward')).toBe(true);
    });

    it('fetches original email and wraps body for new recipients', async () => {
      const originalEmail = makeEmail({
        id: 'fwd-1',
        from: { email: 'alice@example.com', name: 'Alice' },
        subject: 'Original message',
        body: { text: 'Original body text', html: '<p>Original body text</p>' },
        date: '2026-01-15T10:00:00Z',
      });
      (mockProvider.getEmail as ReturnType<typeof vi.fn>).mockResolvedValue(originalEmail);

      const result = await callTool(server, 'email_forward', {
        accountId: 'acct-1',
        emailId: 'fwd-1',
        to: [{ email: 'dave@example.com', name: 'Dave' }],
      });

      expect(mockProvider.getEmail).toHaveBeenCalledWith('fwd-1');

      const sendCall = (mockProvider.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0] as SendEmailParams;
      expect(sendCall.to).toEqual([{ email: 'dave@example.com', name: 'Dave' }]);
      expect(sendCall.subject).toBe('Fwd: Original message');
      // Body should contain forwarded message content
      expect(sendCall.body.text).toContain('Original body text');
      expect(sendCall.body.text).toContain('Forwarded message');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('sent-1');
    });

    it('includes additional body text when provided', async () => {
      const originalEmail = makeEmail({
        body: { text: 'Original text' },
      });
      (mockProvider.getEmail as ReturnType<typeof vi.fn>).mockResolvedValue(originalEmail);

      await callTool(server, 'email_forward', {
        accountId: 'acct-1',
        emailId: 'fwd-2',
        to: [{ email: 'dave@example.com' }],
        body: { text: 'Check this out!' },
      });

      const sendCall = (mockProvider.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0] as SendEmailParams;
      expect(sendCall.body.text).toContain('Check this out!');
      expect(sendCall.body.text).toContain('Original text');
    });

    it('does not duplicate Fwd: prefix', async () => {
      const originalEmail = makeEmail({
        subject: 'Fwd: Already forwarded',
      });
      (mockProvider.getEmail as ReturnType<typeof vi.fn>).mockResolvedValue(originalEmail);

      await callTool(server, 'email_forward', {
        accountId: 'acct-1',
        emailId: 'fwd-3',
        to: [{ email: 'dave@example.com' }],
      });

      const sendCall = (mockProvider.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0][0] as SendEmailParams;
      expect(sendCall.subject).toBe('Fwd: Already forwarded');
    });
  });

  describe('email_draft_create', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_draft_create')).toBe(true);
    });

    it('calls provider.createDraft with correct params', async () => {
      const result = await callTool(server, 'email_draft_create', {
        accountId: 'acct-1',
        to: [{ email: 'bob@example.com' }],
        subject: 'Draft Subject',
        body: { text: 'Draft body' },
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [{ email: 'bob@example.com' }],
          subject: 'Draft Subject',
          body: { text: 'Draft body' },
        }),
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('draft-1');
    });
  });

  describe('email_draft_update', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_draft_update')).toBe(true);
    });

    it('calls provider.updateDraft with correct params', async () => {
      const result = await callTool(server, 'email_draft_update', {
        accountId: 'acct-1',
        draftId: 'draft-1',
        to: [{ email: 'bob@example.com' }],
        subject: 'Updated Draft Subject',
        body: { text: 'Updated draft body' },
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.updateDraft).toHaveBeenCalledWith(
        'draft-1',
        expect.objectContaining({
          to: [{ email: 'bob@example.com' }],
          subject: 'Updated Draft Subject',
          body: { text: 'Updated draft body' },
        }),
        undefined,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('draft-1');
    });

    it('returns error when provider.updateDraft throws (e.g. draft not found)', async () => {
      (mockProvider.updateDraft as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Draft not found'),
      );

      const result = await callTool(server, 'email_draft_update', {
        accountId: 'acct-1',
        draftId: 'nonexistent',
        to: [{ email: 'bob@example.com' }],
        subject: 'Subject',
        body: { text: 'Body' },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Draft not found');
    });
  });

  describe('email_draft_list', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_draft_list')).toBe(true);
    });

    it('calls provider.listDrafts with limit and offset', async () => {
      const drafts = [makeEmail({ flags: { read: false, starred: false, flagged: false, draft: true } })];
      (mockProvider.listDrafts as ReturnType<typeof vi.fn>).mockResolvedValue(drafts);

      const result = await callTool(server, 'email_draft_list', {
        accountId: 'acct-1',
        limit: 10,
        offset: 5,
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.listDrafts).toHaveBeenCalledWith(10, 5);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
    });

    it('uses defaults when limit/offset not provided', async () => {
      (mockProvider.listDrafts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await callTool(server, 'email_draft_list', {
        accountId: 'acct-1',
      });

      expect(mockProvider.listDrafts).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('error handling', () => {
    it('returns error when provider throws', async () => {
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Account not found'),
      );

      const result = await callTool(server, 'email_send', {
        accountId: 'nonexistent',
        to: [{ email: 'bob@example.com' }],
        subject: 'Test',
        body: { text: 'Hello' },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Account not found');
    });
  });
});
