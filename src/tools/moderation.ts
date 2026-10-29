import { isToolEnabled } from './policy.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../account-manager.js';
import type { BatchResult } from '../models/types.js';

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

const BLOCK_RULE_MATCH_TYPES = ['senderDomain', 'senderAddress', 'subjectContains', 'headerContains'] as const;
const BLOCK_RULE_ACTIONS = ['delete', 'moveToJunk'] as const;

/** Register enabled spam and block-rule tools with provider capability and argument validation. */
export function registerModerationTools(server: McpServer, accountManager: AccountManager): void {
  // --- email_report_spam ---
  if (isToolEnabled('email_report_spam')) server.tool(
    'email_report_spam',
    'Report an email as spam/junk, training the provider\'s own spam filter (the same signal the "Report Junk" button sends in Gmail/Outlook). This is different from email_delete, which removes the message but teaches the filter nothing. Not an abuse report to the provider\'s security team — it only trains this account\'s filter.',
    {
      accountId: z.string(),
      emailId: z.string(),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        if (!provider.reportSpam) {
          return jsonResult({ success: false, error: 'email_report_spam is not supported on this provider' });
        }
        await provider.reportSpam(args.emailId, args.sourceFolder);
        return jsonResult({ success: true });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_batch_report_spam ---
  if (isToolEnabled('email_batch_report_spam')) server.tool(
    'email_batch_report_spam',
    'Report multiple emails as spam/junk at once. Much faster than individual calls.',
    {
      accountId: z.string(),
      emailIds: z.array(z.string()).min(1).describe('Array of email IDs to report as spam'),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when emails are not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        if (!provider.reportSpam) {
          return jsonResult({ success: false, error: 'email_batch_report_spam is not supported on this provider' });
        }

        const result: BatchResult = { succeeded: [], failed: [] };
        for (const id of args.emailIds) {
          try {
            await provider.reportSpam(id, args.sourceFolder);
            result.succeeded.push(id);
          } catch (e: any) {
            result.failed.push({ id, error: e.message });
          }
        }
        return jsonResult({ success: true, ...result });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_create_block_rule ---
  if (isToolEnabled('email_create_block_rule')) server.tool(
    'email_create_block_rule',
    'Create a standing rule that intercepts future mail matching a pattern, before it reaches the inbox. Use headerContains (e.g. matching a Reply-To domain) to block a spam template family whose visible "From" domain rotates — matching the rotating domain directly stops working within days. Not supported on iCloud/generic IMAP (no standard server-side rule mechanism exists across IMAP servers). Outlook requires the MailboxSettings.ReadWrite scope — accounts authenticated before this tool existed need to re-run the setup wizard once to re-consent.',
    {
      accountId: z.string(),
      matchType: z.enum(BLOCK_RULE_MATCH_TYPES).describe(
        'senderDomain/senderAddress: match the From address. subjectContains: match the subject. headerContains: match any header\'s raw content — the right choice for a stable element (e.g. a Reply-To domain) when the From domain rotates.',
      ),
      value: z.string().describe('The domain, address, or text to match'),
      action: z.enum(BLOCK_RULE_ACTIONS).describe(
        'delete: discard on arrival. moveToJunk: on Outlook, files straight to the Junk Email folder; on Gmail, skips the inbox (archives) — Gmail\'s filter API cannot proactively apply the SPAM label, only its own classifier can, so this is the closest a standing rule can actually do there.',
      ),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        if (!provider.createBlockRule) {
          return jsonResult({
            success: false,
            error: 'email_create_block_rule is not supported on this provider',
            supportedProviders: ['gmail', 'outlook'],
          });
        }
        const result = await provider.createBlockRule({
          matchType: args.matchType,
          value: args.value,
          action: args.action,
        });
        return jsonResult({ success: true, data: result });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_list_block_rules ---
  if (isToolEnabled('email_list_block_rules')) server.tool(
    'email_list_block_rules',
    'List the standing block rules on an account, for auditing or before deleting one.',
    {
      accountId: z.string(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        if (!provider.listBlockRules) {
          return jsonResult({
            success: false,
            error: 'email_list_block_rules is not supported on this provider',
            supportedProviders: ['gmail', 'outlook'],
          });
        }
        const rules = await provider.listBlockRules();
        return jsonResult({ success: true, data: rules });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_delete_block_rule ---
  if (isToolEnabled('email_delete_block_rule')) server.tool(
    'email_delete_block_rule',
    'Delete a standing block rule — use this to undo a rule that turned out to be too broad (e.g. it blocked a domain a real correspondent also uses).',
    {
      accountId: z.string(),
      ruleId: z.string(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        if (!provider.deleteBlockRule) {
          return jsonResult({
            success: false,
            error: 'email_delete_block_rule is not supported on this provider',
            supportedProviders: ['gmail', 'outlook'],
          });
        }
        await provider.deleteBlockRule(args.ruleId);
        return jsonResult({ success: true });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );
}
