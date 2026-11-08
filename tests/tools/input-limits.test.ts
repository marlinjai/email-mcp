import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AccountManager } from '../../src/account-manager.js';
import type { EmailProvider } from '../../src/providers/provider.js';
import { registerOrganizingTools } from '../../src/tools/organizing.js';
import { registerModerationTools } from '../../src/tools/moderation.js';
import { registerSendingTools } from '../../src/tools/sending.js';
import {
  MAX_ATTACHMENTS,
  MAX_BATCH_EMAIL_IDS,
  MAX_LABELS,
  MAX_RECIPIENTS,
} from '../../src/tools/limits.js';

/**
 * Every list a tool accepts is bounded. These tests go through a real MCP
 * client and server (the SDK validates arguments against the Zod schemas
 * before a handler runs), so they prove that an oversized list is refused
 * up front, quickly, and never reaches a provider.
 */

const ok = { succeeded: [], failed: [] };

function makeProvider(): EmailProvider {
  return {
    providerType: 'gmail',
    batchDelete: vi.fn().mockResolvedValue(ok),
    batchMove: vi.fn().mockResolvedValue(ok),
    batchMark: vi.fn().mockResolvedValue(ok),
    batchAddLabels: vi.fn().mockResolvedValue(ok),
    batchRemoveLabels: vi.fn().mockResolvedValue(ok),
    batchReportSpam: vi.fn().mockResolvedValue(ok),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    sendEmail: vi.fn().mockResolvedValue({ id: 'sent-1' }),
    getSignature: vi.fn().mockResolvedValue(null),
  } as unknown as EmailProvider;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
const contacts = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `r${i}@example.test` }));
const attachments = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ content: 'aGk=', filename: `f${i}.txt` }));

describe('tool input list limits (real MCP client and server)', () => {
  let client: Client;
  let server: McpServer;
  let provider: EmailProvider;
  let accountManager: AccountManager;

  beforeEach(async () => {
    provider = makeProvider();
    accountManager = { getProvider: vi.fn().mockResolvedValue(provider) } as unknown as AccountManager;
    server = new McpServer({ name: 'limits-test', version: '0.0.1' });
    registerOrganizingTools(server, accountManager);
    registerModerationTools(server, accountManager);
    registerSendingTools(server, accountManager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'limits-test-client', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  /** Calls a tool and reports whether the SDK refused the arguments. */
  async function call(name: string, args: Record<string, unknown>) {
    const started = performance.now();
    let refused = false;
    let message = '';
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      if (result.isError) {
        refused = true;
        message = result.content?.map((c) => c.text ?? '').join(' ') ?? '';
      }
    } catch (error) {
      refused = true;
      message = (error as Error).message;
    }
    return { refused, message, ms: performance.now() - started };
  }

  const batchTools: Array<[string, Record<string, unknown>]> = [
    ['email_batch_delete', {}],
    ['email_batch_move', { targetFolder: 'Archive' }],
    ['email_batch_mark', { read: true }],
    ['email_batch_label', { addLabels: ['Work'] }],
    ['email_batch_report_spam', {}],
  ];

  it.each(batchTools)('%s refuses more than MAX_BATCH_EMAIL_IDS ids quickly, without a provider call', async (name, extra) => {
    const { refused, message, ms } = await call(name, {
      accountId: 'acct-1',
      emailIds: ids(MAX_BATCH_EMAIL_IDS + 1),
      ...extra,
    });
    expect(refused).toBe(true);
    expect(message).toMatch(/emailIds/);
    expect(ms).toBeLessThan(1000);
    expect(accountManager.getProvider).not.toHaveBeenCalled();
  });

  it('email_transfer refuses more than MAX_BATCH_EMAIL_IDS ids', async () => {
    const { refused } = await call('email_transfer', {
      sourceAccountId: 'a',
      targetAccountId: 'b',
      emailIds: ids(MAX_BATCH_EMAIL_IDS + 1),
    });
    expect(refused).toBe(true);
    expect(accountManager.getProvider).not.toHaveBeenCalled();
  });

  it('accepts exactly MAX_BATCH_EMAIL_IDS ids', async () => {
    const { refused } = await call('email_batch_delete', { accountId: 'acct-1', emailIds: ids(MAX_BATCH_EMAIL_IDS) });
    expect(refused).toBe(false);
    expect(provider.batchDelete).toHaveBeenCalledWith(ids(MAX_BATCH_EMAIL_IDS), undefined, undefined);
  });

  it('still refuses an empty id list', async () => {
    const { refused } = await call('email_batch_delete', { accountId: 'acct-1', emailIds: [] });
    expect(refused).toBe(true);
  });

  it('email_label refuses more than MAX_LABELS labels', async () => {
    const { refused, message } = await call('email_label', {
      accountId: 'acct-1',
      emailId: 'm1',
      addLabels: ids(MAX_LABELS + 1),
    });
    expect(refused).toBe(true);
    expect(message).toMatch(/addLabels/);
    expect(accountManager.getProvider).not.toHaveBeenCalled();
  });

  it.each(['to', 'cc', 'bcc'])('email_send refuses more than MAX_RECIPIENTS in %s', async (field) => {
    const args: Record<string, unknown> = {
      accountId: 'acct-1',
      to: contacts(1),
      subject: 's',
      body: { text: 'b' },
      [field]: contacts(MAX_RECIPIENTS + 1),
    };
    const { refused, message, ms } = await call('email_send', args);
    expect(refused).toBe(true);
    expect(message).toContain(field);
    expect(ms).toBeLessThan(1000);
    expect(provider.sendEmail).not.toHaveBeenCalled();
  });

  it('email_reply refuses more than MAX_RECIPIENTS additional recipients', async () => {
    const { refused } = await call('email_reply', {
      accountId: 'acct-1',
      emailId: 'm1',
      body: { text: 'b' },
      additionalRecipients: contacts(MAX_RECIPIENTS + 1),
    });
    expect(refused).toBe(true);
    expect(accountManager.getProvider).not.toHaveBeenCalled();
  });

  it('email_draft_create refuses more than MAX_ATTACHMENTS attachments', async () => {
    const { refused, message } = await call('email_draft_create', {
      accountId: 'acct-1',
      to: contacts(1),
      subject: 's',
      body: { text: 'b' },
      attachments: attachments(MAX_ATTACHMENTS + 1),
    });
    expect(refused).toBe(true);
    expect(message).toMatch(/attachments/);
    expect(accountManager.getProvider).not.toHaveBeenCalled();
  });

  it('accepts MAX_RECIPIENTS recipients', async () => {
    const { refused } = await call('email_send', {
      accountId: 'acct-1',
      to: contacts(MAX_RECIPIENTS),
      subject: 's',
      body: { text: 'b' },
      signature: false,
    });
    expect(refused).toBe(false);
    expect(provider.sendEmail).toHaveBeenCalledTimes(1);
  });
});
