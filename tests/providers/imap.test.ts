import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapAdapter } from '../../src/providers/imap/adapter.js';
import { mapParsedEmail } from '../../src/providers/imap/mapper.js';
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
    on = vi.fn();

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

    // ImapFlow.fetchAll() resolves to an array (used by the adapter for body
    // fetches and the UID-collection fallback). The adapter passes a
    // comma-joined UID list for body fetches and a sequence range (e.g. '1:*')
    // for the fallback, so mirror that here: filter by UID for a comma list,
    // otherwise return every message.
    fetchAll = vi.fn().mockImplementation((range: number[] | string) => {
      let uidSet: Set<number> | null = null;
      if (Array.isArray(range)) {
        uidSet = new Set(range);
      } else if (typeof range === 'string' && range.includes(',')) {
        uidSet = new Set(range.split(',').map((n) => parseInt(n, 10)));
      }
      const out: any[] = [];
      for (const msg of mockFetchMessages) {
        if (!uidSet || uidSet.has(msg.uid)) {
          out.push(msg);
        }
      }
      return Promise.resolve(out);
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
        to: [{ name: 'Bob', address: 'bob@test.com' }],
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
        cc: ['cc@test.com'],
        bcc: ['bcc@test.com'],
      })
    );
  });

  it('sendEmail derives a text part when only html is given', async () => {
    await adapter.sendEmail({
      to: [{ email: 'bob@test.com' }],
      subject: 'HTML only',
      body: { html: '<p>Hello <i>Bob</i></p>' },
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello Bob', html: '<p>Hello <i>Bob</i></p>' }),
    );
  });

  it('sendEmail sends text only when only text is given', async () => {
    await adapter.sendEmail({ to: [{ email: 'bob@test.com' }], subject: 'Plain', body: { text: 'Just text' } });
    const mail = mockSendMail.mock.calls.at(-1)![0];
    expect(mail.text).toBe('Just text');
    expect(mail.html).toBeUndefined();
  });

  it('sendEmail passes display names as address objects so commas and quotes stay intact', async () => {
    await adapter.sendEmail({
      to: [{ name: 'Müller, Hans', email: 'hans@test.com' }],
      cc: [{ name: 'Anna "Ann" Schmidt', email: 'anna@test.com' }],
      subject: 'Names',
      body: { text: 'x' },
    });
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ name: 'Müller, Hans', address: 'hans@test.com' }],
        cc: [{ name: 'Anna "Ann" Schmidt', address: 'anna@test.com' }],
      }),
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

  it('getThread looks in INBOX when no sourceFolder is given', async () => {
    const thread = await adapter.getThread('<msg-1@example.com>');
    const client = (adapter as any).client;
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(thread.messages.every((m) => m.folder === 'INBOX')).toBe(true);
  });

  it('getThread looks in the resolved sourceFolder and reports it on the messages', async () => {
    const thread = await adapter.getThread('<msg-1@example.com>', 'sent');
    const client = (adapter as any).client;
    expect(client.getMailboxLock).toHaveBeenCalledWith('Sent');
    expect(client.getMailboxLock).not.toHaveBeenCalledWith('INBOX');
    expect(thread.messages.length).toBeGreaterThan(0);
    expect(thread.messages.every((m) => m.folder === 'Sent')).toBe(true);
    expect(mockMailboxLockRelease).toHaveBeenCalled();
  });

  it('getThread names the folder when the thread is not in it', async () => {
    mockSearchResult = [];
    await expect(adapter.getThread('<nope@example.com>', 'Sent')).rejects.toThrow('Thread <nope@example.com> not found in "Sent"');
    expect(mockMailboxLockRelease).toHaveBeenCalled();
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
      expect.any(Buffer),
      expect.arrayContaining(['\\Draft', '\\Seen']),
    );
  });

  it('updateDraft deletes the old revision and appends a new one, returning a new id', async () => {
    const result = await adapter.updateDraft('99', {
      to: [{ email: 'bob@test.com' }],
      subject: 'Updated subject',
      body: { text: 'Updated body' },
    });
    expect(result.id).toBe('100'); // mocked append always resolves { uid: 100 }
    const client = (adapter as any).client;
    expect(client.getMailboxLock).toHaveBeenCalledWith('Drafts');
    expect(client.messageDelete).toHaveBeenCalledWith('99', { uid: true });
    expect(client.append).toHaveBeenCalledWith(
      'Drafts',
      expect.any(Buffer),
      expect.arrayContaining(['\\Draft', '\\Seen']),
    );
    expect(client.append.mock.calls[0][1].toString()).toContain('Subject: Updated subject');
  });

  it('createDraft stores both the text and the html part, Bcc and encoded headers', async () => {
    const { simpleParser: parse } = await vi.importActual<typeof import('mailparser')>('mailparser');
    await adapter.createDraft({
      to: [{ name: 'Müller, Hans', email: 'hans@test.com' }],
      bcc: [{ email: 'hidden@test.com' }],
      subject: 'Entwurf für Jürgen ✉️',
      body: { text: 'Plain part', html: '<p>HTML <b>part</b></p>' },
    });
    const client = (adapter as any).client;
    const parsed = await parse(client.append.mock.calls[0][1]);
    expect(parsed.text?.trim()).toBe('Plain part');
    expect(parsed.html).toContain('<p>HTML <b>part</b></p>');
    expect(parsed.subject).toBe('Entwurf für Jürgen ✉️');
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    expect(to?.value).toEqual([{ name: 'Müller, Hans', address: 'hans@test.com' }]);
    const bcc = Array.isArray(parsed.bcc) ? parsed.bcc[0] : parsed.bcc;
    expect(bcc?.value[0].address).toBe('hidden@test.com');
  });

  it('createDraft with html only stores the html and a derived text part (it used to be empty)', async () => {
    const { simpleParser: parse } = await vi.importActual<typeof import('mailparser')>('mailparser');
    await adapter.createDraft({
      to: [{ email: 'bob@test.com' }],
      subject: 'HTML only',
      body: { html: '<p>Hello <i>Bob</i></p>' },
    });
    const client = (adapter as any).client;
    const parsed = await parse(client.append.mock.calls[0][1]);
    expect(parsed.html).toContain('<p>Hello <i>Bob</i></p>');
    expect(parsed.text?.trim()).toBe('Hello Bob');
  });

  it('updateDraft keeps the old revision when building the new message fails', async () => {
    vi.spyOn(adapter as any, 'buildDraftMessage').mockRejectedValueOnce(new Error('MIME build failed'));
    await expect(adapter.updateDraft('99', {
      to: [{ email: 'bob@test.com' }],
      subject: 'Rev 2',
      body: { text: 'Plain v2' },
    })).rejects.toThrow('MIME build failed');
    const client = (adapter as any).client;
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(client.append).not.toHaveBeenCalled();
  });

  it('updateDraft stores both parts in the new revision', async () => {
    const { simpleParser: parse } = await vi.importActual<typeof import('mailparser')>('mailparser');
    await adapter.updateDraft('99', {
      to: [{ email: 'bob@test.com' }],
      subject: 'Rev 2',
      body: { text: 'Plain v2', html: '<p>HTML v2</p>' },
      inReplyTo: '<orig@test.com>',
      references: ['<orig@test.com>'],
    });
    const client = (adapter as any).client;
    const parsed = await parse(client.append.mock.calls[0][1]);
    expect(parsed.text?.trim()).toBe('Plain v2');
    expect(parsed.html).toContain('<p>HTML v2</p>');
    expect(parsed.inReplyTo).toBe('<orig@test.com>');
    expect(parsed.references).toBe('<orig@test.com>');
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
      expect.any(Buffer),
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
      expect.any(Buffer),
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

  describe('getAttachment ids and folders', () => {
    // Three attachments: only the middle one has a Content-ID, so the mapper
    // lists them as att-0, <logo@x>, att-2.
    const parsedWithAttachments = () => ({
      ...createParsedEmail(42),
      attachments: [
        { filename: 'a.pdf', contentType: 'application/pdf', size: 1, content: Buffer.from('A') },
        { contentId: '<logo@x>', filename: 'logo.png', contentType: 'image/png', size: 1, content: Buffer.from('L') },
        { contentType: 'application/zip', size: 1, content: Buffer.from('Z') },
      ],
    });

    // Queues the parse result for the one message the next call reads. Only
    // called by tests that get as far as parsing, so nothing is left queued.
    async function parsesTo(parsed: unknown) {
      const { simpleParser: mockParser } = await import('mailparser');
      (mockParser as any).mockResolvedValueOnce(parsed);
    }

    beforeEach(() => {
      mockFetchMessages = [createMockMessage(42, { text: 'uid-42 body' })];
    });

    it('every id the mapper hands out resolves to the same attachment', async () => {
      const listed = mapParsedEmail(parsedWithAttachments(), 'INBOX', 'test-1', 42).attachments;
      expect(listed.map((a) => a.id)).toEqual(['att-0', '<logo@x>', 'att-2']);

      const contents: string[] = [];
      for (const att of listed) {
        await parsesTo(parsedWithAttachments());
        const { data, meta } = await adapter.getAttachment('42', att.id);
        expect(meta.id).toBe(att.id);
        contents.push(data.toString());
      }
      expect(contents).toEqual(['A', 'L', 'Z']);
    });

    it('resolves att-N by position for an attachment without a Content-ID or file name', async () => {
      await parsesTo(parsedWithAttachments());
      const { data, meta } = await adapter.getAttachment('42', 'att-2');
      expect(data.toString()).toBe('Z');
      expect(meta).toEqual({ id: 'att-2', filename: 'attachment', contentType: 'application/zip', size: 1 });
    });

    it('still resolves by file name', async () => {
      await parsesTo(parsedWithAttachments());
      const { data, meta } = await adapter.getAttachment('42', 'logo.png');
      expect(data.toString()).toBe('L');
      expect(meta.id).toBe('<logo@x>');
    });

    it('does not resolve att-N to an attachment that is listed under its Content-ID', async () => {
      await parsesTo(parsedWithAttachments());
      await expect(adapter.getAttachment('42', 'att-1')).rejects.toThrow('Attachment att-1 not found in email 42');
    });

    it('rejects a position past the last attachment', async () => {
      await parsesTo(parsedWithAttachments());
      await expect(adapter.getAttachment('42', 'att-3')).rejects.toThrow('Attachment att-3 not found in email 42');
    });

    it('opens INBOX when no sourceFolder is given', async () => {
      await parsesTo(parsedWithAttachments());
      await adapter.getAttachment('42', 'att-0');
      expect((adapter as any).client.getMailboxLock).toHaveBeenCalledWith('INBOX');
    });

    it('opens the resolved sourceFolder for a message outside INBOX', async () => {
      await parsesTo(parsedWithAttachments());
      await adapter.getAttachment('42', 'att-0', 'sent');
      const client = (adapter as any).client;
      expect(client.getMailboxLock).toHaveBeenCalledWith('Sent');
      expect(client.getMailboxLock).not.toHaveBeenCalledWith('INBOX');
      expect(mockMailboxLockRelease).toHaveBeenCalled();
    });

    it('names the folder when the message is not in it', async () => {
      mockFetchMessages = [];
      await expect(adapter.getAttachment('42', 'att-0', 'Sent')).rejects.toThrow('Email 42 not found in "Sent"');
      expect(mockMailboxLockRelease).toHaveBeenCalled();
    });

    it('getEmail opens the resolved sourceFolder as well', async () => {
      await parsesTo(parsedWithAttachments());
      const email = await adapter.getEmail('42', 'sent');
      expect((adapter as any).client.getMailboxLock).toHaveBeenCalledWith('Sent');
      expect(email.folder).toBe('Sent');
      expect(email.attachments.map((a) => a.id)).toEqual(['att-0', '<logo@x>', 'att-2']);
    });
  });

  describe('updateDraft keeps a reply draft in its thread', () => {
    const update = { to: [{ email: 'bob@test.com' }], subject: 'Re: Thread', body: { text: 'Second version' } };

    async function storedDraft(threading: Record<string, unknown>) {
      mockFetchMessages = [createMockMessage(99, { text: 'uid-99 body' })];
      const { simpleParser: mockParser } = await import('mailparser');
      (mockParser as any).mockResolvedValueOnce({ ...createParsedEmail(99), ...threading });
    }

    async function appended() {
      const { simpleParser: parse } = await vi.importActual<typeof import('mailparser')>('mailparser');
      return parse((adapter as any).client.append.mock.calls[0][1]);
    }

    it('carries In-Reply-To and References of the old revision into the new one', async () => {
      await storedDraft({ inReplyTo: '<orig@test.com>', references: ['<root@test.com>', '<orig@test.com>'] });

      await adapter.updateDraft('99', update);

      const client = (adapter as any).client;
      expect(client.fetchOne).toHaveBeenCalledWith('99', { source: true, uid: true }, { uid: true });
      const parsed = await appended();
      expect(parsed.inReplyTo).toBe('<orig@test.com>');
      expect(parsed.references).toEqual(['<root@test.com>', '<orig@test.com>']);
      expect(parsed.text?.trim()).toBe('Second version');
      // The old revision is read before it is deleted.
      expect(client.fetchOne.mock.invocationCallOrder[0]).toBeLessThan(client.messageDelete.mock.invocationCallOrder[0]);
    });

    it('carries a single References value (mailparser gives a string then)', async () => {
      await storedDraft({ inReplyTo: '<orig@test.com>', references: '<orig@test.com>' });
      await adapter.updateDraft('99', update);
      const parsed = await appended();
      expect(parsed.inReplyTo).toBe('<orig@test.com>');
      expect(parsed.references).toBe('<orig@test.com>');
    });

    it('carries In-Reply-To alone when the old revision has no References', async () => {
      await storedDraft({ inReplyTo: '<orig@test.com>' });
      await adapter.updateDraft('99', update);
      const parsed = await appended();
      expect(parsed.inReplyTo).toBe('<orig@test.com>');
      expect(parsed.references).toBeUndefined();
    });

    it('a draft that is not a reply stays without reply headers', async () => {
      await storedDraft({});
      await adapter.updateDraft('99', update);
      const parsed = await appended();
      expect(parsed.inReplyTo).toBeUndefined();
      expect(parsed.references).toBeUndefined();
    });

    it('the caller\'s inReplyTo wins and the old revision is not read', async () => {
      await adapter.updateDraft('99', { ...update, inReplyTo: '<other@test.com>', references: ['<other@test.com>'] });
      expect((adapter as any).client.fetchOne).not.toHaveBeenCalled();
      expect((await appended()).inReplyTo).toBe('<other@test.com>');
    });

    it('still writes the new revision when the old one is gone', async () => {
      mockFetchMessages = [];
      const result = await adapter.updateDraft('99', update);
      expect(result.id).toBe('100');
      expect((await appended()).inReplyTo).toBeUndefined();
    });

    it('leaves the old revision alone when it cannot be read', async () => {
      const client = (adapter as any).client;
      client.fetchOne.mockRejectedValueOnce(new Error('connection lost'));
      await expect(adapter.updateDraft('99', update)).rejects.toThrow('connection lost');
      expect(client.messageDelete).not.toHaveBeenCalled();
      expect(client.append).not.toHaveBeenCalled();
      expect(mockMailboxLockRelease).toHaveBeenCalled();
    });

    it('reads the old revision from the given sourceFolder', async () => {
      await storedDraft({ inReplyTo: '<orig@test.com>' });
      await adapter.updateDraft('99', update, 'Sent');
      const client = (adapter as any).client;
      expect(client.getMailboxLock).toHaveBeenCalledWith('Sent');
      expect(client.append.mock.calls[0][0]).toBe('Sent');
      expect((await appended()).inReplyTo).toBe('<orig@test.com>');
    });
  });
});

describe('mapParsedEmail headers', () => {
  it('maps header lines to their values, without the header name and unfolded', async () => {
    const { simpleParser: parse } = await vi.importActual<typeof import('mailparser')>('mailparser');
    const parsed = await parse(Buffer.from(
      'Message-ID: <abc@x>\r\nReferences: <r1@x>\r\n <r2@x>\r\nIn-Reply-To: <r2@x>\r\nSubject: Time: 10:30\r\n\r\nbody',
    ));
    const email = mapParsedEmail(parsed, 'INBOX', 'test-1', 7);
    expect(email.headers).toMatchObject({
      'message-id': '<abc@x>',
      references: '<r1@x> <r2@x>',
      'in-reply-to': '<r2@x>',
      subject: 'Time: 10:30',
    });
  });
});
