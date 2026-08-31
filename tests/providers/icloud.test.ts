import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ICloudAdapter } from '../../src/providers/icloud/adapter.js';
import { ProviderType } from '../../src/models/types.js';
import { ImapFlow } from 'imapflow';

const mockFolders = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', status: { messages: 5, unseen: 2 } },
  { path: 'Sent Messages', name: 'Sent Messages', specialUse: '\\Sent', status: { messages: 20, unseen: 0 } },
  { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', status: { messages: 1, unseen: 0 } },
  { path: 'Trash', name: 'Trash', specialUse: '\\Trash', status: { messages: 3, unseen: 0 } },
];

let capturedConfig: any = null;

let mockSearchImpl: (() => Promise<number[]>) | null = null;
let mockFetchImpl: ((range: any, opts: any) => Generator<any>) | null = null;
let mockStatusResult: any = { messages: -1 };
let mockMailboxExists = -1;

vi.mock('imapflow', () => {
  class MockImapFlow {
    connect = vi.fn().mockResolvedValue(undefined);
    logout = vi.fn().mockResolvedValue(undefined);
    list = vi.fn().mockResolvedValue(mockFolders);
    usable = true;
    on = vi.fn();
    mailbox: any = null;

    search = vi.fn().mockImplementation(() => {
      if (mockSearchImpl) return mockSearchImpl();
      return Promise.resolve([]);
    });
    noop = vi.fn().mockResolvedValue(undefined);
    status = vi.fn().mockImplementation(() => Promise.resolve(mockStatusResult));
    getMailboxLock = vi.fn().mockImplementation(() => {
      // Set mailbox.exists when lock is acquired (simulates SELECT)
      (this as any).mailbox = { exists: mockMailboxExists };
      return Promise.resolve({ release: vi.fn() });
    });
    fetch = vi.fn().mockImplementation(function* (range: any, opts: any) {
      if (mockFetchImpl) {
        yield* mockFetchImpl(range, opts);
      }
    });
    // ImapFlow.fetchAll() resolves to an array. The adapter uses it for body
    // fetches (a comma-joined UID list) and for the UID-collection fallback
    // (sequence ranges like '1:*'). Normalize a comma list to a UID array so
    // the test generators' Array.isArray branch fires, and surface generator
    // errors as a rejected promise to mirror real fetchAll behaviour.
    fetchAll = vi.fn().mockImplementation((range: any, opts: any) => {
      if (!mockFetchImpl) return Promise.resolve([]);
      const normalized =
        typeof range === 'string' && range.includes(',')
          ? range.split(',').map((n) => parseInt(n, 10))
          : range;
      try {
        return Promise.resolve([...mockFetchImpl(normalized, opts)]);
      } catch (err) {
        return Promise.reject(err);
      }
    });
    fetchOne = vi.fn().mockResolvedValue(null);
    messageMove = vi.fn().mockResolvedValue(undefined);
    messageDelete = vi.fn().mockResolvedValue(undefined);
    messageFlagsAdd = vi.fn().mockResolvedValue(undefined);
    messageFlagsRemove = vi.fn().mockResolvedValue(undefined);
    mailboxCreate = vi.fn().mockResolvedValue({ path: 'NewFolder', name: 'NewFolder' });
    append = vi.fn().mockResolvedValue({ uid: 100 });

    constructor(config: any) {
      capturedConfig = config;
    }
  }
  return { ImapFlow: MockImapFlow };
});

vi.mock('mailparser', () => ({
  simpleParser: vi.fn().mockResolvedValue({
    uid: 1,
    messageId: '<msg-1@icloud.com>',
    from: { value: [{ name: 'Alice', address: 'alice@icloud.com' }] },
    to: { value: [{ name: 'Bob', address: 'bob@test.com' }] },
    subject: 'Test',
    date: new Date('2026-01-15'),
    text: 'body',
    attachments: [],
    flags: new Set(),
  }),
}));

const { mockSendMail } = vi.hoisted(() => {
  const mockSendMail = vi.fn().mockResolvedValue({ messageId: '<sent-1@icloud.com>' });
  return { mockSendMail };
});
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: mockSendMail,
    }),
  },
}));

const icloudCredentials = {
  id: 'icloud-test',
  name: 'My iCloud',
  provider: 'icloud' as const,
  email: 'user@icloud.com',
  password: {
    password: 'app-specific-password',
    host: 'imap.mail.me.com',
    port: 993,
    tls: true,
  },
};

