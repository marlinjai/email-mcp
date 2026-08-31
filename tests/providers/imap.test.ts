import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapAdapter } from '../../src/providers/imap/adapter.js';
import { ProviderType } from '../../src/models/types.js';
import type { SearchQuery } from '../../src/models/types.js';

const mockFolders = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', status: { messages: 10, unseen: 3 } },
  { path: 'Sent', name: 'Sent', specialUse: '\\Sent', status: { messages: 50, unseen: 0 } },
  { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', status: { messages: 2, unseen: 0 } },
  { path: 'Trash', name: 'Trash', specialUse: '\\Trash', status: { messages: 5, unseen: 0 } },
  { path: 'Junk', name: 'Junk', specialUse: '\\Junk', status: { messages: 8, unseen: 8 } },
];

function createMockMessage(uid: number, opts: {
  from?: string;
  to?: string;
  subject?: string;
  date?: Date;
  flags?: Set<string>;
  text?: string;
  html?: string;
} = {}) {
  return {
    uid,
    source: Buffer.from(`Subject: ${opts.subject || 'Test'}\r\n\r\n${opts.text || 'body'}`),
    flags: opts.flags || new Set(),
    envelope: {
      from: [{ name: opts.from || 'Alice', address: opts.from || 'alice@test.com' }],
      to: [{ name: opts.to || 'Bob', address: opts.to || 'bob@test.com' }],
      cc: [],
      bcc: [],
      subject: opts.subject || `Test Subject ${uid}`,
      date: (opts.date || new Date('2026-01-15T10:00:00Z')).toISOString(),
      messageId: `<msg-${uid}@example.com>`,
    },
  };
}

function createParsedEmail(uid: number, opts: {
  from?: string;
  to?: string;
  subject?: string;
  date?: Date;
  flags?: Set<string>;
  text?: string;
  html?: string;
} = {}) {
  return {
    uid,
    messageId: `<msg-${uid}@example.com>`,
    from: { value: [{ name: opts.from || 'Alice', address: opts.from || 'alice@test.com' }] },
    to: { value: [{ name: opts.to || 'Bob', address: opts.to || 'bob@test.com' }] },
    subject: opts.subject || `Test Subject ${uid}`,
    date: opts.date || new Date('2026-01-15T10:00:00Z'),
    text: opts.text || `Body of message ${uid}`,
    html: opts.html,
    attachments: [],
    flags: opts.flags || new Set(),
  };
}

let mockSearchResult: number[] = [1, 2, 3];
let mockFetchMessages: any[] = [];
let mockMailboxLockRelease = vi.fn();

// Mock imapflow
vi.mock('imapflow', () => {
  class MockImapFlow {
    connect = vi.fn().mockResolvedValue(undefined);
    logout = vi.fn().mockResolvedValue(undefined);
    list = vi.fn().mockResolvedValue(mockFolders);
    usable = true;

    search = vi.fn().mockImplementation(() => Promise.resolve(mockSearchResult));
    noop = vi.fn().mockResolvedValue(undefined);
    status = vi.fn().mockResolvedValue({ messages: -1 });

    getMailboxLock = vi.fn().mockImplementation(() =>
      Promise.resolve({ release: mockMailboxLockRelease })
    );

    fetch = vi.fn().mockImplementation(function* (uids: number[] | string) {
      const uidSet = Array.isArray(uids) ? new Set(uids) : null;
      for (const msg of mockFetchMessages) {
        if (!uidSet || uidSet.has(msg.uid)) {
          yield msg;
        }
      }
    });

    fetchOne = vi.fn().mockImplementation(() => {
      return Promise.resolve(mockFetchMessages[0] || null);
    });

    messageMove = vi.fn().mockResolvedValue(undefined);
    messageDelete = vi.fn().mockResolvedValue(undefined);
    messageFlagsAdd = vi.fn().mockResolvedValue(undefined);
    messageFlagsRemove = vi.fn().mockResolvedValue(undefined);
    mailboxCreate = vi.fn().mockResolvedValue({ path: 'NewFolder', name: 'NewFolder' });
    mailboxOpen = vi.fn().mockResolvedValue(undefined);
    append = vi.fn().mockResolvedValue({ uid: 100 });

    constructor(_config: any) {}
  }
  return { ImapFlow: MockImapFlow };
});

