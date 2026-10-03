import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutlookAdapter } from '../../src/providers/outlook/adapter.js';
import { ProviderType } from '../../src/models/types.js';

// Build a chainable mock for Microsoft Graph client
function createMockGraphRequest(resolvedValue: unknown = {}) {
  const request: Record<string, unknown> = {};
  const methods = ['select', 'filter', 'search', 'top', 'skip', 'orderby', 'expand', 'header', 'count'];
  for (const method of methods) {
    request[method] = vi.fn().mockReturnValue(request);
  }
  request.get = vi.fn().mockResolvedValue(resolvedValue);
  request.post = vi.fn().mockResolvedValue(resolvedValue);
  request.patch = vi.fn().mockResolvedValue(resolvedValue);
  request.delete = vi.fn().mockResolvedValue(undefined);
  return request;
}

let mockApiRequests: Map<string, ReturnType<typeof createMockGraphRequest>>;
let defaultMockRequest: ReturnType<typeof createMockGraphRequest>;

const mockClientInit = vi.fn();

vi.mock('@microsoft/microsoft-graph-client', () => {
  return {
    Client: {
      init: vi.fn().mockImplementation((options: unknown) => {
        mockClientInit(options);
        return {
          api: vi.fn().mockImplementation((path: string) => {
            return mockApiRequests.get(path) ?? defaultMockRequest;
          }),
        };
      }),
    },
  };
});

