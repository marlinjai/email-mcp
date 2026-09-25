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

  describe('attachments', () => {
    const file = { content: Buffer.from('hello').toString('base64'), filename: 'note.txt' };
    const expected = [{ filename: 'note.txt', content: Buffer.from('hello'), contentType: 'text/plain' }];

    it('email_send passes attachments to the provider', async () => {
      await callTool(server, 'email_send', {
        accountId: 'acct-1', to: [{ email: 'bob@example.com' }], subject: 'S', body: { text: 'B' }, attachments: [file],
      });
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ attachments: expected }));
    });

    it('email_reply passes attachments to the provider', async () => {
      await callTool(server, 'email_reply', { accountId: 'acct-1', emailId: 'msg-1', body: { text: 'B' }, attachments: [file] });
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ attachments: expected }));
    });

    it('email_forward passes attachments to the provider', async () => {
      await callTool(server, 'email_forward', {
        accountId: 'acct-1', emailId: 'msg-1', to: [{ email: 'dave@example.com' }], attachments: [file],
      });
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ attachments: expected }));
    });

    it('email_draft_create passes attachments to the provider', async () => {
      await callTool(server, 'email_draft_create', {
        accountId: 'acct-1', to: [{ email: 'bob@example.com' }], subject: 'S', body: { text: 'B' }, attachments: [file],
      });
      expect(mockProvider.createDraft).toHaveBeenCalledWith(expect.objectContaining({ attachments: expected }));
    });

    it('email_draft_update passes attachments to the provider', async () => {
      await callTool(server, 'email_draft_update', {
        accountId: 'acct-1', draftId: 'draft-1', to: [{ email: 'bob@example.com' }], subject: 'S', body: { text: 'B' }, attachments: [file],
      });
      expect(mockProvider.updateDraft).toHaveBeenCalledWith(
        'draft-1', expect.objectContaining({ attachments: expected }), undefined,
      );
    });

    it('returns an error instead of sending when an attachment is invalid', async () => {
      const result = await callTool(server, 'email_send', {
        accountId: 'acct-1', to: [{ email: 'bob@example.com' }], subject: 'S', body: { text: 'B' },
        attachments: [{ content: 'AA==' }],
      });
      expect(JSON.parse(result.content[0].text).error).toMatch(/requires a filename/);
      expect(mockProvider.sendEmail).not.toHaveBeenCalled();
    });

    it('refuses a file path on every sending tool while no attachments folder is set', async () => {
      const saved = process.env.EMAIL_MCP_ATTACHMENTS_DIR;
      delete process.env.EMAIL_MCP_ATTACHMENTS_DIR;
      try {
        const byPath = [{ path: '/etc/hosts' }];
        const calls: Array<[string, Record<string, unknown>]> = [
          ['email_send', { accountId: 'acct-1', to: [{ email: 'bob@example.com' }], subject: 'S', body: { text: 'B' }, attachments: byPath }],
          ['email_reply', { accountId: 'acct-1', emailId: 'msg-1', body: { text: 'B' }, attachments: byPath }],
          ['email_forward', { accountId: 'acct-1', emailId: 'msg-1', to: [{ email: 'dave@example.com' }], attachments: byPath }],
          ['email_draft_create', { accountId: 'acct-1', to: [{ email: 'bob@example.com' }], subject: 'S', body: { text: 'B' }, attachments: byPath }],
          ['email_draft_update', { accountId: 'acct-1', draftId: 'draft-1', to: [{ email: 'bob@example.com' }], subject: 'S', body: { text: 'B' }, attachments: byPath }],
        ];
        for (const [tool, args] of calls) {
          const result = await callTool(server, tool, args);
          expect(JSON.parse(result.content[0].text).error, tool).toMatch(/switched off: EMAIL_MCP_ATTACHMENTS_DIR is not set/);
        }
        expect(mockProvider.sendEmail).not.toHaveBeenCalled();
        expect(mockProvider.createDraft).not.toHaveBeenCalled();
        expect(mockProvider.updateDraft).not.toHaveBeenCalled();
      } finally {
        if (saved !== undefined) process.env.EMAIL_MCP_ATTACHMENTS_DIR = saved;
      }
    });

    it('email_draft_update passes an empty list through, so the draft loses its files', async () => {
      await callTool(server, 'email_draft_update', {
        accountId: 'acct-1', draftId: 'draft-1', to: [{ email: 'bob@example.com' }], subject: 'S', body: { text: 'B' }, attachments: [],
      });
      expect(mockProvider.updateDraft).toHaveBeenCalledWith('draft-1', expect.objectContaining({ attachments: [] }), undefined);
    });
  });

  describe('reply recipients and threading', () => {
    const original = {
      id: 'graph-msg-1',
      threadId: 'gmail-thread-1',
      from: { email: 'me@example.com', name: 'Me' },
      to: [{ email: 'client@example.com', name: 'Client' }],
      cc: [{ email: 'carol@example.com' }],
    };

    beforeEach(() => {
      (mockProvider.getEmail as any).mockResolvedValue(makeEmail(original));
    });

    it('email_reply passes threadId and the provider item id for threading', async () => {
      await callTool(server, 'email_reply', { accountId: 'acct-1', emailId: 'graph-msg-1', body: { text: 'B' } });
      expect(mockProvider.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'gmail-thread-1', replyToGraphId: 'graph-msg-1', inReplyTo: '<msg-1@example.com>' }),
      );
    });

    it('email_reply `to` replaces the default recipient (a reply to your own sent mail)', async () => {
      await callTool(server, 'email_reply', {
        accountId: 'acct-1', emailId: 'graph-msg-1', body: { text: 'B' }, to: [{ email: 'client@example.com' }],
      });
      expect((mockProvider.sendEmail as any).mock.calls[0][0].to).toEqual([{ email: 'client@example.com' }]);
    });

    it('email_reply additionalRecipients are appended without duplicates', async () => {
      await callTool(server, 'email_reply', {
        accountId: 'acct-1', emailId: 'graph-msg-1', body: { text: 'B' },
        additionalRecipients: [{ email: 'ME@example.com' }, { email: 'dave@example.com' }],
      });
      expect((mockProvider.sendEmail as any).mock.calls[0][0].to.map((c: any) => c.email)).toEqual([
        'me@example.com', 'dave@example.com',
      ]);
    });

    it('email_reply cc overrides the cc carried over by replyAll, and bcc is passed', async () => {
      await callTool(server, 'email_reply', {
        accountId: 'acct-1', emailId: 'graph-msg-1', body: { text: 'B' }, replyAll: true,
        cc: [{ email: 'erin@example.com' }], bcc: [{ email: 'frank@example.com' }],
      });
      const params = (mockProvider.sendEmail as any).mock.calls[0][0];
      expect(params.cc).toEqual([{ email: 'erin@example.com' }]);
      expect(params.bcc).toEqual([{ email: 'frank@example.com' }]);
    });

    it('email_draft_create with inReplyToEmailId creates a threaded reply draft', async () => {
      await callTool(server, 'email_draft_create', {
        accountId: 'acct-1', to: [{ email: 'client@example.com' }], subject: 'Re: Hello', body: { text: 'B' },
        inReplyToEmailId: 'graph-msg-1',
      });
      expect(mockProvider.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: '<msg-1@example.com>', references: ['<msg-1@example.com>'],
          threadId: 'gmail-thread-1', replyToGraphId: 'graph-msg-1',
        }),
      );
    });

    it('email_draft_create without inReplyToEmailId stays a standalone draft', async () => {
      await callTool(server, 'email_draft_create', {
        accountId: 'acct-1', to: [{ email: 'client@example.com' }], subject: 'New', body: { text: 'B' },
      });
      const params = (mockProvider.createDraft as any).mock.calls[0][0];
      expect(params.inReplyTo).toBeUndefined();
      expect(params.replyToGraphId).toBeUndefined();
      expect(mockProvider.getEmail).not.toHaveBeenCalled();
    });
  });

  describe('forward keeps the original attachments', () => {
    beforeEach(() => {
      (mockProvider.getEmail as any).mockResolvedValue(
        makeEmail({ attachments: [{ id: 'att-1', filename: 'spec.pdf', contentType: 'application/pdf', size: 3 }] as any }),
      );
      (mockProvider.getAttachment as any).mockResolvedValue({ data: Buffer.from('pdf'), meta: {} });
    });

    it('includes them by default, ahead of added files', async () => {
      await callTool(server, 'email_forward', {
        accountId: 'acct-1', emailId: 'msg-1', to: [{ email: 'dave@example.com' }],
        cc: [{ email: 'erin@example.com' }],
        attachments: [{ content: Buffer.from('x').toString('base64'), filename: 'note.txt' }],
      });
      const params = (mockProvider.sendEmail as any).mock.calls[0][0];
      expect(params.attachments.map((a: any) => a.filename)).toEqual(['spec.pdf', 'note.txt']);
      expect(params.cc).toEqual([{ email: 'erin@example.com' }]);
      expect(mockProvider.getAttachment).toHaveBeenCalledWith('msg-1', 'att-1');
    });

    it('can leave them out', async () => {
      await callTool(server, 'email_forward', {
        accountId: 'acct-1', emailId: 'msg-1', to: [{ email: 'dave@example.com' }], includeOriginalAttachments: false,
      });
      expect((mockProvider.sendEmail as any).mock.calls[0][0].attachments).toBeUndefined();
      expect(mockProvider.getAttachment).not.toHaveBeenCalled();
    });
  });
});
