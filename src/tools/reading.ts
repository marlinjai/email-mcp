import { isToolEnabled } from './policy.js';
import { getDataDir } from '../config.js';
import { saveDownload } from './downloads.js';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../account-manager.js';
import type { SearchQuery, Email } from '../models/types.js';

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// Tool-supplied paths are untrusted. The lexical check rejects traversal;
// saveDownload checks filesystem links after fetching the attachment.
/** Resolve the configured downloads directory or the downloads subdirectory of the private data directory. */
function getDownloadsBaseDir(): string {
  return path.resolve(
    process.env.EMAIL_MCP_DOWNLOADS_DIR || path.join(getDataDir(), 'downloads'),
  );
}

function resolveDownloadPath(outputPath: string): string {
  const baseDir = getDownloadsBaseDir();
  const resolved = path.resolve(baseDir, outputPath);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `outputPath must resolve inside ${baseDir} (set EMAIL_MCP_DOWNLOADS_DIR to change the base directory)`,
    );
  }
  return resolved;
}

function stripBodies(emails: Email[]): Email[] {
  return emails.map((email) => ({
    ...email,
    body: { text: undefined, html: undefined },
  }));
}

/** Register enabled read tools and the opt-in attachment saver with account checks and bounded download paths. */
export function registerReadingTools(server: McpServer, accountManager: AccountManager): void {
  // --- email_list_folders ---
  if (isToolEnabled('email_list_folders')) server.tool(
    'email_list_folders',
    'List all email folders for an account',
    {
      accountId: z.string(),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const folders = await provider.listFolders();
        return jsonResult(folders);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_search ---
  if (isToolEnabled('email_search')) server.tool(
    'email_search',
    'Search emails with filters. By default returns compact results without full body content to save context. Set returnBody=true to include full email bodies.',
    {
      accountId: z.string(),
      folder: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      since: z.string().optional(),
      before: z.string().optional(),
      unreadOnly: z.boolean().optional(),
      starredOnly: z.boolean().optional(),
      hasAttachment: z.boolean().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
      returnBody: z.boolean().optional().describe('Include full email body in results (default: false). Set to true only when you need the full content.'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);

        const query: SearchQuery = {};
        if (args.folder !== undefined) query.folder = args.folder;
        if (args.from !== undefined) query.from = args.from;
        if (args.to !== undefined) query.to = args.to;
        if (args.subject !== undefined) query.subject = args.subject;
        if (args.body !== undefined) query.body = args.body;
        if (args.since !== undefined) query.since = args.since;
        if (args.before !== undefined) query.before = args.before;
        if (args.unreadOnly !== undefined) query.unreadOnly = args.unreadOnly;
        if (args.starredOnly !== undefined) query.starredOnly = args.starredOnly;
        if (args.hasAttachment !== undefined) query.hasAttachment = args.hasAttachment;
        if (args.limit !== undefined) query.limit = args.limit;
        if (args.offset !== undefined) query.offset = args.offset;
        if (args.returnBody !== undefined) query.returnBody = args.returnBody;

        let emails = await provider.search(query);

        // Strip bodies by default to reduce payload size
        if (!args.returnBody) {
          emails = stripBodies(emails);
        }

        return jsonResult(emails);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_get ---
  if (isToolEnabled('email_get')) server.tool(
    'email_get',
    'Get a single email by ID',
    {
      accountId: z.string(),
      emailId: z.string(),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const email = await provider.getEmail(args.emailId, args.sourceFolder);
        return jsonResult(email);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_get_thread ---
  if (isToolEnabled('email_get_thread')) server.tool(
    'email_get_thread',
    'Get an email thread by thread ID',
    {
      accountId: z.string(),
      threadId: z.string(),
      sourceFolder: z.string().optional().describe('Folder to look for the thread in on IMAP/iCloud, where a thread is searched in one folder (default INBOX). Gmail and Outlook ignore it'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const thread = await provider.getThread(args.threadId, args.sourceFolder);
        return jsonResult(thread);
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_get_attachment ---
  if (isToolEnabled('email_get_attachment')) server.tool(
    'email_get_attachment',
    'Get an email attachment by ID, returns base64 encoded data',
    {
      accountId: z.string(),
      emailId: z.string(),
      attachmentId: z.string(),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
    },
    async (args) => {
      try {
        const provider = await accountManager.getProvider(args.accountId);
        const { data, meta } = await provider.getAttachment(args.emailId, args.attachmentId, args.sourceFolder);
        return jsonResult({
          data: Buffer.from(data).toString('base64'),
          meta,
        });
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );

  // --- email_save_attachment ---
  if (isToolEnabled('email_save_attachment')) server.tool(
    'email_save_attachment',
    `Download an email attachment and save it directly to disk, returning metadata only (no base64 in the response) — avoids paying the token cost of round-tripping large attachments through the calling model. outputPath is relative to a fixed downloads directory (${getDownloadsBaseDir()}, override with EMAIL_MCP_DOWNLOADS_DIR) and cannot escape it.`,
    {
      accountId: z.string(),
      emailId: z.string(),
      attachmentId: z.string(),
      outputPath: z.string().describe('Relative file path (within the downloads directory) to save the attachment as'),
      sourceFolder: z.string().optional().describe('Source folder (required for IMAP/iCloud when email is not in INBOX)'),
    },
    async (args) => {
      try {
        const absPath = resolveDownloadPath(args.outputPath);
        const provider = await accountManager.getProvider(args.accountId);
        const { data, meta } = await provider.getAttachment(args.emailId, args.attachmentId, args.sourceFolder);

        saveDownload(getDownloadsBaseDir(), absPath, Buffer.from(data));

        return jsonResult({
          path: absPath,
          bytes: data.length,
          filename: meta.filename,
          mimeType: meta.contentType,
        });
      } catch (error: any) {
        return jsonResult({ error: error.message });
      }
    },
  );
}