// Mock nodemailer
const { mockSendMail } = vi.hoisted(() => {
  const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<sent-1@example.com>' });
  return { mockSendMail };
});
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: mockSendMail,
    }),
  },
}));

// Mock mailparser
vi.mock('mailparser', () => ({
  simpleParser: vi.fn().mockImplementation(async (source: Buffer) => {
    // Return a mock parsed email based on the source
    const text = source.toString();
    const uidMatch = text.match(/uid-(\d+)/);
    const uid = uidMatch ? parseInt(uidMatch[1]) : 1;
    return createParsedEmail(uid);
  }),
}));

const testCredentials = {
  id: 'test-1',
  name: 'Test',
  provider: 'imap' as const,
  email: 'test@example.com',
  password: {
    password: 'pass123',
    host: 'imap.example.com',
    port: 993,
    tls: true,
  },
};

describe('ImapAdapter', () => {
  let adapter: ImapAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ImapAdapter();
    mockSearchResult = [1, 2, 3];
    mockFetchMessages = [
      createMockMessage(1, { subject: 'First', text: 'uid-1 body' }),
      createMockMessage(2, { subject: 'Second', text: 'uid-2 body' }),
      createMockMessage(3, { subject: 'Third', text: 'uid-3 body' }),
    ];
  });

  it('has correct provider type', () => {
    expect(adapter.providerType).toBe(ProviderType.IMAP);
  });

  it('connects with password credentials', async () => {
    await adapter.connect(testCredentials);

    const result = await adapter.testConnection();
    expect(result.success).toBe(true);
    expect(result.folderCount).toBe(5);
  });

  it('throws if no password credentials provided', async () => {
    await expect(
      adapter.connect({
        id: 'test-2',
        name: 'Test',
        provider: 'imap',
        email: 'test@example.com',
      })
    ).rejects.toThrow('IMAP adapter requires password credentials');
  });

  it('lists folders with correct types', async () => {
    await adapter.connect(testCredentials);

    const folders = await adapter.listFolders();
    expect(folders).toHaveLength(5);

    const inbox = folders.find((f) => f.path === 'INBOX');
    expect(inbox?.type).toBe('inbox');
    expect(inbox?.totalCount).toBe(10);
    expect(inbox?.unreadCount).toBe(3);

    const sent = folders.find((f) => f.path === 'Sent');
    expect(sent?.type).toBe('sent');

    const drafts = folders.find((f) => f.path === 'Drafts');
    expect(drafts?.type).toBe('drafts');

    const trash = folders.find((f) => f.path === 'Trash');
    expect(trash?.type).toBe('trash');

    const spam = folders.find((f) => f.path === 'Junk');
    expect(spam?.type).toBe('spam');
  });

  it('throws when listing folders without connecting', async () => {
    await expect(adapter.listFolders()).rejects.toThrow('Not connected');
  });

  it('disconnects cleanly', async () => {
    await adapter.connect(testCredentials);
    await adapter.disconnect();
    await expect(adapter.listFolders()).rejects.toThrow('Not connected');
  });
});