describe('ICloudAdapter', () => {
  let adapter: ICloudAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedConfig = null;
    mockSearchImpl = null;
    mockFetchImpl = null;
    mockStatusResult = { messages: -1 };
    mockMailboxExists = -1;
    adapter = new ICloudAdapter();
  });

  it('has icloud provider type', () => {
    expect(adapter.providerType).toBe(ProviderType.ICloud);
  });

  it('uses iCloud IMAP defaults when connecting', async () => {
    await adapter.connect({
      id: 'icloud-1',
      name: 'My iCloud',
      provider: 'icloud',
      email: 'user@icloud.com',
      password: {
        password: 'app-specific-password',
        host: 'imap.mail.me.com',
        port: 993,
        tls: true,
      },
    });

    expect(capturedConfig).toBeTruthy();
    expect(capturedConfig.host).toBe('imap.mail.me.com');
    expect(capturedConfig.port).toBe(993);
    expect(capturedConfig.secure).toBe(true);
    expect(capturedConfig.auth.user).toBe('user@icloud.com');
    expect(capturedConfig.auth.pass).toBe('app-specific-password');
  });

  it('sets iCloud defaults for host and port', async () => {
    await adapter.connect({
      id: 'icloud-2',
      name: 'My iCloud',
      provider: 'icloud',
      email: 'user@icloud.com',
      password: {
        password: 'app-specific-password',
        host: 'custom.host.com',
        port: 993,
        tls: true,
      },
    });

    // The user-provided host should be used (not overridden)
    expect(capturedConfig.host).toBe('custom.host.com');
  });

  it('provides iCloud SMTP defaults', async () => {
    await adapter.connect({
      id: 'icloud-3',
      name: 'My iCloud',
      provider: 'icloud',
      email: 'user@icloud.com',
      password: {
        password: 'app-specific-password',
        host: 'imap.mail.me.com',
        port: 993,
        tls: true,
      },
    });

    // passwordCreds should have SMTP defaults set
    const creds = (adapter as any).passwordCreds;
    expect(creds.smtpHost).toBe('smtp.mail.me.com');
    expect(creds.smtpPort).toBe(587);
  });

  it('connects and lists folders', async () => {
    await adapter.connect({
      id: 'icloud-4',
      name: 'My iCloud',
      provider: 'icloud',
      email: 'user@icloud.com',
      password: {
        password: 'app-specific-password',
        host: 'imap.mail.me.com',
        port: 993,
        tls: true,
      },
    });

    const result = await adapter.testConnection();
    expect(result.success).toBe(true);
    expect(result.folderCount).toBe(4);
  });

  it('inherits all IMAP methods', async () => {
    await adapter.connect({
      id: 'icloud-5',
      name: 'My iCloud',
      provider: 'icloud',
      email: 'user@icloud.com',
      password: {
        password: 'pass',
        host: 'imap.mail.me.com',
        port: 993,
        tls: true,
      },
    });

    // Should have all EmailProvider methods from ImapAdapter
    expect(typeof adapter.listFolders).toBe('function');
    expect(typeof adapter.search).toBe('function');
    expect(typeof adapter.getEmail).toBe('function');
    expect(typeof adapter.getThread).toBe('function');
    expect(typeof adapter.sendEmail).toBe('function');
    expect(typeof adapter.moveEmail).toBe('function');
    expect(typeof adapter.deleteEmail).toBe('function');
    expect(typeof adapter.markEmail).toBe('function');
    expect(typeof adapter.createFolder).toBe('function');
    expect(typeof adapter.createDraft).toBe('function');
    expect(typeof adapter.listDrafts).toBe('function');
    expect(typeof adapter.getAttachment).toBe('function');
  });
});

