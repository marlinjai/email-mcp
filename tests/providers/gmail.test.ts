import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock data defined in vi.hoisted so vi.mock factories can reference it
const mockLabels = [
  { id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 100, messagesUnread: 5 },
  { id: 'SENT', name: 'SENT', type: 'system', messagesTotal: 50, messagesUnread: 0 },
  { id: 'DRAFT', name: 'DRAFT', type: 'system', messagesTotal: 3, messagesUnread: 0 },
  { id: 'TRASH', name: 'TRASH', type: 'system', messagesTotal: 10, messagesUnread: 0 },
  { id: 'SPAM', name: 'SPAM', type: 'system', messagesTotal: 8, messagesUnread: 8 },
  { id: 'Label_1', name: 'Work', type: 'user', messagesTotal: 20, messagesUnread: 2 },
];

const mockMessageMetadata = {
  id: 'msg-123',
  threadId: 'thread-456',
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'Hello, this is a test email...',
  internalDate: '1700000000000',
  payload: {
    headers: [
      { name: 'From', value: 'Alice <alice@example.com>' },
      { name: 'To', value: 'Bob <bob@example.com>' },
      { name: 'Cc', value: 'Carol <carol@example.com>' },
      { name: 'Subject', value: 'Test Email' },
      { name: 'Date', value: 'Tue, 14 Nov 2023 22:13:20 +0000' },
      { name: 'Message-ID', value: '<msg-123@example.com>' },
    ],
    mimeType: 'multipart/alternative',
    parts: [
      {
        mimeType: 'text/plain',
        body: {
          data: Buffer.from('Hello, this is a test email.').toString('base64url'),
          size: 27,
        },
      },
      {
        mimeType: 'text/html',
        body: {
          data: Buffer.from('<p>Hello, this is a test email.</p>').toString('base64url'),
          size: 34,
        },
      },
    ],
  },
};

const mockMessageWithAttachment = {
  id: 'msg-att-1',
  threadId: 'thread-att-1',
  labelIds: ['INBOX'],
  snippet: 'See attached.',
  internalDate: '1700000000000',
  payload: {
    headers: [
      { name: 'From', value: 'alice@example.com' },
      { name: 'To', value: 'bob@example.com' },
      { name: 'Subject', value: 'With Attachment' },
      { name: 'Date', value: 'Tue, 14 Nov 2023 22:13:20 +0000' },
    ],
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'text/plain',
        body: { data: Buffer.from('See attached.').toString('base64url'), size: 13 },
      },
      {
        mimeType: 'application/pdf',
        filename: 'report.pdf',
        body: { attachmentId: 'att-001', size: 1024 },
      },
    ],
  },
};

const mockThread = {
  id: 'thread-456',
  messages: [
    mockMessageMetadata,
    {
      ...mockMessageMetadata,
      id: 'msg-789',
      payload: {
        ...mockMessageMetadata.payload,
        headers: [
          { name: 'From', value: 'Bob <bob@example.com>' },
          { name: 'To', value: 'Alice <alice@example.com>' },
          { name: 'Subject', value: 'Re: Test Email' },
          { name: 'Date', value: 'Wed, 15 Nov 2023 10:00:00 +0000' },
        ],
      },
    },
  ],
};

// Mock functions — declared at top level so vi.mock factories can use them
const mockLabelsList = vi.fn();
const mockLabelsCreate = vi.fn();
const mockMessagesList = vi.fn();
const mockMessagesGet = vi.fn();
const mockMessagesSend = vi.fn();
const mockMessagesTrash = vi.fn();
const mockMessagesDelete = vi.fn();
const mockMessagesModify = vi.fn();
const mockMessagesBatchModify = vi.fn();
const mockMessagesInsert = vi.fn();
const mockAttachmentsGet = vi.fn();
const mockThreadsGet = vi.fn();
const mockDraftsCreate = vi.fn();
const mockDraftsUpdate = vi.fn();
const mockDraftsList = vi.fn();
const mockDraftsGet = vi.fn();
const mockFiltersCreate = vi.fn();
const mockFiltersList = vi.fn();
const mockFiltersDelete = vi.fn();

