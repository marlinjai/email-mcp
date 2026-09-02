import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../account-manager.js';
import type { BatchResult } from '../models/types.js';

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function registerOrganizingTools(server: McpServer, accountManager: AccountManager): void {
  // --- email_move ---
  server.tool(
    'email_move',
    'Move an email to a different folder',
    {
      accountId: z.string(),
      emailId: z.string(),
      targetFolder: z.string(),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        await provider.moveEmail(args.emailId, args.targetFolder, args.sourceFolder);
        return jsonResult({ success: true });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_delete ---
  server.tool(
    'email_delete',
    'Delete an email (moves to trash by default, or permanently deletes)',
    {
      accountId: z.string(),
      emailId: z.string(),
      permanent: z.boolean().optional(),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        await provider.deleteEmail(args.emailId, args.permanent, args.sourceFolder);
        return jsonResult({ success: true });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_mark ---
  server.tool(
    'email_mark',
    'Mark an email as read/unread, starred, or flagged',
    {
      accountId: z.string(),
      emailId: z.string(),
      read: z.boolean().optional(),
      starred: z.boolean().optional(),
      flagged: z.boolean().optional(),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const flags: { read?: boolean; starred?: boolean; flagged?: boolean } = {};
        if (args.read !== undefined) flags.read = args.read;
        if (args.starred !== undefined) flags.starred = args.starred;
        if (args.flagged !== undefined) flags.flagged = args.flagged;
        await provider.markEmail(args.emailId, flags, args.sourceFolder);
        return jsonResult({ success: true });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_batch_delete ---
  server.tool(
    'email_batch_delete',
    'Delete multiple emails at once. Much faster than individual deletes.',
    {
      accountId: z.string(),
      emailIds: z.array(z.string()).min(1).describe('Array of email IDs to delete'),
      permanent: z.boolean().optional().describe('Permanently delete instead of moving to trash'),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when emails are not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);

        if (provider.batchDelete) {
          const result = await provider.batchDelete(args.emailIds, args.permanent, args.sourceFolder);
          return jsonResult({ success: true, ...result });
        }

        // Sequential fallback for providers without native batch support
        const result: BatchResult = { succeeded: [], failed: [] };
        for (const id of args.emailIds) {
          try {
            await provider.deleteEmail(id, args.permanent, args.sourceFolder);
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

  // --- email_batch_move ---
  server.tool(
    'email_batch_move',
    'Move multiple emails to a folder at once. Much faster than individual moves.',
    {
      accountId: z.string(),
      emailIds: z.array(z.string()).min(1).describe('Array of email IDs to move'),
      targetFolder: z.string().describe('Destination folder name or ID'),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when emails are not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);

        if (provider.batchMove) {
          const result = await provider.batchMove(args.emailIds, args.targetFolder, args.sourceFolder);
          return jsonResult({ success: true, ...result });
        }

        // Sequential fallback
        const result: BatchResult = { succeeded: [], failed: [] };
        for (const id of args.emailIds) {
          try {
            await provider.moveEmail(id, args.targetFolder, args.sourceFolder);
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

  // --- email_batch_mark ---
  server.tool(
    'email_batch_mark',
    'Mark multiple emails at once (read/unread, starred, flagged). Much faster than individual marks.',
    {
      accountId: z.string(),
      emailIds: z.array(z.string()).min(1).describe('Array of email IDs to mark'),
      read: z.boolean().optional(),
      starred: z.boolean().optional(),
      flagged: z.boolean().optional(),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when emails are not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const flags: { read?: boolean; starred?: boolean; flagged?: boolean } = {};
        if (args.read !== undefined) flags.read = args.read;
        if (args.starred !== undefined) flags.starred = args.starred;
        if (args.flagged !== undefined) flags.flagged = args.flagged;

        if (provider.batchMark) {
          const result = await provider.batchMark(args.emailIds, flags, args.sourceFolder);
          return jsonResult({ success: true, ...result });
        }

        // Sequential fallback
        const result: BatchResult = { succeeded: [], failed: [] };
        for (const id of args.emailIds) {
          try {
            await provider.markEmail(id, flags, args.sourceFolder);
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

  // --- email_batch_label ---
  server.tool(
    'email_batch_label',
    'Add or remove labels on multiple emails at once (Gmail only). Much faster than individual email_label calls.',
    {
      accountId: z.string(),
      emailIds: z.array(z.string()).min(1).describe('Array of email IDs to label'),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);

        if (!provider.addLabels || !provider.removeLabels) {
          return jsonResult({
            success: false,
            error: 'email_batch_label is only supported on Gmail accounts',
            supportedProviders: ['gmail'],
          });
        }

        if (provider.batchLabel) {
          const result = await provider.batchLabel(args.emailIds, args.addLabels, args.removeLabels);
          return jsonResult({ success: true, ...result });
        }

        // Sequential fallback for providers without native batch support
        const result: BatchResult = { succeeded: [], failed: [] };
        for (const id of args.emailIds) {
          try {
            if (args.addLabels && args.addLabels.length > 0) await provider.addLabels(id, args.addLabels);
            if (args.removeLabels && args.removeLabels.length > 0) await provider.removeLabels(id, args.removeLabels);
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

  // --- email_transfer (cross-account) ---
  server.tool(
    'email_transfer',
    'Move or copy emails BETWEEN accounts, preserving the original message intact (sender, date, threading) by transferring the raw MIME. Fetches each message from the source account and imports it into the target account. With deleteAfter=true the source copy is sent to trash only after a confirmed import, making this a safe cross-account move.',
    {
      sourceAccountId: z.string().describe('Account to read messages from'),
      targetAccountId: z.string().describe('Account to import messages into'),
      emailIds: z.array(z.string()).min(1).describe('Source email IDs to transfer'),
      targetFolder: z.string().optional().describe('Destination folder/label in the target account (Gmail label id or name; IMAP/Outlook folder name). Defaults to INBOX.'),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when emails are not in INBOX)'),
      deleteAfter: z.boolean().optional().describe('Send the source copy to trash after a successful import. Default false (copy, leaving the original in place).'),
      markRead: z.boolean().optional().describe('Mark imported messages as read in the target. Default: provider default (usually unread).'),
    },
    async (args) => {
      try {
        const source = await accountManager.getProvider(args.sourceAccountId);
        const target = await accountManager.getProvider(args.targetAccountId);

        if (!source.getRawMessage) {
          return jsonResult({ success: false, error: 'Source provider does not support raw message export' });
        }
        if (!target.appendRawMessage) {
          return jsonResult({ success: false, error: 'Target provider does not support raw message import' });
        }

        const flags = args.markRead !== undefined ? { read: args.markRead } : undefined;

        const transferred: Array<{ sourceId: string; targetId: string }> = [];
        const failed: Array<{ id: string; error: string }> = [];
        const deleted: string[] = [];
        const deleteFailed: Array<{ id: string; error: string }> = [];

        for (const id of args.emailIds) {
          let targetId: string;
          try {
            const raw = await source.getRawMessage(id, args.sourceFolder);
            const res = await target.appendRawMessage(raw, args.targetFolder, flags);
            targetId = res.id;
            transferred.push({ sourceId: id, targetId });
          } catch (e: any) {
            failed.push({ id, error: e.message });
            continue; // never delete the source when the import failed
          }

          if (args.deleteAfter) {
            try {
              await source.deleteEmail(id, false, args.sourceFolder);
              deleted.push(id);
            } catch (e: any) {
              deleteFailed.push({ id, error: e.message });
            }
          }
        }

        return jsonResult({
          success: true,
          transferred: transferred.length,
          deleted: deleted.length,
          ...(failed.length ? { failedCount: failed.length } : {}),
          ...(deleteFailed.length ? { deleteFailedCount: deleteFailed.length } : {}),
          details: { transferred, failed, deleted, deleteFailed },
        });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_label ---
  server.tool(
    'email_label',
    'Add or remove labels on an email (Gmail only)',
    {
      accountId: z.string(),
      emailId: z.string(),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);

        // Check if the provider supports label operations
        if (!provider.addLabels || !provider.removeLabels) {
          return jsonResult({
            success: false,
            error: 'email_label is only supported on Gmail accounts',
            supportedProviders: ['gmail'],
          });
        }

        if (args.addLabels && args.addLabels.length > 0) {
          await provider.addLabels(args.emailId, args.addLabels);
        }
        if (args.removeLabels && args.removeLabels.length > 0) {
          await provider.removeLabels(args.emailId, args.removeLabels);
        }

        return jsonResult({ success: true });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_folder_create ---
  server.tool(
    'email_folder_create',
    'Create a new email folder',
    {
      accountId: z.string(),
      name: z.string(),
      parentPath: z.string().optional(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const folder = await provider.createFolder(args.name, args.parentPath);
        return jsonResult({ success: true, data: folder });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_get_labels ---
  server.tool(
    'email_get_labels',
    'List all labels for an email account (Gmail only)',
    {
      accountId: z.string(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);

        if (!provider.listLabels) {
          return jsonResult({
            success: false,
            error: 'email_get_labels is only supported on Gmail accounts',
            supportedProviders: ['gmail'],
          });
        }

        const labels = await provider.listLabels();
        return jsonResult({ success: true, data: labels });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );

  // --- email_get_categories ---
  server.tool(
    'email_get_categories',
    'List all categories for an email account (Outlook only)',
    {
      accountId: z.string(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);

        if (!provider.getCategories) {
          return jsonResult({
            success: false,
            error: 'email_get_categories is only supported on Outlook accounts',
            supportedProviders: ['outlook'],
          });
        }

        const categories = await provider.getCategories();
        return jsonResult({ success: true, data: categories });
      } catch (error: any) {
        return jsonResult({ success: false, error: error.message });
      }
    },
  );
}