describe('ImapAdapter search and getEmail', () => {
  let adapter: ImapAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new ImapAdapter();
    mockSearchResult = [1, 2, 3];
    mockFetchMessages = [
      createMockMessage(1, { subject: 'First', text: 'uid-1 body' }),
      createMockMessage(2, { subject: 'Second', text: 'uid-2 body' }),
      createMockMessage(3, { subject: 'Third', text: 'uid-3 body' }),
    ];
    await adapter.connect(testCredentials);
  });

  it('searches messages in a folder', async () => {
    const results = await adapter.search({ folder: 'INBOX', returnBody: true });
    expect(results).toHaveLength(3);
    expect(results[0].accountId).toBe('test-1');
    expect(results[0].folder).toBe('INBOX');
  });

  it('searches with from filter', async () => {
    const results = await adapter.search({ folder: 'INBOX', from: 'alice@test.com', returnBody: true });
    expect(results).toHaveLength(3);
    // Verify the IMAP client's search was called with the right criteria
    const client = (adapter as any).client;
    expect(client.search).toHaveBeenCalled();
    const searchCriteria = client.search.mock.calls[0][0];
    expect(searchCriteria).toHaveProperty('from', 'alice@test.com');
  });

  it('searches with unreadOnly filter', async () => {
    await adapter.search({ folder: 'INBOX', unreadOnly: true, returnBody: true });
    const client = (adapter as any).client;
    const searchCriteria = client.search.mock.calls[0][0];
    expect(searchCriteria).toHaveProperty('unseen', true);
  });

  it('searches with date filters', async () => {
    await adapter.search({ folder: 'INBOX', since: '2026-01-01', before: '2026-02-01', returnBody: true });
    const client = (adapter as any).client;
    const searchCriteria = client.search.mock.calls[0][0];
    expect(searchCriteria.since).toBeInstanceOf(Date);
    expect(searchCriteria.before).toBeInstanceOf(Date);
  });

  it('searches with subject filter', async () => {
    await adapter.search({ folder: 'INBOX', subject: 'Test', returnBody: true });
    const client = (adapter as any).client;
    const searchCriteria = client.search.mock.calls[0][0];
    expect(searchCriteria).toHaveProperty('subject', 'Test');
  });

  it('searches with starredOnly filter', async () => {
    await adapter.search({ folder: 'INBOX', starredOnly: true, returnBody: true });
    const client = (adapter as any).client;
    const searchCriteria = client.search.mock.calls[0][0];
    expect(searchCriteria).toHaveProperty('flagged', true);
  });

  it('applies limit', async () => {
    const results = await adapter.search({ folder: 'INBOX', limit: 2, returnBody: true });
    expect(results).toHaveLength(2);
  });

  it('applies offset', async () => {
    mockSearchResult = [1, 2, 3, 4, 5];
    mockFetchMessages = [
      createMockMessage(3, { text: 'uid-3 body' }),
      createMockMessage(4, { text: 'uid-4 body' }),
      createMockMessage(5, { text: 'uid-5 body' }),
    ];
    const results = await adapter.search({ folder: 'INBOX', offset: 2, returnBody: true });
    expect(results).toHaveLength(3);
  });

  it('applies limit and offset together', async () => {
    mockSearchResult = [1, 2, 3, 4, 5];
    mockFetchMessages = [
      createMockMessage(3, { text: 'uid-3 body' }),
    ];
    const results = await adapter.search({ folder: 'INBOX', offset: 2, limit: 1, returnBody: true });
    expect(results).toHaveLength(1);
  });

  it('defaults folder to INBOX', async () => {
    const results = await adapter.search({ returnBody: true });
    expect(results).toHaveLength(3);
    const client = (adapter as any).client;
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
  });

  it('getEmail fetches a single message by UID', async () => {
    mockFetchMessages = [
      createMockMessage(42, { subject: 'Single', text: 'uid-42 body' }),
    ];
    const email = await adapter.getEmail('42');
    expect(email.id).toBe('42');
    expect(email.accountId).toBe('test-1');
    expect(email.folder).toBe('INBOX');
  });

  it('getEmail throws if message not found', async () => {
    mockFetchMessages = [];
    const client = (adapter as any).client;
    client.fetchOne.mockResolvedValueOnce(null);
    await expect(adapter.getEmail('999')).rejects.toThrow();
  });

  it('releases mailbox lock after search', async () => {
    await adapter.search({ folder: 'INBOX', returnBody: true });
    expect(mockMailboxLockRelease).toHaveBeenCalled();
  });
});

