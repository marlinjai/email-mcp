import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from '../../src/account-manager.js';
import { registerOrganizingTools } from '../../src/tools/organizing.js';
import type { EmailProvider } from '../../src/providers/provider.js';
import type { Folder } from '../../src/models/types.js';

// --- helpers ---

function makeMockProvider(overrides: Partial<EmailProvider> = {}): EmailProvider {
  return {
    providerType: 'imap',
    connect: vi.fn(),
    disconnect: vi.fn(),
    testConnection: vi.fn(),
    listFolders: vi.fn(),
    createFolder: vi.fn().mockResolvedValue({
      id: 'new-folder-1',
      name: 'My Folder',
      path: 'My Folder',
      type: 'other',
    } satisfies Folder),
    search: vi.fn(),
    getEmail: vi.fn(),
    getThread: vi.fn(),
    getAttachment: vi.fn(),
    sendEmail: vi.fn(),
    createDraft: vi.fn(),
    listDrafts: vi.fn(),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    markEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EmailProvider;
}

function makeGmailProvider(): EmailProvider {
  return {
    ...makeMockProvider(),
    providerType: 'gmail',
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([
      { id: 'Label_1', name: 'Work', messageCount: 42 },
      { id: 'Label_2', name: 'Personal', messageCount: 10 },
    ]),
  } as unknown as EmailProvider;
}

function makeOutlookProvider(): EmailProvider {
  return {
    ...makeMockProvider(),
    providerType: 'outlook',
    getCategories: vi.fn().mockResolvedValue(['Blue category', 'Red category']),
  } as unknown as EmailProvider;
}

// Extract registered tool handlers from the McpServer
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

describe('Organizing tools', () => {
  let server: McpServer;
  let accountManager: AccountManager;
  let mockProvider: EmailProvider;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
    mockProvider = makeMockProvider();
    accountManager = {
      getProvider: vi.fn().mockResolvedValue(mockProvider),
    } as unknown as AccountManager;
    registerOrganizingTools(server, accountManager);
  });

  describe('email_move', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_move')).toBe(true);
    });

    it('calls provider.moveEmail with correct params', async () => {
      const result = await callTool(server, 'email_move', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        targetFolder: 'Archive',
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.moveEmail).toHaveBeenCalledWith('msg-1', 'Archive', undefined);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('returns error when provider throws', async () => {
      (mockProvider.moveEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Folder not found'),
      );

      const result = await callTool(server, 'email_move', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        targetFolder: 'Nonexistent',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Folder not found');
    });
  });

  describe('email_delete', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_delete')).toBe(true);
    });

    it('calls provider.deleteEmail without permanent flag by default', async () => {
      const result = await callTool(server, 'email_delete', {
        accountId: 'acct-1',
        emailId: 'msg-1',
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.deleteEmail).toHaveBeenCalledWith('msg-1', undefined, undefined);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('calls provider.deleteEmail with permanent flag', async () => {
      const result = await callTool(server, 'email_delete', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        permanent: true,
      });

      expect(mockProvider.deleteEmail).toHaveBeenCalledWith('msg-1', true, undefined);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('returns error when provider throws', async () => {
      (mockProvider.deleteEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Email not found'),
      );

      const result = await callTool(server, 'email_delete', {
        accountId: 'acct-1',
        emailId: 'msg-bad',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Email not found');
    });
  });

  describe('email_mark', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_mark')).toBe(true);
    });

    it('calls provider.markEmail with read flag', async () => {
      const result = await callTool(server, 'email_mark', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        read: true,
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.markEmail).toHaveBeenCalledWith('msg-1', { read: true }, undefined);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('calls provider.markEmail with starred flag', async () => {
      await callTool(server, 'email_mark', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        starred: true,
      });

      expect(mockProvider.markEmail).toHaveBeenCalledWith('msg-1', { starred: true }, undefined);
    });

    it('calls provider.markEmail with flagged flag', async () => {
      await callTool(server, 'email_mark', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        flagged: true,
      });

      expect(mockProvider.markEmail).toHaveBeenCalledWith('msg-1', { flagged: true }, undefined);
    });

    it('calls provider.markEmail with multiple flags', async () => {
      await callTool(server, 'email_mark', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        read: true,
        starred: true,
        flagged: false,
      });

      expect(mockProvider.markEmail).toHaveBeenCalledWith('msg-1', {
        read: true,
        starred: true,
        flagged: false,
      }, undefined);
    });

    it('returns error when provider throws', async () => {
      (mockProvider.markEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection lost'),
      );

      const result = await callTool(server, 'email_mark', {
        accountId: 'acct-1',
        emailId: 'msg-1',
        read: true,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Connection lost');
    });
  });

  describe('email_label', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_label')).toBe(true);
    });

    it('calls provider.addLabels when addLabels provided', async () => {
      const gmailProvider = makeGmailProvider();
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(gmailProvider);

      const result = await callTool(server, 'email_label', {
        accountId: 'acct-gmail',
        emailId: 'msg-1',
        addLabels: ['Work', 'Important'],
      });

      expect(gmailProvider.addLabels).toHaveBeenCalledWith('msg-1', ['Work', 'Important']);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('calls provider.removeLabels when removeLabels provided', async () => {
      const gmailProvider = makeGmailProvider();
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(gmailProvider);

      const result = await callTool(server, 'email_label', {
        accountId: 'acct-gmail',
        emailId: 'msg-1',
        removeLabels: ['Personal'],
      });

      expect(gmailProvider.removeLabels).toHaveBeenCalledWith('msg-1', ['Personal']);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('calls both addLabels and removeLabels when both provided', async () => {
      const gmailProvider = makeGmailProvider();
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(gmailProvider);

      const result = await callTool(server, 'email_label', {
        accountId: 'acct-gmail',
        emailId: 'msg-1',
        addLabels: ['Work'],
        removeLabels: ['Personal'],
      });

      expect(gmailProvider.addLabels).toHaveBeenCalledWith('msg-1', ['Work']);
      expect(gmailProvider.removeLabels).toHaveBeenCalledWith('msg-1', ['Personal']);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    });

    it('returns not supported for providers without addLabels/removeLabels', async () => {
      // Default mockProvider (imap) has no addLabels/removeLabels methods
      const result = await callTool(server, 'email_label', {
        accountId: 'acct-imap',
        emailId: 'msg-1',
        addLabels: ['Work'],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('email_label');
      expect(parsed.supportedProviders).toEqual(['gmail']);
    });
  });

  describe('email_batch_label', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_batch_label')).toBe(true);
    });

    it('uses provider.batchLabel when available', async () => {
      const gmailProvider = makeGmailProvider();
      (gmailProvider as any).batchLabel = vi.fn().mockResolvedValue({
        succeeded: ['msg-1', 'msg-2'],
        failed: [],
      });
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(gmailProvider);

      const result = await callTool(server, 'email_batch_label', {
        accountId: 'acct-gmail',
        emailIds: ['msg-1', 'msg-2'],
        addLabels: ['Work'],
        removeLabels: ['Personal'],
      });

      expect((gmailProvider as any).batchLabel).toHaveBeenCalledWith(['msg-1', 'msg-2'], ['Work'], ['Personal']);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.succeeded).toEqual(['msg-1', 'msg-2']);
      expect(parsed.failed).toEqual([]);
    });

    it('falls back to sequential addLabels/removeLabels when provider has no batchLabel', async () => {
      const gmailProvider = makeGmailProvider(); // no batchLabel method
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(gmailProvider);

      const result = await callTool(server, 'email_batch_label', {
        accountId: 'acct-gmail',
        emailIds: ['msg-1', 'msg-2'],
        addLabels: ['Work'],
      });

      expect(gmailProvider.addLabels).toHaveBeenCalledWith('msg-1', ['Work']);
      expect(gmailProvider.addLabels).toHaveBeenCalledWith('msg-2', ['Work']);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.succeeded).toEqual(['msg-1', 'msg-2']);
    });

    it('reports per-message failures in the sequential fallback', async () => {
      const gmailProvider = makeGmailProvider();
      (gmailProvider.addLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('failed'));
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(gmailProvider);

      const result = await callTool(server, 'email_batch_label', {
        accountId: 'acct-gmail',
        emailIds: ['msg-1', 'msg-2'],
        addLabels: ['Work'],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.succeeded).toEqual(['msg-2']);
      expect(parsed.failed).toEqual([{ id: 'msg-1', error: 'failed' }]);
    });

    it('returns not supported for providers without addLabels/removeLabels', async () => {
      const result = await callTool(server, 'email_batch_label', {
        accountId: 'acct-imap',
        emailIds: ['msg-1'],
        addLabels: ['Work'],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('email_batch_label');
      expect(parsed.supportedProviders).toEqual(['gmail']);
    });
  });

  describe('email_folder_create', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_folder_create')).toBe(true);
    });

    it('calls provider.createFolder with name only', async () => {
      const result = await callTool(server, 'email_folder_create', {
        accountId: 'acct-1',
        name: 'My Folder',
      });

      expect(accountManager.getProvider).toHaveBeenCalledWith('acct-1');
      expect(mockProvider.createFolder).toHaveBeenCalledWith('My Folder', undefined);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.data.name).toBe('My Folder');
    });

    it('calls provider.createFolder with parentPath', async () => {
      await callTool(server, 'email_folder_create', {
        accountId: 'acct-1',
        name: 'Sub Folder',
        parentPath: 'Parent',
      });

      expect(mockProvider.createFolder).toHaveBeenCalledWith('Sub Folder', 'Parent');
    });

    it('returns error when provider throws', async () => {
      (mockProvider.createFolder as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Folder already exists'),
      );

      const result = await callTool(server, 'email_folder_create', {
        accountId: 'acct-1',
        name: 'Duplicate',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Folder already exists');
    });
  });

  describe('email_get_labels', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_get_labels')).toBe(true);
    });

    it('calls provider.listLabels on Gmail accounts', async () => {
      const gmailProvider = makeGmailProvider();
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(gmailProvider);

      const result = await callTool(server, 'email_get_labels', {
        accountId: 'acct-gmail',
      });

      expect(gmailProvider.listLabels).toHaveBeenCalled();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toHaveLength(2);
      expect(parsed.data[0].name).toBe('Work');
      expect(parsed.data[1].name).toBe('Personal');
    });

    it('returns not supported for non-Gmail accounts', async () => {
      // Default mockProvider (imap) has no listLabels
      const result = await callTool(server, 'email_get_labels', {
        accountId: 'acct-imap',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('email_get_labels');
      expect(parsed.supportedProviders).toEqual(['gmail']);
    });
  });

  describe('email_get_categories', () => {
    it('is registered', () => {
      expect(hasRegisteredTool(server, 'email_get_categories')).toBe(true);
    });

    it('calls provider.getCategories on Outlook accounts', async () => {
      const outlookProvider = makeOutlookProvider();
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockResolvedValue(outlookProvider);

      const result = await callTool(server, 'email_get_categories', {
        accountId: 'acct-outlook',
      });

      expect(outlookProvider.getCategories).toHaveBeenCalled();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(['Blue category', 'Red category']);
    });

    it('returns not supported for non-Outlook accounts', async () => {
      // Default mockProvider (imap) has no getCategories
      const result = await callTool(server, 'email_get_categories', {
        accountId: 'acct-imap',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('email_get_categories');
      expect(parsed.supportedProviders).toEqual(['outlook']);
    });
  });

  describe('error handling', () => {
    it('returns error when account is not found', async () => {
      (accountManager.getProvider as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Account not found'),
      );

      const result = await callTool(server, 'email_move', {
        accountId: 'nonexistent',
        emailId: 'msg-1',
        targetFolder: 'Archive',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Account not found');
    });
  });
});
