import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from '../../src/account-manager.js';
import { registerAccountTools } from '../../src/tools/accounts.js';
import type { Account } from '../../src/models/types.js';

// --- helpers ---

function getRegisteredTools(server: McpServer): Record<string, { handler: Function }> {
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

describe('Account tools', () => {
  let server: McpServer;
  let accountManager: AccountManager;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
    accountManager = {
      listAccounts: vi.fn(),
      addAccount: vi.fn(),
      removeAccount: vi.fn(),
      testAccount: vi.fn(),
      getProvider: vi.fn(),
    } as unknown as AccountManager;
    registerAccountTools(server, accountManager);
  });

  describe('email_list_accounts', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_list_accounts')).toBe(true);
    });

    it('returns list of accounts from AccountManager', async () => {
      const accounts: Account[] = [
        { id: 'gmail-1', name: 'My Gmail', provider: 'gmail', email: 'test@gmail.com', connected: true },
        { id: 'icloud-1', name: 'My iCloud', provider: 'icloud', email: 'test@icloud.com', connected: false },
      ];
      (accountManager.listAccounts as ReturnType<typeof vi.fn>).mockResolvedValue(accounts);

      const result = await callTool(server, 'email_list_accounts', {});

      expect(accountManager.listAccounts).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe('gmail-1');
      expect(parsed[0].provider).toBe('gmail');
      expect(parsed[0].connected).toBe(true);
      expect(parsed[1].id).toBe('icloud-1');
      expect(parsed[1].connected).toBe(false);
    });

    it('returns empty array when no accounts exist', async () => {
      (accountManager.listAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await callTool(server, 'email_list_accounts', {});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });
  });

  describe('email_add_account', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_add_account')).toBe(true);
    });

    it('adds an IMAP account with password credentials', async () => {
      (accountManager.addAccount as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await callTool(server, 'email_add_account', {
        provider: 'imap',
        name: 'Work Email',
        email: 'user@work.com',
        password: 'secret123',
        host: 'imap.work.com',
        port: 993,
        tls: true,
      });

      expect(accountManager.addAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Work Email',
          provider: 'imap',
          email: 'user@work.com',
          password: expect.objectContaining({
            password: 'secret123',
            host: 'imap.work.com',
            port: 993,
            tls: true,
          }),
        }),
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.accountId).toBeDefined();
    });

    it('adds an iCloud account with defaults', async () => {
      (accountManager.addAccount as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const result = await callTool(server, 'email_add_account', {
        provider: 'icloud',
        name: 'My iCloud',
        email: 'user@icloud.com',
        password: 'app-specific-password',
      });

      expect(accountManager.addAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'icloud',
          email: 'user@icloud.com',
          password: expect.objectContaining({
            password: 'app-specific-password',
            host: 'imap.mail.me.com',
            port: 993,
            tls: true,
          }),
        }),
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('includes smtp settings when provided', async () => {
      (accountManager.addAccount as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await callTool(server, 'email_add_account', {
        provider: 'imap',
        name: 'Custom',
        email: 'user@custom.com',
        password: 'pass',
        host: 'imap.custom.com',
        port: 993,
        tls: true,
        smtpHost: 'smtp.custom.com',
        smtpPort: 587,
      });

      expect(accountManager.addAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          password: expect.objectContaining({
            smtpHost: 'smtp.custom.com',
            smtpPort: 587,
          }),
        }),
      );
    });

    it('returns error for unsupported provider (gmail needs OAuth)', async () => {
      const result = await callTool(server, 'email_add_account', {
        provider: 'gmail',
        name: 'Gmail',
        email: 'user@gmail.com',
        password: 'pass',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain('OAuth');
    });

    it('returns error for unsupported provider (outlook needs OAuth)', async () => {
      const result = await callTool(server, 'email_add_account', {
        provider: 'outlook',
        name: 'Outlook',
        email: 'user@outlook.com',
        password: 'pass',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain('OAuth');
    });

    it('returns error when addAccount fails', async () => {
      (accountManager.addAccount as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection refused'),
      );

      const result = await callTool(server, 'email_add_account', {
        provider: 'imap',
        name: 'Bad',
        email: 'user@bad.com',
        password: 'pass',
        host: 'imap.bad.com',
        port: 993,
        tls: true,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Connection refused');
    });
  });

  describe('email_remove_account', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_remove_account')).toBe(true);
    });

    it('removes account by id and reports the revocation outcome', async () => {
      (accountManager.removeAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        accountId: 'gmail-1',
        provider: 'gmail',
        email: 'test@gmail.com',
        revocation: { status: 'failed', detail: 'Google refused the revocation (HTTP 400)' },
      });

      const result = await callTool(server, 'email_remove_account', {
        accountId: 'gmail-1',
      });

      expect(accountManager.removeAccount).toHaveBeenCalledWith('gmail-1');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.revocation.status).toBe('failed');
      expect(parsed.revocation.detail).toContain('HTTP 400');
    });

    it('passes the Outlook token-cache and Microsoft consent-page note through', async () => {
      (accountManager.removeAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        accountId: 'outlook-1',
        provider: 'outlook',
        email: 'a@outlook.com',
        tokenCache: { status: 'removed', detail: 'removed' },
        revocation: { status: 'local_only', detail: 'remove email-mcp at https://account.live.com/consent/Manage.' },
      });

      const result = await callTool(server, 'email_remove_account', { accountId: 'outlook-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tokenCache.status).toBe('removed');
      expect(parsed.revocation.detail).toContain('account.live.com/consent/Manage');
    });

    it('returns error when removal fails', async () => {
      (accountManager.removeAccount as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Account not found'),
      );

      const result = await callTool(server, 'email_remove_account', {
        accountId: 'nonexistent',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Account not found');
    });
  });

  describe('email_test_account', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_test_account')).toBe(true);
    });

    it('tests account connection successfully', async () => {
      (accountManager.testAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        folderCount: 7,
      });

      const result = await callTool(server, 'email_test_account', {
        accountId: 'icloud-1',
      });

      expect(accountManager.testAccount).toHaveBeenCalledWith('icloud-1');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.folderCount).toBe(7);
    });

    it('returns failure details when connection fails', async () => {
      (accountManager.testAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        folderCount: 0,
        error: 'Authentication failed',
      });

      const result = await callTool(server, 'email_test_account', {
        accountId: 'bad-account',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Authentication failed');
    });

    it('handles unexpected errors', async () => {
      (accountManager.testAccount as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await callTool(server, 'email_test_account', {
        accountId: 'icloud-1',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Network error');
    });
  });
});

describe('Server creation', () => {
  it('createServer returns server and accountManager', async () => {
    const { createServer } = await import('../../src/server.js');
    const result = await createServer();
    expect(result.server).toBeDefined();
    expect(result.accountManager).toBeDefined();
  });

  it('createServer accepts custom accountManager', async () => {
    const { createServer } = await import('../../src/server.js');
    const customManager = {
      listAccounts: vi.fn(),
    } as unknown as AccountManager;

    const result = await createServer(customManager);
    expect(result.accountManager).toBe(customManager);
  });

  it('registers account tools on the server', async () => {
    const { createServer } = await import('../../src/server.js');
    const result = await createServer();
    const tools = (result.server as any)._registeredTools;

    expect('email_list_accounts' in tools).toBe(true);
    expect('email_add_account' in tools).toBe(true);
    expect('email_remove_account' in tools).toBe(true);
    expect('email_test_account' in tools).toBe(true);
  });
});