describe('ImapAdapter send, move, delete, mark, createFolder', () => {
  let adapter: ImapAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new ImapAdapter();
    mockSearchResult = [1, 2, 3];
    mockFetchMessages = [
      createMockMessage(1, { subject: 'First', text: 'uid-1 body' }),
    ];
    await adapter.connect(testCredentials);
  });

  it('sendEmail calls SMTP transport with correct params', async () => {
    const result = await adapter.sendEmail({
      to: [{ name: 'Bob', email: 'bob@test.com' }],
      subject: 'Hello',
      body: { text: 'Hi Bob', html: '<p>Hi Bob</p>' },
    });
    expect(result.id).toBeTruthy();
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'test@example.com',
        to: '"Bob" <bob@test.com>',
        subject: 'Hello',
        text: 'Hi Bob',
        html: '<p>Hi Bob</p>',
      })
    );
  });

  it('sendEmail handles cc and bcc', async () => {
    await adapter.sendEmail({
      to: [{ email: 'bob@test.com' }],
      cc: [{ email: 'cc@test.com' }],
      bcc: [{ email: 'bcc@test.com' }],
      subject: 'Test',
      body: { text: 'body' },
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: 'cc@test.com',
        bcc: 'bcc@test.com',
      })
    );
  });

  it('moveEmail calls messageMove with correct params', async () => {
    await adapter.moveEmail('123', 'Archive');
    const client = (adapter as any).client;
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(client.messageMove).toHaveBeenCalledWith('123', 'Archive', { uid: true });
  });

  it('getRawMessage fetches the source bytes from the given folder', async () => {
    mockFetchMessages = [createMockMessage(7, { subject: 'Raw me', text: 'uid-7 raw' })];
    const buf = await adapter.getRawMessage('7', 'INBOX');
    const client = (adapter as any).client;
    expect(client.fetchOne).toHaveBeenCalledWith('7', { source: true, uid: true }, { uid: true });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toContain('Raw me');
  });

  it('getRawMessage throws when the message is missing', async () => {
    const client = (adapter as any).client;
    client.fetchOne.mockResolvedValueOnce(null);
    await expect(adapter.getRawMessage('999', 'INBOX')).rejects.toThrow(/not found/);
  });

  it('appendRawMessage appends to the resolved folder with flags', async () => {
    const raw = Buffer.from('Subject: Hi\r\n\r\nbody');
    const res = await adapter.appendRawMessage(raw, 'Archive', { read: true, starred: true });
    const client = (adapter as any).client;
    expect(client.append).toHaveBeenCalledWith('Archive', raw, ['\\Seen', '\\Flagged']);
    expect(res.id).toBe('100'); // mock append returns { uid: 100 }
  });

  it('appendRawMessage defaults to INBOX with no flags', async () => {
    await adapter.appendRawMessage(Buffer.from('x'));
    const client = (adapter as any).client;
    expect(client.append).toHaveBeenCalledWith('INBOX', expect.any(Buffer), []);
  });

  it('deleteEmail moves to Trash by default', async () => {
    await adapter.deleteEmail('456');
    const client = (adapter as any).client;
    expect(client.messageMove).toHaveBeenCalledWith('456', 'Trash', { uid: true });
  });

  it('deleteEmail permanently deletes when permanent=true', async () => {
    await adapter.deleteEmail('456', true);
    const client = (adapter as any).client;
    expect(client.messageDelete).toHaveBeenCalledWith('456', { uid: true });
  });

  it('markEmail adds \\Seen flag when read=true', async () => {
    await adapter.markEmail('789', { read: true });
    const client = (adapter as any).client;
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('789', ['\\Seen'], { uid: true });
  });

  it('markEmail removes \\Seen flag when read=false', async () => {
    await adapter.markEmail('789', { read: false });
    const client = (adapter as any).client;
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('789', ['\\Seen'], { uid: true });
  });

  it('markEmail adds \\Flagged when starred=true', async () => {
    await adapter.markEmail('789', { starred: true });
    const client = (adapter as any).client;
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('789', ['\\Flagged'], { uid: true });
  });

  it('markEmail removes \\Flagged when starred=false', async () => {
    await adapter.markEmail('789', { starred: false });
    const client = (adapter as any).client;
    expect(client.messageFlagsRemove).toHaveBeenCalledWith('789', ['\\Flagged'], { uid: true });
  });

  it('markEmail handles flagged param', async () => {
    await adapter.markEmail('789', { flagged: true });
    const client = (adapter as any).client;
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('789', ['\\Flagged'], { uid: true });
  });

  it('createFolder calls mailboxCreate', async () => {
    const folder = await adapter.createFolder('NewFolder');
    const client = (adapter as any).client;
    expect(client.mailboxCreate).toHaveBeenCalledWith('NewFolder');
    expect(folder.name).toBe('NewFolder');
    expect(folder.path).toBe('NewFolder');
  });

  it('createFolder with parent path', async () => {
    const client = (adapter as any).client;
    client.mailboxCreate.mockResolvedValueOnce({ path: 'Parent/Child', name: 'Child' });
    const folder = await adapter.createFolder('Child', 'Parent');
    expect(client.mailboxCreate).toHaveBeenCalledWith('Parent/Child');
    expect(folder.path).toBe('Parent/Child');
  });
});