describe('OutlookAdapter', () => {
  let adapter: OutlookAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiRequests = new Map();
    defaultMockRequest = createMockGraphRequest();
    adapter = new OutlookAdapter();
  });

  it('has correct provider type', () => {
    expect(adapter.providerType).toBe(ProviderType.Outlook);
  });

  describe('connect', () => {
    it('initializes Graph client with bearer token auth', async () => {
      await adapter.connect({
        id: 'outlook-1',
        name: 'Test Outlook',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: {
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expiry: '2026-12-31T00:00:00Z',
        },
      });

      expect(mockClientInit).toHaveBeenCalledWith(
        expect.objectContaining({
          authProvider: expect.any(Function),
        })
      );

      // Verify the auth provider callback provides the token
      const initCall = mockClientInit.mock.calls[0][0];
      const done = vi.fn();
      await initCall.authProvider(done);
      expect(done).toHaveBeenCalledWith(null, 'test-access-token');
    });

    it('throws if no OAuth credentials provided', async () => {
      await expect(
        adapter.connect({
          id: 'outlook-1',
          name: 'Test Outlook',
          provider: 'outlook',
          email: 'test@outlook.com',
        })
      ).rejects.toThrow('Outlook adapter requires OAuth credentials');
    });
  });

  describe('listFolders', () => {
    it('fetches mail folders and maps wellKnownName to folder type', async () => {
      const mockFoldersRequest = createMockGraphRequest({
        value: [
          { id: 'f1', displayName: 'Inbox', wellKnownName: 'inbox', totalItemCount: 120, unreadItemCount: 5 },
          { id: 'f2', displayName: 'Sent Items', wellKnownName: 'sentitems', totalItemCount: 300, unreadItemCount: 0 },
          { id: 'f3', displayName: 'Drafts', wellKnownName: 'drafts', totalItemCount: 3, unreadItemCount: 0 },
          { id: 'f4', displayName: 'Deleted Items', wellKnownName: 'deleteditems', totalItemCount: 15, unreadItemCount: 2 },
          { id: 'f5', displayName: 'Junk Email', wellKnownName: 'junkemail', totalItemCount: 42, unreadItemCount: 42 },
          { id: 'f6', displayName: 'Archive', wellKnownName: 'archive', totalItemCount: 1000, unreadItemCount: 0 },
          { id: 'f7', displayName: 'Custom Folder', wellKnownName: null, totalItemCount: 10, unreadItemCount: 1 },
        ],
      });
      mockApiRequests.set('/me/mailFolders', mockFoldersRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const folders = await adapter.listFolders();

      expect(folders).toHaveLength(7);

      const inbox = folders.find((f) => f.id === 'f1');
      expect(inbox?.type).toBe('inbox');
      expect(inbox?.totalCount).toBe(120);
      expect(inbox?.unreadCount).toBe(5);

      const sent = folders.find((f) => f.id === 'f2');
      expect(sent?.type).toBe('sent');

      const drafts = folders.find((f) => f.id === 'f3');
      expect(drafts?.type).toBe('drafts');

      const trash = folders.find((f) => f.id === 'f4');
      expect(trash?.type).toBe('trash');

      const spam = folders.find((f) => f.id === 'f5');
      expect(spam?.type).toBe('spam');

      const archive = folders.find((f) => f.id === 'f6');
      expect(archive?.type).toBe('archive');

      const custom = folders.find((f) => f.id === 'f7');
      expect(custom?.type).toBe('other');
    });
  });

  describe('search', () => {
    it('builds OData filter from SearchQuery', async () => {
      const mockMessagesRequest = createMockGraphRequest({ value: [] });
      mockApiRequests.set('/me/messages', mockMessagesRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.search({
        from: 'alice@test.com',
        unreadOnly: true,
        since: '2026-01-01',
        limit: 10,
        offset: 5,
      });

      expect(mockMessagesRequest.filter).toHaveBeenCalled();
      const filterCall = (mockMessagesRequest.filter as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(filterCall).toContain('isRead eq false');
      expect(filterCall).toContain("from/emailAddress/address eq 'alice@test.com'");
      expect(filterCall).toContain('receivedDateTime ge 2026-01-01');
      expect(mockMessagesRequest.top).toHaveBeenCalledWith(10);
      expect(mockMessagesRequest.skip).toHaveBeenCalledWith(5);
    });

    it('searches by folder when specified', async () => {
      const mockFolderMessagesRequest = createMockGraphRequest({ value: [] });
      mockApiRequests.set('/me/mailFolders/folder-id-123/messages', mockFolderMessagesRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.search({ folder: 'folder-id-123' });

      expect(mockFolderMessagesRequest.get).toHaveBeenCalled();
    });

    it('uses $search for subject and body queries', async () => {
      const mockMessagesRequest = createMockGraphRequest({ value: [] });
      mockApiRequests.set('/me/messages', mockMessagesRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.search({ subject: 'test subject', body: 'important content' });

      expect(mockMessagesRequest.search).toHaveBeenCalled();
      const searchCall = (mockMessagesRequest.search as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(searchCall).toContain('subject:test subject');
      expect(searchCall).toContain('body:important content');
    });

    it('maps Graph messages to Email type', async () => {
      const mockMessagesRequest = createMockGraphRequest({
        value: [
          {
            id: 'msg-1',
            conversationId: 'conv-1',
            parentFolderId: 'f1',
            from: { emailAddress: { name: 'Alice', address: 'alice@test.com' } },
            toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@test.com' } }],
            ccRecipients: [],
            bccRecipients: [],
            subject: 'Hello',
            receivedDateTime: '2026-02-15T10:00:00Z',
            body: { contentType: 'text', content: 'Hello world' },
            bodyPreview: 'Hello world',
            hasAttachments: false,
            isRead: true,
            flag: { flagStatus: 'notFlagged' },
            isDraft: false,
            importance: 'normal',
            categories: ['Blue category'],
          },
        ],
      });
      mockApiRequests.set('/me/messages', mockMessagesRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const results = await adapter.search({});

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('msg-1');
      expect(results[0].threadId).toBe('conv-1');
      expect(results[0].from.email).toBe('alice@test.com');
      expect(results[0].from.name).toBe('Alice');
      expect(results[0].to[0].email).toBe('bob@test.com');
      expect(results[0].subject).toBe('Hello');
      expect(results[0].flags.read).toBe(true);
      expect(results[0].flags.draft).toBe(false);
      expect(results[0].categories).toEqual(['Blue category']);
    });
  });

  describe('getEmail', () => {
    it('fetches a single message by id', async () => {
      const mockMessageRequest = createMockGraphRequest({
        id: 'msg-123',
        conversationId: 'conv-1',
        parentFolderId: 'f1',
        from: { emailAddress: { name: 'Alice', address: 'alice@test.com' } },
        toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@test.com' } }],
        ccRecipients: [{ emailAddress: { name: 'Carol', address: 'carol@test.com' } }],
        bccRecipients: [],
        subject: 'Test Email',
        receivedDateTime: '2026-02-15T12:00:00Z',
        body: { contentType: 'html', content: '<p>Hello</p>' },
        bodyPreview: 'Hello',
        hasAttachments: true,
        isRead: false,
        flag: { flagStatus: 'flagged' },
        isDraft: false,
        importance: 'high',
        categories: [],
      });
      mockApiRequests.set('/me/messages/msg-123', mockMessageRequest);

      // Mock attachment list
      const mockAttachmentsRequest = createMockGraphRequest({
        value: [
          {
            id: 'att-1',
            name: 'file.pdf',
            contentType: 'application/pdf',
            size: 1024,
          },
        ],
      });
      mockApiRequests.set('/me/messages/msg-123/attachments', mockAttachmentsRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const email = await adapter.getEmail('msg-123');

      expect(email.id).toBe('msg-123');
      expect(email.subject).toBe('Test Email');
      expect(email.from.email).toBe('alice@test.com');
      expect(email.cc).toHaveLength(1);
      expect(email.cc![0].email).toBe('carol@test.com');
      expect(email.flags.read).toBe(false);
      expect(email.flags.flagged).toBe(true);
      expect(email.body.html).toBe('<p>Hello</p>');
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0].filename).toBe('file.pdf');
    });
  });

  describe('getThread', () => {
    it('fetches messages by conversationId', async () => {
      const mockThreadRequest = createMockGraphRequest({
        value: [
          {
            id: 'msg-1',
            conversationId: 'conv-abc',
            parentFolderId: 'f1',
            from: { emailAddress: { name: 'Alice', address: 'alice@test.com' } },
            toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@test.com' } }],
            ccRecipients: [],
            bccRecipients: [],
            subject: 'Thread Subject',
            receivedDateTime: '2026-02-15T10:00:00Z',
            body: { contentType: 'text', content: 'First message' },
            bodyPreview: 'First message',
            hasAttachments: false,
            isRead: true,
            flag: { flagStatus: 'notFlagged' },
            isDraft: false,
            importance: 'normal',
            categories: [],
          },
          {
            id: 'msg-2',
            conversationId: 'conv-abc',
            parentFolderId: 'f1',
            from: { emailAddress: { name: 'Bob', address: 'bob@test.com' } },
            toRecipients: [{ emailAddress: { name: 'Alice', address: 'alice@test.com' } }],
            ccRecipients: [],
            bccRecipients: [],
            subject: 'Re: Thread Subject',
            receivedDateTime: '2026-02-15T11:00:00Z',
            body: { contentType: 'text', content: 'Reply' },
            bodyPreview: 'Reply',
            hasAttachments: false,
            isRead: true,
            flag: { flagStatus: 'notFlagged' },
            isDraft: false,
            importance: 'normal',
            categories: [],
          },
        ],
      });
      mockApiRequests.set('/me/messages', mockThreadRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const thread = await adapter.getThread('conv-abc');

      expect(thread.id).toBe('conv-abc');
      expect(thread.messageCount).toBe(2);
      expect(thread.messages).toHaveLength(2);
      expect(thread.subject).toBe('Thread Subject');
      expect(thread.participants).toHaveLength(2);
      expect(thread.lastMessageDate).toBe('2026-02-15T11:00:00Z');

      // Verify filter was called with conversation ID
      expect(mockThreadRequest.filter).toHaveBeenCalledWith("conversationId eq 'conv-abc'");
    });
  });

  describe('testConnection', () => {
    it('returns success with folder count', async () => {
      const mockFoldersRequest = createMockGraphRequest({
        value: [
          { id: 'f1', displayName: 'Inbox', wellKnownName: 'inbox', totalItemCount: 10, unreadItemCount: 1 },
          { id: 'f2', displayName: 'Sent', wellKnownName: 'sentitems', totalItemCount: 5, unreadItemCount: 0 },
        ],
      });
      mockApiRequests.set('/me/mailFolders', mockFoldersRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const result = await adapter.testConnection();
      expect(result.success).toBe(true);
      expect(result.folderCount).toBe(2);
    });
  });

  describe('disconnect', () => {
    it('clears the client reference', async () => {
      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.disconnect();

      // After disconnect, operations should throw
      await expect(adapter.listFolders()).rejects.toThrow('Not connected');
    });
  });

  describe('sendEmail', () => {
    it('replies in-thread through createReply, then sends the draft', async () => {
      const createReply = createMockGraphRequest({ id: 'reply-draft-1' });
      mockApiRequests.set('/me/messages/orig-1/createReply', createReply);
      const patchReq = createMockGraphRequest({});
      mockApiRequests.set('/me/messages/reply-draft-1', patchReq);
      const sendReq = createMockGraphRequest({});
      mockApiRequests.set('/me/messages/reply-draft-1/send', sendReq);
      const sendMail = createMockGraphRequest();
      mockApiRequests.set('/me/sendMail', sendMail);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const result = await adapter.sendEmail({
        to: [{ email: 'client@test.com' }], subject: 'Re: x', body: { text: 'Thanks' },
        inReplyTo: '<m@x>', replyToGraphId: 'orig-1',
      });

      expect(createReply.post).toHaveBeenCalled();
      // Exactly these fields: the caller's subject once (Graph pre-fills its
      // own "RE: ..."), and no cc/bcc keys, so Graph's defaults stay.
      expect(patchReq.patch).toHaveBeenCalledWith({
        subject: 'Re: x',
        body: { contentType: 'text', content: 'Thanks' },
        toRecipients: [{ emailAddress: { name: undefined, address: 'client@test.com' } }],
      });
      expect(sendReq.post).toHaveBeenCalled();
      expect(sendMail.post).not.toHaveBeenCalled();
      expect(patchReq.delete).not.toHaveBeenCalled();
      expect(result.id).toBe('reply-draft-1');
    });

    describe('reply through createReply', () => {
      const account = {
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook' as const,
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      };
      const reply = { to: [{ email: 'client@test.com' }], subject: 'Re: x', body: { text: 'Thanks' }, replyToGraphId: 'orig-1' };
      const file = { filename: 'a.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' };

      function setUp() {
        const createReply = createMockGraphRequest({ id: 'reply-draft-1' });
        mockApiRequests.set('/me/messages/orig-1/createReply', createReply);
        // PATCH and DELETE of the draft go to the same path.
        const draftReq = createMockGraphRequest({});
        mockApiRequests.set('/me/messages/reply-draft-1', draftReq);
        const attachReq = createMockGraphRequest({});
        mockApiRequests.set('/me/messages/reply-draft-1/attachments', attachReq);
        const sendReq = createMockGraphRequest({});
        mockApiRequests.set('/me/messages/reply-draft-1/send', sendReq);
        return { createReply, draftReq, attachReq, sendReq };
      }

      beforeEach(async () => {
        await adapter.connect(account);
      });

      it('an explicit empty cc and bcc clear what Graph pre-filled', async () => {
        const { draftReq } = setUp();
        await adapter.sendEmail({ ...reply, cc: [], bcc: [] });
        expect(draftReq.patch).toHaveBeenCalledWith(expect.objectContaining({ ccRecipients: [], bccRecipients: [] }));
      });

      it('given cc and bcc replace what Graph pre-filled', async () => {
        const { draftReq } = setUp();
        await adapter.sendEmail({ ...reply, cc: [{ email: 'carol@test.com' }], bcc: [{ name: 'Dave', email: 'dave@test.com' }] });
        expect(draftReq.patch).toHaveBeenCalledWith(expect.objectContaining({
          ccRecipients: [{ emailAddress: { name: undefined, address: 'carol@test.com' } }],
          bccRecipients: [{ emailAddress: { name: 'Dave', address: 'dave@test.com' } }],
        }));
      });

      it('an empty to keeps the recipient Graph pre-filled', async () => {
        const { draftReq, sendReq } = setUp();
        await adapter.sendEmail({ ...reply, to: [] });
        expect((draftReq.patch as any).mock.calls[0][0]).not.toHaveProperty('toRecipients');
        expect(sendReq.post).toHaveBeenCalled();
      });

      it('uploads each attachment to the draft before sending', async () => {
        const { attachReq, sendReq } = setUp();
        await adapter.sendEmail({ ...reply, attachments: [file, { ...file, filename: 'b.pdf' }] });
        expect((attachReq.post as any).mock.calls.map((c: any[]) => c[0].name)).toEqual(['a.pdf', 'b.pdf']);
        expect((attachReq.post as any).mock.invocationCallOrder[1]).toBeLessThan((sendReq.post as any).mock.invocationCallOrder[0]);
      });

      it('accepts files that are each under 3 MB even when they total more', async () => {
        const { attachReq, sendReq } = setUp();
        const twoMb = { ...file, content: Buffer.alloc(2 * 1024 * 1024) };
        await adapter.sendEmail({ ...reply, attachments: [twoMb, { ...twoMb, filename: 'b.pdf' }] });
        expect(attachReq.post).toHaveBeenCalledTimes(2);
        expect(sendReq.post).toHaveBeenCalled();
      });

      it('refuses a file over 3 MB before any reply draft is created, on send and on draft create', async () => {
        const { createReply } = setUp();
        const big = { ...reply, attachments: [{ ...file, filename: 'big.zip', content: Buffer.alloc(3 * 1024 * 1024 + 1) }] };
        await expect(adapter.sendEmail(big)).rejects.toThrow(/Outlook accepts attachments up to 3\.0 MB.*big\.zip/);
        await expect(adapter.createDraft(big)).rejects.toThrow(/Outlook accepts attachments up to 3\.0 MB.*big\.zip/);
        expect(createReply.post).not.toHaveBeenCalled();
      });

      it('creates nothing to clean up when createReply itself fails', async () => {
        const { createReply, draftReq } = setUp();
        createReply.post = vi.fn().mockRejectedValue(new Error('original not found'));
        await expect(adapter.sendEmail(reply)).rejects.toThrow('original not found');
        expect(draftReq.delete).not.toHaveBeenCalled();
      });

      it('deletes the draft and rethrows when the PATCH fails', async () => {
        const { draftReq, sendReq } = setUp();
        const failure = new Error('patch failed');
        draftReq.patch = vi.fn().mockRejectedValue(failure);
        await expect(adapter.sendEmail(reply)).rejects.toBe(failure);
        expect(draftReq.delete).toHaveBeenCalledTimes(1);
        expect(sendReq.post).not.toHaveBeenCalled();
      });

      it('deletes the draft and rethrows when an attachment upload fails', async () => {
        const { draftReq, attachReq, sendReq } = setUp();
        const failure = new Error('upload failed');
        attachReq.post = vi.fn().mockRejectedValue(failure);
        await expect(adapter.sendEmail({ ...reply, attachments: [file] })).rejects.toBe(failure);
        expect(draftReq.delete).toHaveBeenCalledTimes(1);
        expect(sendReq.post).not.toHaveBeenCalled();
      });

      it('keeps the draft when the send fails, and says where it is: the mail may be on its way', async () => {
        const { draftReq, sendReq } = setUp();
        const failure = new Error('gateway timeout');
        sendReq.post = vi.fn().mockRejectedValue(failure);
        const error: any = await adapter.sendEmail(reply).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(
          'gateway timeout (the reply was saved as draft reply-draft-1 in Drafts and was not confirmed as sent; check Sent Items before sending it again)',
        );
        expect(error.cause).toBe(failure);
        expect(draftReq.patch).toHaveBeenCalledTimes(1);
        expect(draftReq.delete).not.toHaveBeenCalled();
      });

      it('keeps the draft with its attachments when the send fails after the uploads', async () => {
        const { draftReq, attachReq, sendReq } = setUp();
        sendReq.post = vi.fn().mockRejectedValue(new Error('503'));
        await expect(adapter.sendEmail({ ...reply, attachments: [file] })).rejects.toThrow(/saved as draft reply-draft-1 in Drafts/);
        expect(attachReq.post).toHaveBeenCalledTimes(1);
        expect(draftReq.delete).not.toHaveBeenCalled();
      });

      it('says that the draft was left in Drafts when a fill fails and deleting it fails too', async () => {
        const { draftReq } = setUp();
        const failure = new Error('patch failed');
        draftReq.patch = vi.fn().mockRejectedValue(failure);
        draftReq.delete = vi.fn().mockRejectedValue(new Error('delete failed'));
        const error: any = await adapter.sendEmail(reply).catch((e) => e);
        expect(error.message).toMatch(/^patch failed \(the reply draft reply-draft-1 could not be removed and was left in Drafts: delete failed\)$/);
        expect(error.cause).toBe(failure);
      });

      it('createDraft deletes the half-built reply draft when filling it fails', async () => {
        const { draftReq, attachReq, sendReq } = setUp();
        const failure = new Error('upload failed');
        attachReq.post = vi.fn().mockRejectedValue(failure);
        await expect(adapter.createDraft({ ...reply, attachments: [file] })).rejects.toBe(failure);
        expect(draftReq.delete).toHaveBeenCalledTimes(1);
        expect(sendReq.post).not.toHaveBeenCalled();
      });

      it('createDraft keeps the finished reply draft', async () => {
        const { draftReq, sendReq } = setUp();
        expect(await adapter.createDraft(reply)).toEqual({ id: 'reply-draft-1' });
        expect(draftReq.patch).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Re: x' }));
        expect(draftReq.delete).not.toHaveBeenCalled();
        expect(sendReq.post).not.toHaveBeenCalled();
      });
    });

    it('calls POST /me/sendMail with correct payload', async () => {
      const mockSendRequest = createMockGraphRequest();
      mockApiRequests.set('/me/sendMail', mockSendRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const result = await adapter.sendEmail({
        to: [{ name: 'Bob', email: 'bob@test.com' }],
        cc: [{ email: 'carol@test.com' }],
        subject: 'Test Subject',
        body: { html: '<p>Hello</p>' },
      });

      expect(mockSendRequest.post).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            subject: 'Test Subject',
            body: { contentType: 'html', content: '<p>Hello</p>' },
            toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@test.com' } }],
            ccRecipients: [{ emailAddress: { name: undefined, address: 'carol@test.com' } }],
          }),
        })
      );

      expect(result).toHaveProperty('id');
    });

    it('sends plain text body when no html provided', async () => {
      const mockSendRequest = createMockGraphRequest();
      mockApiRequests.set('/me/sendMail', mockSendRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.sendEmail({
        to: [{ email: 'bob@test.com' }],
        subject: 'Plain',
        body: { text: 'Plain text content' },
      });

      expect(mockSendRequest.post).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            body: { contentType: 'text', content: 'Plain text content' },
          }),
        })
      );
    });

    it('sends the html part when both text and html are given (Graph holds one body)', async () => {
      const mockSendRequest = createMockGraphRequest();
      mockApiRequests.set('/me/sendMail', mockSendRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.sendEmail({
        to: [{ name: 'Müller, Hans', email: 'hans@test.com' }],
        subject: 'Both',
        body: { text: 'Plain part', html: '<p>HTML part</p>' },
      });

      expect(mockSendRequest.post).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            body: { contentType: 'html', content: '<p>HTML part</p>' },
            toRecipients: [{ emailAddress: { name: 'Müller, Hans', address: 'hans@test.com' } }],
          }),
        })
      );
    });
  });

  describe('createDraft', () => {
    it('creates a threaded reply draft through createReply and does not send it', async () => {
      const createReply = createMockGraphRequest({ id: 'reply-draft-2' });
      mockApiRequests.set('/me/messages/orig-2/createReply', createReply);
      mockApiRequests.set('/me/messages/reply-draft-2', createMockGraphRequest({}));
      const sendReq = createMockGraphRequest({});
      mockApiRequests.set('/me/messages/reply-draft-2/send', sendReq);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const result = await adapter.createDraft({
        to: [{ email: 'client@test.com' }], subject: 'Re: x', body: { text: 'Draft' }, replyToGraphId: 'orig-2',
      });

      expect(createReply.post).toHaveBeenCalled();
      expect(sendReq.post).not.toHaveBeenCalled();
      expect(result.id).toBe('reply-draft-2');
    });

    it('calls POST /me/messages to create a draft', async () => {
      const mockDraftRequest = createMockGraphRequest({ id: 'draft-123' });
      mockApiRequests.set('/me/messages', mockDraftRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const result = await adapter.createDraft({
        to: [{ email: 'bob@test.com' }],
        subject: 'Draft Subject',
        body: { text: 'Draft body' },
      });

      expect(result.id).toBe('draft-123');
      expect(mockDraftRequest.post).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Draft Subject',
          toRecipients: [{ emailAddress: { name: undefined, address: 'bob@test.com' } }],
        }),
      );
    });

    it('includes attachments on the new draft', async () => {
      const mockDraftRequest = createMockGraphRequest({ id: 'draft-att' });
      mockApiRequests.set('/me/messages', mockDraftRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.createDraft({
        to: [{ email: 'bob@test.com' }],
        subject: 'With file',
        body: { text: 'Attached' },
        attachments: [{ filename: 'a.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }],
      });

      expect(mockDraftRequest.post).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'a.pdf',
              contentType: 'application/pdf',
              contentBytes: Buffer.from('pdf').toString('base64'),
            },
          ],
        }),
      );
    });

    it('refuses a message whose base64-encoded request body passes 4 MB, on a draft and on send', async () => {
      const draftRequest = createMockGraphRequest({ id: 'draft-att' });
      mockApiRequests.set('/me/messages', draftRequest);
      const sendRequest = createMockGraphRequest({});
      mockApiRequests.set('/me/sendMail', sendRequest);
      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });
      const twoMb = Buffer.alloc(2 * 1024 * 1024); // 2 x 2 MB is about 5.3 MB once base64-encoded
      const message = {
        to: [{ email: 'bob@test.com' }],
        subject: 'Two files',
        body: { text: 'Attached' },
        attachments: [
          { filename: 'a.bin', content: twoMb, contentType: 'application/octet-stream' },
          { filename: 'b.bin', content: twoMb, contentType: 'application/octet-stream' },
        ],
      };

      await expect(adapter.createDraft(message)).rejects.toThrow(/requests up to 4\.0 MB.*base64-encoded/);
      await expect(adapter.sendEmail(message)).rejects.toThrow(/requests up to 4\.0 MB/);
      expect(draftRequest.post).not.toHaveBeenCalled();
      expect(sendRequest.post).not.toHaveBeenCalled();
    });
  });

  describe('updateDraft', () => {
    it('calls PATCH /me/messages/{id} to update the draft in place', async () => {
      const mockPatchRequest = createMockGraphRequest({});
      mockApiRequests.set('/me/messages/draft-123', mockPatchRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const result = await adapter.updateDraft('draft-123', {
        to: [{ email: 'bob@test.com' }],
        subject: 'Updated Subject',
        body: { text: 'Updated body' },
      });

      expect(result.id).toBe('draft-123');
      expect(mockPatchRequest.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Updated Subject',
          toRecipients: [{ emailAddress: { name: undefined, address: 'bob@test.com' } }],
        }),
      );
    });

    it('needs no thread data: one PATCH of the message fields keeps a reply draft in its conversation', async () => {
      const patchRequest = createMockGraphRequest({});
      mockApiRequests.set('/me/messages/reply-draft-1', patchRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const result = await adapter.updateDraft('reply-draft-1', {
        to: [{ email: 'client@test.com' }],
        subject: 'Re: x',
        body: { text: 'Second version' },
      });

      expect(result.id).toBe('reply-draft-1');
      expect(patchRequest.patch).toHaveBeenCalledTimes(1);
      expect(patchRequest.patch).toHaveBeenCalledWith({
        subject: 'Re: x',
        body: { contentType: 'text', content: 'Second version' },
        toRecipients: [{ emailAddress: { name: undefined, address: 'client@test.com' } }],
      });
      // No other request: nothing is read back, recreated or deleted.
      expect(patchRequest.get).not.toHaveBeenCalled();
      expect(patchRequest.delete).not.toHaveBeenCalled();
      expect(defaultMockRequest.get).not.toHaveBeenCalled();
      expect(defaultMockRequest.post).not.toHaveBeenCalled();
    });

    it('replaces existing attachments when new ones are given', async () => {
      mockApiRequests.set('/me/messages/draft-123', createMockGraphRequest({}));
      const listRequest = createMockGraphRequest({ value: [{ id: 'old-1' }] });
      mockApiRequests.set('/me/messages/draft-123/attachments', listRequest);
      const deleteRequest = createMockGraphRequest();
      mockApiRequests.set('/me/messages/draft-123/attachments/old-1', deleteRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.updateDraft('draft-123', {
        to: [{ email: 'bob@test.com' }],
        subject: 'Updated Subject',
        body: { text: 'Updated body' },
        attachments: [{ filename: 'new.pdf', content: Buffer.from('new'), contentType: 'application/pdf' }],
      });

      expect(deleteRequest.delete).toHaveBeenCalled();
      expect(listRequest.post).toHaveBeenCalledWith(expect.objectContaining({ name: 'new.pdf' }));
      // New files go up before the old ones are removed.
      expect((listRequest.post as any).mock.invocationCallOrder[0]).toBeLessThan(
        (deleteRequest.delete as any).mock.invocationCallOrder[0],
      );
    });

    const outlookAccount = {
      id: 'outlook-1',
      name: 'Test',
      provider: 'outlook' as const,
      email: 'test@outlook.com',
      oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
    };
    const draft = { to: [{ email: 'bob@test.com' }], subject: 'Updated Subject', body: { text: 'Updated body' } };

    it('keeps the old files when uploading a new one fails', async () => {
      mockApiRequests.set('/me/messages/draft-123', createMockGraphRequest({}));
      const listRequest = createMockGraphRequest({ value: [{ id: 'old-1' }] });
      listRequest.post = vi.fn().mockRejectedValue(new Error('upload failed'));
      mockApiRequests.set('/me/messages/draft-123/attachments', listRequest);
      const deleteRequest = createMockGraphRequest();
      mockApiRequests.set('/me/messages/draft-123/attachments/old-1', deleteRequest);
      await adapter.connect(outlookAccount);

      await expect(
        adapter.updateDraft('draft-123', {
          ...draft,
          attachments: [{ filename: 'new.pdf', content: Buffer.from('new'), contentType: 'application/pdf' }],
        }),
      ).rejects.toThrow('upload failed');
      expect(deleteRequest.delete).not.toHaveBeenCalled();
    });

    it('removes every file when given an empty list', async () => {
      mockApiRequests.set('/me/messages/draft-123', createMockGraphRequest({}));
      const listRequest = createMockGraphRequest({ value: [{ id: 'old-1' }, { id: 'old-2' }] });
      mockApiRequests.set('/me/messages/draft-123/attachments', listRequest);
      const delete1 = createMockGraphRequest();
      const delete2 = createMockGraphRequest();
      mockApiRequests.set('/me/messages/draft-123/attachments/old-1', delete1);
      mockApiRequests.set('/me/messages/draft-123/attachments/old-2', delete2);
      await adapter.connect(outlookAccount);

      await adapter.updateDraft('draft-123', { ...draft, attachments: [] });

      expect(listRequest.post).not.toHaveBeenCalled();
      expect(delete1.delete).toHaveBeenCalled();
      expect(delete2.delete).toHaveBeenCalled();
    });

    it('removes old files from every page of the list', async () => {
      mockApiRequests.set('/me/messages/draft-123', createMockGraphRequest({}));
      const nextLink = 'https://graph.microsoft.com/v1.0/me/messages/draft-123/attachments?$skip=1';
      const listRequest = createMockGraphRequest({ value: [{ id: 'old-1' }], '@odata.nextLink': nextLink });
      mockApiRequests.set('/me/messages/draft-123/attachments', listRequest);
      mockApiRequests.set(nextLink, createMockGraphRequest({ value: [{ id: 'old-2' }] }));
      const delete1 = createMockGraphRequest();
      const delete2 = createMockGraphRequest();
      mockApiRequests.set('/me/messages/draft-123/attachments/old-1', delete1);
      mockApiRequests.set('/me/messages/draft-123/attachments/old-2', delete2);
      await adapter.connect(outlookAccount);

      await adapter.updateDraft('draft-123', {
        ...draft,
        attachments: [{ filename: 'new.pdf', content: Buffer.from('new'), contentType: 'application/pdf' }],
      });

      expect(delete1.delete).toHaveBeenCalled();
      expect(delete2.delete).toHaveBeenCalled();
    });

    it('follows every page of the list, however many there are', async () => {
      mockApiRequests.set('/me/messages/draft-123', createMockGraphRequest({}));
      const pages = 105;
      const link = (n: number) => `https://graph.microsoft.com/v1.0/me/messages/draft-123/attachments?$skip=${n}`;
      mockApiRequests.set(
        '/me/messages/draft-123/attachments',
        createMockGraphRequest({ value: [{ id: 'old-0' }], '@odata.nextLink': link(1) }),
      );
      for (let n = 1; n < pages; n += 1) {
        mockApiRequests.set(
          link(n),
          createMockGraphRequest(n === pages - 1 ? { value: [{ id: `old-${n}` }] } : { value: [{ id: `old-${n}` }], '@odata.nextLink': link(n + 1) }),
        );
      }
      const deletes = Array.from({ length: pages }, (_, n) => {
        const request = createMockGraphRequest();
        mockApiRequests.set(`/me/messages/draft-123/attachments/old-${n}`, request);
        return request;
      });
      await adapter.connect(outlookAccount);

      await adapter.updateDraft('draft-123', { ...draft, attachments: [] });

      for (const request of deletes) expect(request.delete).toHaveBeenCalled();
    });

    it('refuses a file over 3 MB before touching the draft', async () => {
      const patchRequest = createMockGraphRequest({});
      mockApiRequests.set('/me/messages/draft-123', patchRequest);
      await adapter.connect(outlookAccount);

      await expect(
        adapter.updateDraft('draft-123', {
          ...draft,
          attachments: [{ filename: 'big.zip', content: Buffer.alloc(3 * 1024 * 1024 + 1), contentType: 'application/zip' }],
        }),
      ).rejects.toThrow(/Outlook accepts attachments up to 3\.0 MB.*big\.zip/);
      expect(patchRequest.patch).not.toHaveBeenCalled();
    });

    it('leaves attachments alone when none are given', async () => {
      mockApiRequests.set('/me/messages/draft-123', createMockGraphRequest({}));
      const listRequest = createMockGraphRequest({ value: [{ id: 'old-1' }] });
      mockApiRequests.set('/me/messages/draft-123/attachments', listRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.updateDraft('draft-123', {
        to: [{ email: 'bob@test.com' }],
        subject: 'Updated Subject',
        body: { text: 'Updated body' },
      });

      expect(listRequest.get).not.toHaveBeenCalled();
      expect(listRequest.post).not.toHaveBeenCalled();
    });
  });

  describe('listDrafts', () => {
    it('fetches messages from Drafts folder', async () => {
      const mockDraftsRequest = createMockGraphRequest({
        value: [
          {
            id: 'draft-1',
            conversationId: 'conv-d1',
            parentFolderId: 'drafts-folder',
            from: { emailAddress: { name: 'Me', address: 'test@outlook.com' } },
            toRecipients: [{ emailAddress: { name: 'Bob', address: 'bob@test.com' } }],
            ccRecipients: [],
            bccRecipients: [],
            subject: 'Draft email',
            receivedDateTime: '2026-02-15T14:00:00Z',
            body: { contentType: 'text', content: 'Draft content' },
            bodyPreview: 'Draft content',
            hasAttachments: false,
            isRead: true,
            flag: { flagStatus: 'notFlagged' },
            isDraft: true,
            importance: 'normal',
            categories: [],
          },
        ],
      });
      mockApiRequests.set('/me/mailFolders/drafts/messages', mockDraftsRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const drafts = await adapter.listDrafts(10, 0);

      expect(drafts).toHaveLength(1);
      expect(drafts[0].flags.draft).toBe(true);
      expect(drafts[0].subject).toBe('Draft email');
      expect(mockDraftsRequest.top).toHaveBeenCalledWith(10);
      expect(mockDraftsRequest.skip).toHaveBeenCalledWith(0);
    });
  });

  describe('moveEmail', () => {
    it('calls POST /me/messages/{id}/move with destination folder', async () => {
      const mockMoveRequest = createMockGraphRequest({ id: 'msg-1' });
      mockApiRequests.set('/me/messages/msg-1/move', mockMoveRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.moveEmail('msg-1', 'target-folder-id');

      expect(mockMoveRequest.post).toHaveBeenCalledWith({
        destinationId: 'target-folder-id',
      });
    });
  });

  describe('deleteEmail', () => {
    it('moves to Deleted Items by default', async () => {
      const mockMoveRequest = createMockGraphRequest({ id: 'msg-1' });
      mockApiRequests.set('/me/messages/msg-1/move', mockMoveRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.deleteEmail('msg-1');

      expect(mockMoveRequest.post).toHaveBeenCalledWith({
        destinationId: 'deleteditems',
      });
    });

    it('permanently deletes when permanent flag is true', async () => {
      const mockDeleteRequest = createMockGraphRequest();
      mockApiRequests.set('/me/messages/msg-1', mockDeleteRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.deleteEmail('msg-1', true);

      expect(mockDeleteRequest.delete).toHaveBeenCalled();
    });
  });

  describe('markEmail', () => {
    it('patches isRead when read flag provided', async () => {
      const mockPatchRequest = createMockGraphRequest();
      mockApiRequests.set('/me/messages/msg-1', mockPatchRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.markEmail('msg-1', { read: true });

      expect(mockPatchRequest.patch).toHaveBeenCalledWith(
        expect.objectContaining({ isRead: true })
      );
    });

    it('patches importance when starred flag provided', async () => {
      const mockPatchRequest = createMockGraphRequest();
      mockApiRequests.set('/me/messages/msg-1', mockPatchRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.markEmail('msg-1', { starred: true });

      expect(mockPatchRequest.patch).toHaveBeenCalledWith(
        expect.objectContaining({ importance: 'high' })
      );
    });

    it('patches flag status when flagged flag provided', async () => {
      const mockPatchRequest = createMockGraphRequest();
      mockApiRequests.set('/me/messages/msg-1', mockPatchRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.markEmail('msg-1', { flagged: true });

      expect(mockPatchRequest.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          flag: { flagStatus: 'flagged' },
        })
      );
    });

    it('handles multiple flags at once', async () => {
      const mockPatchRequest = createMockGraphRequest();
      mockApiRequests.set('/me/messages/msg-1', mockPatchRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      await adapter.markEmail('msg-1', { read: false, flagged: false });

      expect(mockPatchRequest.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          isRead: false,
          flag: { flagStatus: 'notFlagged' },
        })
      );
    });
  });

  describe('getCategories', () => {
    it('returns categories from a message', async () => {
      const mockCategoriesRequest = createMockGraphRequest({
        value: [
          { displayName: 'Red category', color: 'preset0' },
          { displayName: 'Blue category', color: 'preset1' },
          { displayName: 'Green category', color: 'preset2' },
        ],
      });
      mockApiRequests.set('/me/outlook/masterCategories', mockCategoriesRequest);

      await adapter.connect({
        id: 'outlook-1',
        name: 'Test',
        provider: 'outlook',
        email: 'test@outlook.com',
        oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
      });

      const categories = await adapter.getCategories();

      expect(categories).toEqual(['Red category', 'Blue category', 'Green category']);
    });
  });

  async function connectAdapter() {
    await adapter.connect({
      id: 'outlook-1',
      name: 'Test',
      provider: 'outlook',
      email: 'test@outlook.com',
      oauth: { access_token: 'token', refresh_token: 'rt', expiry: '' },
    });
  }

  describe('reportSpam', () => {
    it('moves the message to the Junk Email well-known folder — the same signal "Report Junk" sends', async () => {
      await connectAdapter();
      const moveReq = createMockGraphRequest({});
      mockApiRequests.set('/me/messages/msg-1/move', moveReq);

      await adapter.reportSpam('msg-1');

      expect(moveReq.post).toHaveBeenCalledWith({ destinationId: 'junkemail' });
    });
  });

  describe('createBlockRule', () => {
    it('maps senderDomain/senderAddress to a senderContains condition', async () => {
      await connectAdapter();
      const rulesReq = createMockGraphRequest();
      rulesReq.get = vi.fn().mockResolvedValue({ value: [] });
      rulesReq.post = vi.fn().mockResolvedValue({ id: 'rule-1' });
      mockApiRequests.set('/me/mailFolders/inbox/messageRules', rulesReq);

      const result = await adapter.createBlockRule({ matchType: 'senderDomain', value: 'getdrip.com', action: 'delete' });

      expect(rulesReq.post).toHaveBeenCalledWith(
        expect.objectContaining({
          conditions: { senderContains: ['getdrip.com'] },
          actions: { stopProcessingRules: true, delete: true },
          sequence: 1,
          isEnabled: true,
        }),
      );
      expect(result).toEqual({ id: 'rule-1' });
    });

    it('resolves the Junk Email folder for a moveToJunk action', async () => {
      await connectAdapter();
      const rulesReq = createMockGraphRequest();
      rulesReq.get = vi.fn().mockResolvedValue({ value: [] });
      rulesReq.post = vi.fn().mockResolvedValue({ id: 'rule-2' });
      mockApiRequests.set('/me/mailFolders/inbox/messageRules', rulesReq);

      await adapter.createBlockRule({ matchType: 'headerContains', value: 'in2.getdrip.com', action: 'moveToJunk' });

      expect(rulesReq.post).toHaveBeenCalledWith(
        expect.objectContaining({
          conditions: { headerContains: ['in2.getdrip.com'] },
          actions: { stopProcessingRules: true, moveToFolder: 'junkemail' },
        }),
      );
    });

    it('maps subjectContains to a subjectContains condition', async () => {
      await connectAdapter();
      const rulesReq = createMockGraphRequest();
      rulesReq.get = vi.fn().mockResolvedValue({ value: [] });
      rulesReq.post = vi.fn().mockResolvedValue({ id: 'rule-3' });
      mockApiRequests.set('/me/mailFolders/inbox/messageRules', rulesReq);

      await adapter.createBlockRule({ matchType: 'subjectContains', value: 'Kobalt Tool Set', action: 'delete' });

      expect(rulesReq.post).toHaveBeenCalledWith(
        expect.objectContaining({ conditions: { subjectContains: ['Kobalt Tool Set'] } }),
      );
    });
  });

  describe('listBlockRules', () => {
    it('reconstructs matchType and action from rule conditions/actions', async () => {
      await connectAdapter();
      const rulesReq = createMockGraphRequest();
      rulesReq.get = vi.fn().mockResolvedValue({
        value: [
          { id: 'r1', conditions: { senderContains: ['bad.com'] }, actions: { delete: true } },
          { id: 'r2', conditions: { headerContains: ['in2.getdrip.com'] }, actions: { moveToFolder: 'junkemail' } },
        ],
      });
      mockApiRequests.set('/me/mailFolders/inbox/messageRules', rulesReq);

      const rules = await adapter.listBlockRules();

      expect(rules).toEqual([
        { id: 'r1', matchType: 'senderDomain', value: 'bad.com', action: 'delete', createdAt: '' },
        { id: 'r2', matchType: 'headerContains', value: 'in2.getdrip.com', action: 'moveToJunk', createdAt: '' },
      ]);
    });

    it('leaves forwarding rules out: they are forward rules, not block rules', async () => {
      await connectAdapter();
      setRules([
        { id: 'r1', conditions: { senderContains: ['bad.com'] }, actions: { delete: true } },
        { id: 'r2', conditions: { senderContains: ['vendor.com'] }, actions: { forwardTo: [{ emailAddress: { address: 'expenses@example.com' } }] } },
        { id: 'r3', conditions: { senderContains: ['other.com'] }, actions: { redirectTo: [{ emailAddress: { address: 'books@example.com' } }] } },
      ]);

      const rules = await adapter.listBlockRules();
      expect(rules.map((r) => r.id)).toEqual(['r1']);
    });
  });

  describe('deleteBlockRule', () => {
    it('deletes the rule by id', async () => {
      await connectAdapter();
      const deleteReq = createMockGraphRequest({});
      mockApiRequests.set('/me/mailFolders/inbox/messageRules/rule-1', deleteReq);

      await adapter.deleteBlockRule('rule-1');

      expect(deleteReq.delete).toHaveBeenCalled();
    });
  });

  function setRules(value: unknown[], created: unknown = { id: 'rule-new' }) {
    const rulesReq = createMockGraphRequest();
    rulesReq.get = vi.fn().mockResolvedValue({ value });
    rulesReq.post = vi.fn().mockResolvedValue(created);
    mockApiRequests.set('/me/mailFolders/inbox/messageRules', rulesReq);
    return rulesReq;
  }

  describe('createForwardRule', () => {
    const rule = { matchType: 'senderDomain' as const, value: 'vendor.com', forwardTo: 'expenses@example.com', keepInInbox: true };

    it('creates a rule that forwards and leaves the original in the inbox', async () => {
      await connectAdapter();
      const rulesReq = setRules([{ id: 'r1', conditions: { senderContains: ['bad.com'] }, actions: { delete: true } }]);

      const result = await adapter.createForwardRule(rule);

      expect(rulesReq.post).toHaveBeenCalledWith({
        displayName: 'email-mcp: forward senderDomain "vendor.com" to expenses@example.com',
        sequence: 2,
        isEnabled: true,
        conditions: { senderContains: ['vendor.com'] },
        actions: { forwardTo: [{ emailAddress: { address: 'expenses@example.com' } }] },
      });
      expect(result).toEqual({ id: 'rule-new' });
    });

    it('also moves the original to the archive when keepInInbox is false', async () => {
      await connectAdapter();
      const rulesReq = setRules([]);

      await adapter.createForwardRule({ ...rule, keepInInbox: false });

      expect(rulesReq.post).toHaveBeenCalledWith(
        expect.objectContaining({
          actions: {
            forwardTo: [{ emailAddress: { address: 'expenses@example.com' } }],
            moveToFolder: 'archive',
            stopProcessingRules: true,
          },
        }),
      );
    });

    it('returns the existing rule when the same match already forwards to the same address', async () => {
      await connectAdapter();
      const rulesReq = setRules([
        { id: 'r7', conditions: { senderContains: ['vendor.com'] }, actions: { forwardTo: [{ emailAddress: { address: 'Expenses@Example.com' } }] } },
      ]);

      const result = await adapter.createForwardRule(rule);

      expect(result).toEqual({ id: 'r7', alreadyExisted: true });
      expect(rulesReq.post).not.toHaveBeenCalled();
    });

    it('creates a new rule when the match is the same but the target differs', async () => {
      await connectAdapter();
      const rulesReq = setRules([
        { id: 'r7', conditions: { senderContains: ['vendor.com'] }, actions: { forwardTo: [{ emailAddress: { address: 'books@example.com' } }] } },
      ]);

      const result = await adapter.createForwardRule(rule);

      expect(result).toEqual({ id: 'rule-new' });
      expect(rulesReq.post).toHaveBeenCalled();
    });
  });

  describe('listForwardRules', () => {
    it('returns only rules that forward or redirect, with targets and inbox behaviour', async () => {
      await connectAdapter();
      setRules([
        { id: 'r1', conditions: { senderContains: ['bad.com'] }, actions: { delete: true } },
        { id: 'r2', conditions: { senderContains: ['vendor.com'] }, actions: { forwardTo: [{ emailAddress: { address: 'expenses@example.com' } }] } },
        { id: 'r3', conditions: { subjectContains: ['Invoice'] }, actions: { redirectTo: [{ emailAddress: { address: 'books@example.com' } }], moveToFolder: 'archive' } },
      ]);

      expect(await adapter.listForwardRules()).toEqual([
        { id: 'r2', matchType: 'senderDomain', value: 'vendor.com', forwardTo: 'expenses@example.com', keepInInbox: true, createdAt: '' },
        { id: 'r3', matchType: 'subjectContains', value: 'Invoice', forwardTo: 'books@example.com', keepInInbox: false, createdAt: '' },
      ]);
    });

    it('is empty for an account without rules', async () => {
      await connectAdapter();
      setRules([]);
      expect(await adapter.listForwardRules()).toEqual([]);
    });
  });

  describe('deleteForwardRule', () => {
    it('deletes a forwarding rule by id', async () => {
      await connectAdapter();
      setRules([
        { id: 'rule-2', conditions: { senderContains: ['vendor.com'] }, actions: { forwardTo: [{ emailAddress: { address: 'expenses@example.com' } }] } },
      ]);
      const deleteReq = createMockGraphRequest({});
      mockApiRequests.set('/me/mailFolders/inbox/messageRules/rule-2', deleteReq);

      await adapter.deleteForwardRule('rule-2');

      expect(deleteReq.delete).toHaveBeenCalled();
    });

    it('refuses an id that is not a forwarding rule, so a block rule is not removed by mistake', async () => {
      await connectAdapter();
      setRules([{ id: 'rule-1', conditions: { senderContains: ['bad.com'] }, actions: { delete: true } }]);
      const deleteReq = createMockGraphRequest({});
      mockApiRequests.set('/me/mailFolders/inbox/messageRules/rule-1', deleteReq);

      await expect(adapter.deleteForwardRule('rule-1')).rejects.toThrow(/No forwarding rule with id rule-1/);
      expect(deleteReq.delete).not.toHaveBeenCalled();
    });
  });
});
