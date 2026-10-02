import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from '../../src/account-manager.js';
import { registerForwardingTools, forwardAllowlist, FORWARD_ALLOWLIST_ENV } from '../../src/tools/forwarding.js';
import type { EmailProvider } from '../../src/providers/provider.js';
import type { ForwardRule } from '../../src/models/types.js';

// --- helpers ---

function makeMockProvider(overrides: Partial<EmailProvider> = {}): EmailProvider {
  return {
    providerType: 'gmail',
    createForwardRule: vi.fn().mockResolvedValue({ id: 'rule-1' }),
    listForwardRules: vi.fn().mockResolvedValue([] as ForwardRule[]),
    deleteForwardRule: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EmailProvider;
}

async function callTool(server: McpServer, toolName: string, args: Record<string, unknown>) {
  const tool = (server as any)._registeredTools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  const result = await (tool.handler as Function)(args, {});
  return JSON.parse(result.content[0].text);
}

const rule = {
  accountId: 'acct-1',
  matchType: 'senderDomain',
  value: 'anthropic.com',
  forwardTo: 'expenses@example.com',
};

// --- tests ---

describe('forwardAllowlist', () => {
  it('is empty when the variable is unset or blank', () => {
    expect(forwardAllowlist({})).toEqual([]);
    expect(forwardAllowlist({ [FORWARD_ALLOWLIST_ENV]: '  ,, ' })).toEqual([]);
  });

  it('splits on commas, trims and lowercases', () => {
    expect(forwardAllowlist({ [FORWARD_ALLOWLIST_ENV]: ' Expenses@Example.com, books@example.com ,' }))
      .toEqual(['expenses@example.com', 'books@example.com']);
  });
});

describe('Forwarding tools', () => {
  let server: McpServer;
  let mockProvider: EmailProvider;
  const saved = process.env[FORWARD_ALLOWLIST_ENV];

  function register(provider: EmailProvider) {
    mockProvider = provider;
    server = new McpServer({ name: 'test', version: '0.0.1' });
    registerForwardingTools(server, { getProvider: vi.fn().mockResolvedValue(provider) } as unknown as AccountManager);
  }

  beforeEach(() => {
    process.env[FORWARD_ALLOWLIST_ENV] = 'expenses@example.com';
    register(makeMockProvider());
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[FORWARD_ALLOWLIST_ENV];
    else process.env[FORWARD_ALLOWLIST_ENV] = saved;
  });

  describe('email_create_forward_rule', () => {
    it('creates a rule to an allowed address and keeps the original in the inbox by default', async () => {
      const parsed = await callTool(server, 'email_create_forward_rule', rule);

      expect(mockProvider.createForwardRule).toHaveBeenCalledWith({
        matchType: 'senderDomain',
        value: 'anthropic.com',
        forwardTo: 'expenses@example.com',
        keepInInbox: true,
      });
      expect(parsed).toEqual({ success: true, data: { id: 'rule-1', alreadyExisted: false } });
    });

    it('passes keepInInbox false through', async () => {
      await callTool(server, 'email_create_forward_rule', { ...rule, keepInInbox: false });
      expect(mockProvider.createForwardRule).toHaveBeenCalledWith(expect.objectContaining({ keepInInbox: false }));
    });

    it('matches the allowlist without regard to case', async () => {
      const parsed = await callTool(server, 'email_create_forward_rule', { ...rule, forwardTo: 'Expenses@Example.com' });
      expect(parsed.success).toBe(true);
    });

    it('refuses when no allowlist is set, and says how to set one', async () => {
      delete process.env[FORWARD_ALLOWLIST_ENV];
      const parsed = await callTool(server, 'email_create_forward_rule', rule);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Forwarding is switched off');
      expect(parsed.error).toContain(FORWARD_ALLOWLIST_ENV);
      expect(mockProvider.createForwardRule).not.toHaveBeenCalled();
    });

    it('refuses an address that is not on the allowlist, without calling the provider', async () => {
      const parsed = await callTool(server, 'email_create_forward_rule', { ...rule, forwardTo: 'someone@elsewhere.test' });

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('someone@elsewhere.test is not an allowed forwarding target');
      expect(parsed.allowedTargets).toEqual(['expenses@example.com']);
      expect(mockProvider.createForwardRule).not.toHaveBeenCalled();
    });

    it('does not accept an address that merely contains an allowed one', async () => {
      for (const forwardTo of ['expenses@example.com.evil.test', 'xexpenses@example.com']) {
        const parsed = await callTool(server, 'email_create_forward_rule', { ...rule, forwardTo });
        expect(parsed.success).toBe(false);
      }
      expect(mockProvider.createForwardRule).not.toHaveBeenCalled();
    });

    it('reports an existing identical rule instead of making a second one', async () => {
      register(makeMockProvider({ createForwardRule: vi.fn().mockResolvedValue({ id: 'rule-9', alreadyExisted: true }) }));
      const parsed = await callTool(server, 'email_create_forward_rule', rule);
      expect(parsed).toEqual({ success: true, data: { id: 'rule-9', alreadyExisted: true } });
    });

    it('says so on a provider without forwarding rules (IMAP, iCloud)', async () => {
      const imapLike = makeMockProvider({ providerType: 'imap' }) as any;
      delete imapLike.createForwardRule;
      register(imapLike);

      const parsed = await callTool(server, 'email_create_forward_rule', rule);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('not supported on this provider');
      expect(parsed.supportedProviders).toEqual(['gmail', 'outlook']);
    });

    it('passes the provider\'s explanation through (address not confirmed in Gmail)', async () => {
      register(makeMockProvider({
        createForwardRule: vi.fn().mockRejectedValue(new Error('expenses@example.com is not a forwarding address of this Gmail account yet.')),
      }));
      const parsed = await callTool(server, 'email_create_forward_rule', rule);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('not a forwarding address of this Gmail account yet');
    });

    it('tells the user to re-run the setup wizard when the sign-in lacks the permission', async () => {
      register(makeMockProvider({
        createForwardRule: vi.fn().mockRejectedValue(Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403 })),
      }));
      const parsed = await callTool(server, 'email_create_forward_rule', rule);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Re-run the setup wizard');
    });
  });

  describe('email_list_forward_rules', () => {
    it('returns the rules and the allowed targets', async () => {
      const rules: ForwardRule[] = [
        { id: 'f1', matchType: 'senderDomain', value: 'anthropic.com', forwardTo: 'expenses@example.com', keepInInbox: true, createdAt: '' },
      ];
      register(makeMockProvider({ listForwardRules: vi.fn().mockResolvedValue(rules) }));

      const parsed = await callTool(server, 'email_list_forward_rules', { accountId: 'acct-1' });
      expect(parsed).toEqual({ success: true, data: rules, allowedTargets: ['expenses@example.com'] });
    });

    it('works without an allowlist: auditing is always allowed', async () => {
      delete process.env[FORWARD_ALLOWLIST_ENV];
      const parsed = await callTool(server, 'email_list_forward_rules', { accountId: 'acct-1' });
      expect(parsed).toEqual({ success: true, data: [], allowedTargets: [] });
    });

    it('says so on a provider without forwarding rules', async () => {
      const imapLike = makeMockProvider() as any;
      delete imapLike.listForwardRules;
      register(imapLike);
      const parsed = await callTool(server, 'email_list_forward_rules', { accountId: 'acct-1' });
      expect(parsed.success).toBe(false);
      expect(parsed.supportedProviders).toEqual(['gmail', 'outlook']);
    });
  });

  describe('email_delete_forward_rule', () => {
    it('deletes by id, with or without an allowlist', async () => {
      delete process.env[FORWARD_ALLOWLIST_ENV];
      const parsed = await callTool(server, 'email_delete_forward_rule', { accountId: 'acct-1', ruleId: 'rule-1' });
      expect(mockProvider.deleteForwardRule).toHaveBeenCalledWith('rule-1');
      expect(parsed).toEqual({ success: true });
    });

    it('returns the provider\'s error for an id that is not a forwarding rule', async () => {
      register(makeMockProvider({ deleteForwardRule: vi.fn().mockRejectedValue(new Error('No forwarding rule with id nope on this account.')) }));
      const parsed = await callTool(server, 'email_delete_forward_rule', { accountId: 'acct-1', ruleId: 'nope' });
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('No forwarding rule with id nope');
    });

    it('says so on a provider without forwarding rules', async () => {
      const imapLike = makeMockProvider() as any;
      delete imapLike.deleteForwardRule;
      register(imapLike);
      const parsed = await callTool(server, 'email_delete_forward_rule', { accountId: 'acct-1', ruleId: 'rule-1' });
      expect(parsed.success).toBe(false);
    });
  });
});
