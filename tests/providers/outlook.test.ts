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
  });

  describe('createDraft', () => {
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
});