// Mock googleapis
vi.mock('googleapis', () => ({
  google: {
    gmail: () => ({
      users: {
        labels: { list: mockLabelsList, create: mockLabelsCreate },
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
          send: mockMessagesSend,
          trash: mockMessagesTrash,
          delete: mockMessagesDelete,
          modify: mockMessagesModify,
          batchModify: mockMessagesBatchModify,
          insert: mockMessagesInsert,
          attachments: { get: mockAttachmentsGet },
        },
        threads: { get: mockThreadsGet },
        drafts: { create: mockDraftsCreate, update: mockDraftsUpdate, list: mockDraftsList, get: mockDraftsGet },
        settings: {
          filters: { create: mockFiltersCreate, list: mockFiltersList, delete: mockFiltersDelete },
        },
      },
    }),
  },
}));

// Mock google-auth-library
vi.mock('google-auth-library', () => {
  class MockOAuth2Client {
    credentials: Record<string, any> = {};
    setCredentials(creds: any) {
      this.credentials = creds;
    }
  }
  return { OAuth2Client: MockOAuth2Client };
});

import { GmailAdapter } from '../../src/providers/gmail/adapter.js';
import { ProviderType } from '../../src/models/types.js';
import type { AccountCredentials } from '../../src/models/types.js';

const testCredentials: AccountCredentials = {
  id: 'gmail-test-1',
  name: 'Test Gmail',
  provider: 'gmail',
  email: 'test@gmail.com',
  oauth: {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    expiry: '2030-12-31T00:00:00Z',
  },
};

function resetMocks() {
  mockLabelsList.mockResolvedValue({ data: { labels: mockLabels } });
  mockLabelsCreate.mockResolvedValue({ data: { id: 'new-label', name: 'New', messagesTotal: 0, messagesUnread: 0 } });
  mockMessagesList.mockResolvedValue({
    data: {
      messages: [{ id: 'msg-123', threadId: 'thread-456' }],
      resultSizeEstimate: 1,
    },
  });
  mockMessagesGet.mockResolvedValue({ data: mockMessageMetadata });
  mockMessagesSend.mockResolvedValue({ data: { id: 'sent-1', threadId: 'thread-sent-1' } });
  mockMessagesTrash.mockResolvedValue({ data: {} });
  mockMessagesDelete.mockResolvedValue({ data: {} });
  mockMessagesModify.mockResolvedValue({ data: {} });
  mockMessagesBatchModify.mockResolvedValue({ data: {} });
  mockMessagesInsert.mockResolvedValue({ data: { id: 'inserted-1', threadId: 'thread-inserted-1' } });
  mockAttachmentsGet.mockResolvedValue({ data: { data: Buffer.from('file-content').toString('base64url'), size: 12 } });
  mockThreadsGet.mockResolvedValue({ data: mockThread });
  mockDraftsCreate.mockResolvedValue({ data: { id: 'draft-1', message: { id: 'msg-draft-1' } } });
  mockDraftsUpdate.mockResolvedValue({ data: { id: 'draft-1', message: { id: 'msg-draft-1-v2' } } });
  mockDraftsList.mockResolvedValue({
    data: { drafts: [{ id: 'draft-1', message: { id: 'msg-draft-1' } }] },
  });
  mockDraftsGet.mockResolvedValue({
    data: { id: 'draft-1', message: mockMessageMetadata },
  });
  mockFiltersCreate.mockResolvedValue({ data: { id: 'filter-1' } });
  mockFiltersList.mockResolvedValue({ data: { filter: [] } });
  mockFiltersDelete.mockResolvedValue({ data: {} });
}

