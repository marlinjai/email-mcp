import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import type { AccountManager } from '../src/account-manager.js';

const openConnections: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of openConnections.splice(0)) await close();
  vi.unstubAllEnvs();
});

/** Connect an in-memory MCP client to a fake provider and register both endpoints for cleanup. */
async function connect() {
  const sendEmail = vi.fn().mockResolvedValue({ id: 'sent-test' });
  const getProvider = vi.fn().mockResolvedValue({ sendEmail });
  const manager = { getProvider, listAccounts: vi.fn().mockResolvedValue([]) } as unknown as AccountManager;
  const { server } = await createServer(manager);
  const client = new Client({ name: 'offline-policy-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push(async () => { await client.close(); await server.close(); });
  return { client, getProvider, sendEmail };
}

const message = { accountId: 'allowed', to: [{ email: 'recipient@example.com' }], subject: 'Test', body: { text: 'Test' } };

describe('MCP capability boundary', () => {
  it('defaults to reading and rejects direct calls to disabled tools before any account access', async () => {
    vi.stubEnv('EMAIL_MCP_ALLOWED_TOOLS', undefined);
    const { client, getProvider } = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('email_get');
    expect(names).toContain('email_list_accounts');
    for (const name of ['email_send', 'email_reply', 'email_forward', 'email_delete', 'email_save_attachment', 'email_add_account', 'email_remove_account', 'email_create_forward_rule']) {
      expect(names).not.toContain(name);
      const result = await client.callTool({ name, arguments: message });
      expect(result.isError).toBe(true);
    }
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('exposes only exact operator-allowed tools, and permits an explicitly enabled send', async () => {
    vi.stubEnv('EMAIL_MCP_ALLOWED_TOOLS', 'email_list_accounts, email_send');
    const { client, sendEmail } = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(['email_list_accounts', 'email_send']);
    const result = await client.callTool({ name: 'email_send', arguments: message });
    expect(result.isError).not.toBe(true);
    expect(sendEmail).toHaveBeenCalledOnce();
    // Changing the environment does not silently expose more tools mid-session.
    vi.stubEnv('EMAIL_MCP_ALLOWED_TOOLS', 'email_delete');
    expect((await client.callTool({ name: 'email_delete', arguments: { accountId: 'allowed', emailId: 'x' } })).isError).toBe(true);
  });
});