describe('ImapAdapter threads, drafts, attachments', () => {
  let adapter: ImapAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new ImapAdapter();
    mockSearchResult = [1, 2, 3];
    mockFetchMessages = [
      createMockMessage(1, { subject: 'Thread msg 1', text: 'uid-1 body' }),
      createMockMessage(2, { subject: 'Re: Thread msg 1', text: 'uid-2 body' }),
      createMockMessage(3, { subject: 'Re: Thread msg 1', text: 'uid-3 body' }),
    ];
    await adapter.connect(testCredentials);
  });

  it('getThread searches by message id and returns Thread', async () => {
    const thread = await adapter.getThread('<msg-1@example.com>');
    expect(thread.id).toBe('<msg-1@example.com>');
    expect(thread.messages).toHaveLength(3);
    expect(thread.messageCount).toBe(3);
    expect(thread.subject).toBeTruthy();
    expect(thread.participants).toBeDefined();
    expect(thread.lastMessageDate).toBeTruthy();
  });

  it('getThread calls search with header criteria', async () => {
    await adapter.getThread('<msg-1@example.com>');
    const client = (adapter as any).client;
    expect(client.search).toHaveBeenCalled();
  });

  it('createDraft appends message to Drafts with \\Draft flag', async () => {
    const result = await adapter.createDraft({
      to: [{ email: 'bob@test.com' }],
      subject: 'Draft subject',
      body: { text: 'Draft body' },
    });
    expect(result.id).toBeTruthy();
    const client = (adapter as any).client;
    expect(client.append).toHaveBeenCalledWith(
      'Drafts',
      expect.any(String),
      expect.arrayContaining(['\\Draft', '\\Seen']),
    );
  });

  it('listDrafts returns emails from Drafts folder', async () => {
    mockSearchResult = [10, 11];
    mockFetchMessages = [
      createMockMessage(10, { subject: 'Draft 1', text: 'uid-10 body' }),
      createMockMessage(11, { subject: 'Draft 2', text: 'uid-11 body' }),
    ];
    const drafts = await adapter.listDrafts();
    expect(drafts).toHaveLength(2);
    const client = (adapter as any).client;
    expect(client.getMailboxLock).toHaveBeenCalledWith('Drafts');
  });

  it('listDrafts respects limit and offset', async () => {
    mockSearchResult = [10, 11, 12];
    mockFetchMessages = [
      createMockMessage(11, { text: 'uid-11 body' }),
    ];
    const drafts = await adapter.listDrafts(1, 1);
    expect(drafts).toHaveLength(1);
  });

  // Regression: Gmail exposes drafts via IMAP under "[Gmail]/Drafts" (or a
  // localized name like "[Gmail]/Entwürfe"), not a top-level "Drafts" mailbox.
  // createDraft/listDrafts must resolve the real folder instead of hardcoding
  // "Drafts", otherwise both operations fail on Gmail accounts. See issue #3.
  const gmailFolders = [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
    { path: '[Gmail]/Drafts', name: 'Drafts', specialUse: '\\Drafts' },
    { path: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' },
    { path: '[Gmail]/Trash', name: 'Trash', specialUse: '\\Trash' },
  ];

  it('createDraft resolves the Gmail drafts folder before appending', async () => {
    const client = (adapter as any).client;
    client.list.mockResolvedValue(gmailFolders);

    await adapter.createDraft({
      to: [{ email: 'bob@test.com' }],
      subject: 'Draft subject',
      body: { text: 'Draft body' },
    });

    expect(client.append).toHaveBeenCalledWith(
      '[Gmail]/Drafts',
      expect.any(String),
      expect.arrayContaining(['\\Draft', '\\Seen']),
    );
  });

  it('createDraft resolves a localized Gmail drafts folder via special-use flag', async () => {
    const client = (adapter as any).client;
    client.list.mockResolvedValue([
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      { path: '[Gmail]/Entwürfe', name: 'Entwürfe', specialUse: '\\Drafts' },
    ]);

    await adapter.createDraft({
      to: [{ email: 'bob@test.com' }],
      subject: 'Draft subject',
      body: { text: 'Draft body' },
    });

    expect(client.append).toHaveBeenCalledWith(
      '[Gmail]/Entwürfe',
      expect.any(String),
      expect.arrayContaining(['\\Draft', '\\Seen']),
    );
  });

  it('listDrafts resolves the Gmail drafts folder before searching', async () => {
    const client = (adapter as any).client;
    client.list.mockResolvedValue(gmailFolders);

    await adapter.listDrafts();

    expect(client.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Drafts');
  });

  it('getAttachment fetches email and extracts attachment', async () => {
    // Override simpleParser mock for this test to return an attachment
    const { simpleParser: mockParser } = await import('mailparser');
    (mockParser as any).mockResolvedValueOnce({
      uid: 42,
      messageId: '<msg-42@example.com>',
      from: { value: [{ name: 'Alice', address: 'alice@test.com' }] },
      to: { value: [{ name: 'Bob', address: 'bob@test.com' }] },
      subject: 'With attachment',
      date: new Date('2026-01-15'),
      text: 'See attached',
      attachments: [
        {
          contentId: 'att-1',
          filename: 'test.pdf',
          contentType: 'application/pdf',
          size: 1024,
          content: Buffer.from('pdf-content'),
        },
      ],
      flags: new Set(),
    });

    mockFetchMessages = [
      createMockMessage(42, { text: 'uid-42 body' }),
    ];

    const { data, meta } = await adapter.getAttachment('42', 'att-1');
    expect(meta.id).toBe('att-1');
    expect(meta.filename).toBe('test.pdf');
    expect(meta.contentType).toBe('application/pdf');
    expect(meta.size).toBe(1024);
    expect(data).toBeInstanceOf(Buffer);
  });

  it('getAttachment throws if attachment not found', async () => {
    mockFetchMessages = [
      createMockMessage(42, { text: 'uid-42 body' }),
    ];
    await expect(adapter.getAttachment('42', 'nonexistent')).rejects.toThrow();
  });
});