describe('GmailAdapter', () => {
  let adapter: GmailAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetMocks();

    adapter = new GmailAdapter();
    await adapter.connect(testCredentials);
  });

  it('has correct provider type', () => {
    expect(adapter.providerType).toBe(ProviderType.Gmail);
  });

  describe('connect', () => {
    it('throws when no OAuth credentials', async () => {
      const noOauth = new GmailAdapter();
      await expect(
        noOauth.connect({ ...testCredentials, oauth: undefined }),
      ).rejects.toThrow(/OAuth/);
    });

    it('connects with valid OAuth tokens', async () => {
      const result = await adapter.testConnection();
      expect(result.success).toBe(true);
      expect(result.folderCount).toBeGreaterThan(0);
    });
  });

  describe('listFolders', () => {
    it('maps Gmail labels to Folder[]', async () => {
      const folders = await adapter.listFolders();
      expect(folders.length).toBe(mockLabels.length);

      const inbox = folders.find((f) => f.id === 'INBOX');
      expect(inbox).toBeDefined();
      expect(inbox!.type).toBe('inbox');
      expect(inbox!.totalCount).toBe(100);
      expect(inbox!.unreadCount).toBe(5);

      const sent = folders.find((f) => f.id === 'SENT');
      expect(sent!.type).toBe('sent');

      const trash = folders.find((f) => f.id === 'TRASH');
      expect(trash!.type).toBe('trash');

      const spam = folders.find((f) => f.id === 'SPAM');
      expect(spam!.type).toBe('spam');

      const userLabel = folders.find((f) => f.id === 'Label_1');
      expect(userLabel!.name).toBe('Work');
      expect(userLabel!.type).toBe('other');
    });
  });

  describe('createFolder', () => {
    it('creates a flat label when no parentPath is given', async () => {
      await adapter.createFolder('Anthropic');
      expect(mockLabelsCreate).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: { name: 'Anthropic' },
      });
    });

    it('nests the label under parentPath using Gmail\'s "/" naming convention', async () => {
      await adapter.createFolder('Anthropic', 'Tech');
      expect(mockLabelsCreate).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: { name: 'Tech/Anthropic' },
      });
    });

    it('supports an already-nested parentPath', async () => {
      await adapter.createFolder('Daily Productivity', 'Newsletters/Ali Abdall');
      expect(mockLabelsCreate).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: { name: 'Newsletters/Ali Abdall/Daily Productivity' },
      });
    });
  });

  describe('batchLabel', () => {
    it('adds and removes labels in a single batchModify call', async () => {
      const result = await adapter.batchLabel(['msg-1', 'msg-2'], ['Label_52'], ['INBOX']);

      expect(mockMessagesBatchModify).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: { ids: ['msg-1', 'msg-2'], addLabelIds: ['Label_52'], removeLabelIds: ['INBOX'] },
      });
      expect(result.succeeded).toEqual(['msg-1', 'msg-2']);
      expect(result.failed).toEqual([]);
    });

    it('is a no-op success when no labels are given', async () => {
      const result = await adapter.batchLabel(['msg-1']);
      expect(mockMessagesBatchModify).not.toHaveBeenCalled();
      expect(result.succeeded).toEqual(['msg-1']);
    });

    it('falls back to per-message modify calls when batchModify fails', async () => {
      mockMessagesBatchModify.mockRejectedValueOnce(new Error('batch failed'));

      const result = await adapter.batchLabel(['msg-1', 'msg-2'], ['Label_52']);

      expect(mockMessagesModify).toHaveBeenCalledTimes(2);
      expect(mockMessagesModify).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-1',
        requestBody: { addLabelIds: ['Label_52'] },
      });
      expect(result.succeeded).toEqual(['msg-1', 'msg-2']);
      expect(result.failed).toEqual([]);
    });

    it('reports per-message failures in the fallback path', async () => {
      mockMessagesBatchModify.mockRejectedValueOnce(new Error('batch failed'));
      mockMessagesModify.mockRejectedValueOnce(new Error('modify failed for msg-1'));

      const result = await adapter.batchLabel(['msg-1', 'msg-2'], ['Label_52']);

      expect(result.succeeded).toEqual(['msg-2']);
      expect(result.failed).toEqual([{ id: 'msg-1', error: 'modify failed for msg-1' }]);
    });
  });

  describe('search', () => {
    it('builds Gmail query from SearchQuery', async () => {
      await adapter.search({
        from: 'alice@example.com',
        unreadOnly: true,
        hasAttachment: true,
      });

      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'me',
          q: expect.stringContaining('from:alice@example.com'),
        }),
      );

      const call = mockMessagesList.mock.calls[0][0];
      expect(call.q).toContain('is:unread');
      expect(call.q).toContain('has:attachment');
    });

    it('applies folder as labelIds', async () => {
      await adapter.search({ folder: 'INBOX' });

      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({
          labelIds: ['INBOX'],
        }),
      );
    });

    it('applies limit as maxResults', async () => {
      await adapter.search({ limit: 10 });

      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({
          maxResults: 10,
        }),
      );
    });

    it('returns mapped Email[]', async () => {
      const emails = await adapter.search({ from: 'alice@example.com' });
      expect(emails).toHaveLength(1);
      expect(emails[0].id).toBe('msg-123');
      expect(emails[0].subject).toBe('Test Email');
    });

    it('returns empty array when no messages found', async () => {
      mockMessagesList.mockResolvedValueOnce({
        data: { messages: undefined, resultSizeEstimate: 0 },
      });
      const emails = await adapter.search({ from: 'nobody@example.com' });
      expect(emails).toHaveLength(0);
    });

    it('honors offset by paging through the id list and windowing', async () => {
      // Page 1: ids 0-2 with a nextPageToken, page 2: ids 3-4, no token.
      mockMessagesList
        .mockResolvedValueOnce({
          data: {
            messages: [{ id: 'm0' }, { id: 'm1' }, { id: 'm2' }],
            nextPageToken: 'page2',
          },
        })
        .mockResolvedValueOnce({
          data: { messages: [{ id: 'm3' }, { id: 'm4' }] },
        });
      // Each get returns a message echoing the requested id
      mockMessagesGet.mockImplementation(async ({ id }: { id: string }) => ({
        data: { ...mockMessageMetadata, id },
      }));

      const emails = await adapter.search({ offset: 3, limit: 2 });

      // The second page must have been requested with the pageToken cursor
      expect(mockMessagesList).toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: 'page2' }),
      );
      // Only the windowed ids (offset 3, limit 2) are fetched in full
      expect(emails.map((e) => e.id)).toEqual(['m3', 'm4']);
      expect(mockMessagesGet).toHaveBeenCalledTimes(2);
    });

    it('returns empty when offset exceeds available results', async () => {
      mockMessagesList.mockResolvedValueOnce({
        data: { messages: [{ id: 'm0' }, { id: 'm1' }] },
      });
      const emails = await adapter.search({ offset: 50, limit: 10 });
      expect(emails).toHaveLength(0);
      expect(mockMessagesGet).not.toHaveBeenCalled();
    });
  });

  describe('raw transfer primitives', () => {
    it('getRawMessage returns decoded MIME bytes', async () => {
      const rawMime = 'From: a@b.com\r\nSubject: Hi\r\n\r\nBody';
      mockMessagesGet.mockResolvedValueOnce({
        data: { raw: Buffer.from(rawMime).toString('base64url') },
      });

      const buf = await adapter.getRawMessage('msg-123');
      expect(mockMessagesGet).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'msg-123', format: 'raw' }),
      );
      expect(buf.toString('utf-8')).toBe(rawMime);
    });

    it('appendRawMessage inserts MIME with a resolved label id', async () => {
      const raw = Buffer.from('From: a@b.com\r\nSubject: Hi\r\n\r\nBody');
      const res = await adapter.appendRawMessage(raw, 'Work');

      expect(mockMessagesInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'me',
          internalDateSource: 'dateHeader',
          requestBody: { labelIds: ['Label_1'] }, // "Work" resolves to Label_1
          media: expect.objectContaining({ mimeType: 'message/rfc822' }),
        }),
      );
      expect(res.id).toBe('inserted-1');
    });

    it('appendRawMessage defaults to INBOX and applies unread/starred flags', async () => {
      const raw = Buffer.from('x');
      await adapter.appendRawMessage(raw, undefined, { read: false, starred: true });

      const call = mockMessagesInsert.mock.calls[0][0];
      expect(call.requestBody.labelIds).toContain('INBOX');
      expect(call.requestBody.labelIds).toContain('UNREAD');
      expect(call.requestBody.labelIds).toContain('STARRED');
    });
  });

  describe('getEmail', () => {
    it('fetches full email by ID', async () => {
      const email = await adapter.getEmail('msg-123');
      expect(email.id).toBe('msg-123');
      expect(email.subject).toBe('Test Email');
      expect(email.from.email).toBe('alice@example.com');
      expect(email.from.name).toBe('Alice');
      expect(email.to[0].email).toBe('bob@example.com');
      expect(email.body.text).toBe('Hello, this is a test email.');
      expect(email.body.html).toContain('<p>Hello');
      expect(email.flags.read).toBe(false); // UNREAD label present
      expect(email.threadId).toBe('thread-456');
    });

    it('calls gmail API with format full', async () => {
      await adapter.getEmail('msg-123');
      expect(mockMessagesGet).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-123',
        format: 'full',
      });
    });

    it('maps attachments', async () => {
      mockMessagesGet.mockResolvedValueOnce({
        data: mockMessageWithAttachment,
      });
      const email = await adapter.getEmail('msg-att-1');
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0].filename).toBe('report.pdf');
      expect(email.attachments[0].contentType).toBe('application/pdf');
      expect(email.attachments[0].size).toBe(1024);
    });
  });

  describe('getThread', () => {
    it('fetches thread and maps to Thread', async () => {
      const thread = await adapter.getThread('thread-456');
      expect(thread.id).toBe('thread-456');
      expect(thread.messages).toHaveLength(2);
      expect(thread.messageCount).toBe(2);
      expect(thread.subject).toBe('Test Email');
      expect(thread.participants.length).toBeGreaterThan(0);
    });
  });

  describe('sendEmail', () => {
    it('sends email via Gmail API', async () => {
      const result = await adapter.sendEmail({
        to: [{ name: 'Bob', email: 'bob@example.com' }],
        subject: 'Test Send',
        body: { text: 'Hello Bob' },
      });

      expect(result.id).toBe('sent-1');
      expect(result.threadId).toBe('thread-sent-1');
      expect(mockMessagesSend).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'me',
          requestBody: expect.objectContaining({ raw: expect.any(String) }),
        }),
      );
    });
  });

  describe('createDraft', () => {
    it('creates draft via Gmail API', async () => {
      const result = await adapter.createDraft({
        to: [{ email: 'bob@example.com' }],
        subject: 'Draft Test',
        body: { text: 'Draft content' },
      });

      expect(result.id).toBe('draft-1');
      expect(mockDraftsCreate).toHaveBeenCalled();
    });
  });

  describe('updateDraft', () => {
    it('updates the draft in place via Gmail API, id unchanged', async () => {
      const result = await adapter.updateDraft('draft-1', {
        to: [{ email: 'bob@example.com' }],
        subject: 'Updated Draft',
        body: { text: 'Updated content' },
      });

      expect(result.id).toBe('draft-1');
      expect(mockDraftsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'me',
          id: 'draft-1',
          requestBody: expect.objectContaining({ message: { raw: expect.any(String) } }),
        }),
      );
    });
  });

  describe('listDrafts', () => {
    it('lists drafts', async () => {
      const drafts = await adapter.listDrafts();
      expect(drafts).toHaveLength(1);
    });
  });

  describe('moveEmail', () => {
    it('adds target label and removes source labels', async () => {
      await adapter.moveEmail('msg-123', 'TRASH');

      expect(mockMessagesModify).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'me',
          id: 'msg-123',
          requestBody: expect.objectContaining({
            addLabelIds: ['TRASH'],
            removeLabelIds: expect.arrayContaining(['INBOX']),
          }),
        }),
      );
    });
  });

  describe('deleteEmail', () => {
    it('trashes by default', async () => {
      await adapter.deleteEmail('msg-123');
      expect(mockMessagesTrash).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-123',
      });
    });

    it('permanently deletes when specified', async () => {
      await adapter.deleteEmail('msg-123', true);
      expect(mockMessagesDelete).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-123',
      });
    });
  });

  describe('markEmail', () => {
    it('marks as read by removing UNREAD label', async () => {
      await adapter.markEmail('msg-123', { read: true });
      expect(mockMessagesModify).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            removeLabelIds: expect.arrayContaining(['UNREAD']),
          }),
        }),
      );
    });

    it('marks as unread by adding UNREAD label', async () => {
      await adapter.markEmail('msg-123', { read: false });
      expect(mockMessagesModify).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            addLabelIds: expect.arrayContaining(['UNREAD']),
          }),
        }),
      );
    });

    it('stars by adding STARRED label', async () => {
      await adapter.markEmail('msg-123', { starred: true });
      expect(mockMessagesModify).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            addLabelIds: expect.arrayContaining(['STARRED']),
          }),
        }),
      );
    });
  });

  describe('addLabels', () => {
    it('adds labels via modify', async () => {
      await adapter.addLabels('msg-123', ['Label_1', 'Label_2']);
      expect(mockMessagesModify).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-123',
        requestBody: { addLabelIds: ['Label_1', 'Label_2'] },
      });
    });
  });

  describe('removeLabels', () => {
    it('removes labels via modify', async () => {
      await adapter.removeLabels('msg-123', ['Label_1']);
      expect(mockMessagesModify).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-123',
        requestBody: { removeLabelIds: ['Label_1'] },
      });
    });
  });

  describe('listLabels', () => {
    it('lists labels with message counts', async () => {
      const labels = await adapter.listLabels();
      expect(labels).toHaveLength(mockLabels.length);
      expect(labels[0]).toHaveProperty('id');
      expect(labels[0]).toHaveProperty('name');
      expect(labels[0]).toHaveProperty('messageCount');
    });
  });

  describe('reportSpam', () => {
    it('adds SPAM and removes INBOX via modify — the same signal "Report spam" sends', async () => {
      await adapter.reportSpam('msg-123');
      expect(mockMessagesModify).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-123',
        requestBody: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
      });
    });
  });

  describe('createBlockRule', () => {
    it('maps senderDomain to a "@domain" From filter', async () => {
      await adapter.createBlockRule({ matchType: 'senderDomain', value: 'getdrip.com', action: 'moveToJunk' });
      expect(mockFiltersCreate).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: {
          criteria: { from: '@getdrip.com' },
          // Gmail's filter Action rejects SPAM in addLabelIds — confirmed
          // live ("Invalid label SPAM in AddLabelIds"). Skipping the inbox
          // is the closest a standing filter can actually do.
          action: { removeLabelIds: ['INBOX'] },
        },
      });
    });

    it('maps senderAddress to an exact From filter', async () => {
      await adapter.createBlockRule({ matchType: 'senderAddress', value: 'spammer@bad.com', action: 'delete' });
      expect(mockFiltersCreate).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: {
          criteria: { from: 'spammer@bad.com' },
          action: { addLabelIds: ['TRASH'] },
        },
      });
    });

    it('maps subjectContains to a subject filter', async () => {
      await adapter.createBlockRule({ matchType: 'subjectContains', value: 'Kobalt Tool Set', action: 'delete' });
      expect(mockFiltersCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({ criteria: { subject: 'Kobalt Tool Set' } }),
        }),
      );
    });

    it('maps headerContains to a raw query — the escape hatch for a rotating-domain template', async () => {
      await adapter.createBlockRule({ matchType: 'headerContains', value: 'in2.getdrip.com', action: 'moveToJunk' });
      expect(mockFiltersCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({ criteria: { query: 'in2.getdrip.com' } }),
        }),
      );
    });

    it('returns the created filter id', async () => {
      const result = await adapter.createBlockRule({ matchType: 'senderDomain', value: 'bad.com', action: 'delete' });
      expect(result).toEqual({ id: 'filter-1' });
    });
  });

  describe('listBlockRules', () => {
    it('reconstructs matchType and action from filter criteria', async () => {
      mockFiltersList.mockResolvedValue({
        data: {
          filter: [
            { id: 'f1', criteria: { from: '@bad.com' }, action: { addLabelIds: ['TRASH'] } },
            { id: 'f2', criteria: { subject: 'prize' }, action: { removeLabelIds: ['INBOX'] } },
          ],
        },
      });

      const rules = await adapter.listBlockRules();
      expect(rules).toEqual([
        { id: 'f1', matchType: 'senderDomain', value: 'bad.com', action: 'delete', createdAt: '' },
        { id: 'f2', matchType: 'subjectContains', value: 'prize', action: 'moveToJunk', createdAt: '' },
      ]);
    });
  });

  describe('deleteBlockRule', () => {
    it('calls filters.delete with the rule id', async () => {
      await adapter.deleteBlockRule('filter-1');
      expect(mockFiltersDelete).toHaveBeenCalledWith({ userId: 'me', id: 'filter-1' });
    });
  });
});