describe('ICloudAdapter iCloud Junk folder fallbacks', () => {
  let adapter: ICloudAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedConfig = null;
    mockSearchImpl = null;
    mockFetchImpl = null;
    mockStatusResult = { messages: -1 };
    mockMailboxExists = -1;
    adapter = new ICloudAdapter();
    await adapter.connect(icloudCredentials);
  });

  it('uses STATUS count when mailbox.exists is 0 but folder has messages', async () => {
    // iCloud reports EXISTS=0 after SELECT, but STATUS returns real count
    mockMailboxExists = 0;
    mockStatusResult = { messages: 13 };
    mockSearchImpl = () => Promise.resolve([101, 102, 103]);
    mockFetchImpl = function* (range: any) {
      if (Array.isArray(range)) {
        for (const uid of range) {
          yield {
            uid,
            flags: new Set(),
            envelope: {
              from: [{ name: 'Spam', address: 'spam@example.com' }],
              to: [{ name: 'User', address: 'user@icloud.com' }],
              cc: [], bcc: [],
              subject: `Junk message ${uid}`,
              date: new Date().toISOString(),
              messageId: `<msg-${uid}@example.com>`,
            },
          };
        }
      }
    };

    const results = await adapter.search({ folder: 'Junk' });
    expect(results).toHaveLength(3);

    // Verify search was called (not short-circuited by mailbox.exists=0)
    const client = (adapter as any).client;
    expect(client.search).toHaveBeenCalled();
  });

  it('falls back to FETCH when SEARCH fails with "Invalid message number"', async () => {
    mockMailboxExists = 13;
    mockStatusResult = { messages: 13 };
    // SEARCH throws "Invalid message number"
    mockSearchImpl = () => {
      const err: any = new Error('Command failed');
      err.responseText = 'Invalid message number';
      return Promise.reject(err);
    };
    // FETCH 1:* succeeds
    mockFetchImpl = function* (range: any) {
      if (range === '1:*' || typeof range === 'string') {
        for (let i = 1; i <= 3; i++) {
          yield { uid: 100 + i, flags: new Set() };
        }
      } else if (Array.isArray(range)) {
        for (const uid of range) {
          yield {
            uid,
            flags: new Set(),
            envelope: {
              from: [{ name: 'Spam', address: 'spam@example.com' }],
              to: [{ name: 'User', address: 'user@icloud.com' }],
              cc: [], bcc: [],
              subject: `Junk ${uid}`,
              date: new Date().toISOString(),
              messageId: `<msg-${uid}@example.com>`,
            },
          };
        }
      }
    };

    const results = await adapter.search({ folder: 'Junk' });
    expect(results).toHaveLength(3);
  });

  it('falls back to FETCH even with search criteria on "Invalid message number"', async () => {
    mockMailboxExists = 5;
    mockStatusResult = { messages: 5 };
    // SEARCH with criteria also throws "Invalid message number"
    mockSearchImpl = () => {
      const err: any = new Error('Command failed');
      err.responseText = 'Invalid message number';
      return Promise.reject(err);
    };
    mockFetchImpl = function* (range: any) {
      if (typeof range === 'string') {
        yield { uid: 201, flags: new Set() };
        yield { uid: 202, flags: new Set(['\\Seen']) };
      } else if (Array.isArray(range)) {
        for (const uid of range) {
          yield {
            uid,
            flags: new Set(),
            envelope: {
              from: [{ name: 'Test', address: 'test@example.com' }],
              to: [{ name: 'User', address: 'user@icloud.com' }],
              cc: [], bcc: [],
              subject: `Message ${uid}`,
              date: new Date().toISOString(),
              messageId: `<msg-${uid}@example.com>`,
            },
          };
        }
      }
    };

    // Search with criteria (from filter) — should still fallback
    const results = await adapter.search({ folder: 'Junk', from: 'test@example.com' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('falls back to individual fetch when FETCH 1:* also fails', async () => {
    mockMailboxExists = 3;
    mockStatusResult = { messages: 3 };
    mockSearchImpl = () => {
      const err: any = new Error('Command failed');
      err.responseText = 'Invalid message number';
      return Promise.reject(err);
    };

    let fetchCallCount = 0;
    mockFetchImpl = function* (range: any) {
      fetchCallCount++;
      if (range === '1:*') {
        // First fallback fails
        throw new Error('Invalid message number');
      }
      if (range === '1:3') {
        // Second fallback also fails
        throw new Error('Invalid message number');
      }
      // Individual sequence fetches succeed
      if (typeof range === 'string' && !range.includes(':') && !range.includes(',')) {
        const seq = parseInt(range);
        if (seq <= 3) {
          yield { uid: 300 + seq, flags: new Set() };
        }
      }
      if (Array.isArray(range)) {
        for (const uid of range) {
          yield {
            uid,
            flags: new Set(),
            envelope: {
              from: [{ name: 'Test', address: 'test@example.com' }],
              to: [{ name: 'User', address: 'user@icloud.com' }],
              cc: [], bcc: [],
              subject: `Message ${uid}`,
              date: new Date().toISOString(),
              messageId: `<msg-${uid}@example.com>`,
            },
          };
        }
      }
    };

    const results = await adapter.search({ folder: 'Junk' });
    expect(results).toHaveLength(3);
  });

  it('returns empty when both STATUS and mailbox.exists report 0', async () => {
    mockMailboxExists = 0;
    mockStatusResult = { messages: 0 };

    const results = await adapter.search({ folder: 'Junk' });
    expect(results).toHaveLength(0);

    // Verify no search was attempted
    const client = (adapter as any).client;
    expect(client.search).not.toHaveBeenCalled();
  });

  it('filters unread in FETCH fallback', async () => {
    mockMailboxExists = 5;
    mockStatusResult = { messages: 5 };
    mockSearchImpl = () => {
      const err: any = new Error('Command failed');
      err.responseText = 'Invalid message number';
      return Promise.reject(err);
    };
    mockFetchImpl = function* (range: any) {
      if (typeof range === 'string') {
        yield { uid: 401, flags: new Set() }; // unread
        yield { uid: 402, flags: new Set(['\\Seen']) }; // read — should be filtered
        yield { uid: 403, flags: new Set() }; // unread
      } else if (Array.isArray(range)) {
        for (const uid of range) {
          yield {
            uid,
            flags: new Set(),
            envelope: {
              from: [{ name: 'Test', address: 'test@example.com' }],
              to: [{ name: 'User', address: 'user@icloud.com' }],
              cc: [], bcc: [],
              subject: `Message ${uid}`,
              date: new Date().toISOString(),
              messageId: `<msg-${uid}@example.com>`,
            },
          };
        }
      }
    };

    const results = await adapter.search({ folder: 'Junk', unreadOnly: true });
    expect(results).toHaveLength(2);
  });
});
