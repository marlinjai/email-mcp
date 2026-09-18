import { z } from 'zod';
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../account-manager.js';
import type { AccountCredentials, ProviderTypeValue } from '../models/types.js';

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const ICLOUD_DEFAULTS = {
  host: 'imap.mail.me.com',
  port: 993,
  tls: true,
  smtpHost: 'smtp.mail.me.com',
  smtpPort: 587,
};

export function registerAccountTools(server: McpServer, accountManager: AccountManager): void {
  // --- email_list_accounts ---
  server.tool(
    'email_list_accounts',
    'List all configured email accounts and their connection status',
    {},
    async () => {
      try {
        const accounts = await accountManager.listAccounts();
        return jsonResult(accounts);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_add_account ---
  server.tool(
    'email_add_account',
    'Add a new IMAP or iCloud email account (Gmail and Outlook require the setup wizard for OAuth)',
    {
      provider: z.string().describe('Provider type: "imap" or "icloud" (Gmail/Outlook require OAuth setup wizard)'),
      name: z.string().describe('Display name for the account'),
      email: z.string().describe('Email address'),
      password: z.string().optional().describe('Password or app-specific password'),
      host: z.string().optional().describe('IMAP server hostname'),
      port: z.number().optional().describe('IMAP server port (default: 993)'),
      tls: z.boolean().optional().describe('Use TLS (default: true)'),
      smtpHost: z.string().optional().describe('SMTP server hostname'),
      smtpPort: z.number().optional().describe('SMTP server port'),
    },
    async (args) => {
      try {
        // OAuth providers must use the setup wizard
        if (args.provider === 'gmail' || args.provider === 'outlook') {
          return jsonResult({
            error: `${args.provider} requires OAuth authentication. Use the setup wizard (npm run setup) to add ${args.provider} accounts.`,
          });
        }

        // Build password credentials with iCloud defaults if needed
        const isICloud = args.provider === 'icloud';
        const host = args.host ?? (isICloud ? ICLOUD_DEFAULTS.host : undefined);
        const port = args.port ?? (isICloud ? ICLOUD_DEFAULTS.port : undefined);
        const tls = args.tls ?? (isICloud ? ICLOUD_DEFAULTS.tls : true);

        if (!host || !port) {
          return jsonResult({
            error: 'IMAP host and port are required for non-iCloud providers',
          });
        }

        const accountId = crypto.randomUUID();
        const creds: AccountCredentials = {
          id: accountId,
          name: args.name,
          provider: args.provider as ProviderTypeValue,
          email: args.email,
          password: {
            password: args.password ?? '',
            host,
            port,
            tls,
            smtpHost: args.smtpHost ?? (isICloud ? ICLOUD_DEFAULTS.smtpHost : undefined),
            smtpPort: args.smtpPort ?? (isICloud ? ICLOUD_DEFAULTS.smtpPort : undefined),
          },
        };

        await accountManager.addAccount(creds);
        return jsonResult({ success: true, accountId });
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_remove_account ---
  server.tool(
    'email_remove_account',
    'Remove an email account: deletes its stored credentials, revokes the Google grant for Gmail accounts, and removes Outlook tokens from the local token cache. The result reports whether provider-side revocation succeeded.',
    {
      accountId: z.string().describe('ID of the account to remove'),
    },
    async (args) => {
      try {
        const result = await accountManager.removeAccount(args.accountId);
        return jsonResult(result);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_test_account ---
  server.tool(
    'email_test_account',
    'Test an email account connection',
    {
      accountId: z.string().describe('ID of the account to test'),
    },
    async (args) => {
      try {
        const result = await accountManager.testAccount(args.accountId);
        return jsonResult(result);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );
}
