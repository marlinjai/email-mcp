import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { EmailProvider, SendEmailParams } from '../provider.js';
import type {
  Email,
  Folder,
  Thread,
  SearchQuery,
  AttachmentMeta,
  AccountCredentials,
  ProviderTypeValue,
  PasswordCredentials,
  BatchResult,
} from '../../models/types.js';
import { ProviderType, FolderType } from '../../models/types.js';
import { mapImapFolder, mapParsedEmail } from './mapper.js';
import { createSmtpTransport, sendViaSmtp } from './smtp.js';

/**
 * Extracts detailed diagnostic information from ImapFlow errors.
 * ImapFlow wraps IMAP server responses in Error objects with extra properties
 * (responseText, responseStatus, serverResponseCode, executedCommand) that
 * are not included in error.message ("Command failed"). This helper surfaces
 * those details so callers get actionable error messages instead of opaque ones.
 */
function formatImapError(error: any, context?: string): Error {
  const parts: string[] = [];
  if (context) parts.push(context);

  // error.responseText contains the human-readable reason from the IMAP server
  // e.g., "Mailbox does not exist" or "[NONEXISTENT] No such mailbox"
  const serverMsg = error.responseText || error.responseStatus;
  if (serverMsg) {
    parts.push(serverMsg);
  } else {
    parts.push(error.message || 'Unknown IMAP error');
  }

  // Include the server response code if available (e.g., NONEXISTENT, SERVERBUG)
  if (error.serverResponseCode) {
    parts.push(`[${error.serverResponseCode}]`);
  }

  // Flag when the server explicitly says the mailbox does not exist
  if (error.mailboxMissing) {
    parts.push('(mailbox does not exist on server)');
  }

  const enhanced = new Error(parts.join(' - '));
  // Preserve the original error for debugging
  enhanced.cause = error;
  return enhanced;
}

export class ImapAdapter implements EmailProvider {
  readonly providerType: ProviderTypeValue = ProviderType.IMAP;
  protected client: InstanceType<typeof ImapFlow> | null = null;
  protected accountId: string = '';
  protected email: string = '';
  protected passwordCreds: PasswordCredentials | null = null;

  async connect(credentials: AccountCredentials): Promise<void> {
    if (!credentials.password) {
      throw new Error('IMAP adapter requires password credentials');
    }
    this.accountId = credentials.id;
    this.email = credentials.email;
    this.passwordCreds = credentials.password;

    this.client = new ImapFlow({
      host: credentials.password.host,
      port: credentials.password.port,
      secure: credentials.password.tls,
      auth: {
        user: credentials.email,
        pass: credentials.password.password,
      },
      logger: false,
    });

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.logout();
      this.client = null;
    }
  }

  async testConnection(): Promise<{ success: boolean; folderCount: number; error?: string }> {
    try {
      const folders = await this.listFolders();
      return { success: true, folderCount: folders.length };
    } catch (error: any) {
      return { success: false, folderCount: 0, error: error.message };
    }
  }

  async listFolders(): Promise<Folder[]> {
    if (!this.client) throw new Error('Not connected');
    const imapFolders = await this.client.list();
    return imapFolders.map(mapImapFolder);
  }

  async createFolder(name: string, parentPath?: string): Promise<Folder> {
    if (!this.client) throw new Error('Not connected');
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    const result = await this.client.mailboxCreate(fullPath);
    return {
      id: result.path,
      name: result.name || name,
      path: result.path,
      type: FolderType.Other,
    };
  }

  protected buildSearchCriteria(query: SearchQuery): Record<string, any> {
    const criteria: Record<string, any> = {};
    if (query.from) criteria.from = query.from;
    if (query.to) criteria.to = query.to;
    if (query.subject) criteria.subject = query.subject;
    if (query.body) criteria.body = query.body;
    if (query.since) criteria.since = new Date(query.since);
    if (query.before) criteria.before = new Date(query.before);
    if (query.unreadOnly) criteria.unseen = true;
    if (query.starredOnly) criteria.flagged = true;
    if (query.hasAttachment) criteria.header = { 'content-type': 'multipart/mixed' };
    return criteria;
  }

  /**
   * Resolves a folder name to the correct IMAP path.
   * Some providers (e.g., iCloud) report folder paths differently than what
   * users might expect. This method tries the given path first, and if SELECT
   * fails with a mailbox-not-found error, it falls back to listing all folders
   * and matching by name or special-use type.
   */
  protected async resolveFolder(folder: string): Promise<string> {
    if (!this.client) throw new Error('Not connected');

    // Common aliases: map well-known names to potential IMAP special-use types
    const FOLDER_ALIASES: Record<string, string[]> = {
      junk: ['Junk', 'Spam', 'Bulk Mail', 'Junk E-mail', 'Junk Email'],
      spam: ['Junk', 'Spam', 'Bulk Mail', 'Junk E-mail', 'Junk Email'],
      trash: ['Trash', 'Deleted Messages', 'Deleted Items', 'Bin'],
      sent: ['Sent', 'Sent Messages', 'Sent Items', 'Sent Mail'],
      drafts: ['Drafts', 'Draft'],
      archive: ['Archive', 'All Mail'],
    };

    // First, try to match against known folder paths from the server
    const folders = await this.client.list();
    const lowerFolder = folder.toLowerCase();

    // Exact path match (case-insensitive for non-INBOX folders)
    const exactMatch = folders.find(
      (f: any) => f.path === folder || f.path.toLowerCase() === lowerFolder
    );
    if (exactMatch) return exactMatch.path;

    // Match by name (the last component of the path)
    const nameMatch = folders.find(
      (f: any) => f.name && f.name.toLowerCase() === lowerFolder
    );
    if (nameMatch) return nameMatch.path;

    // Match by special-use flag (e.g., \Junk, \Trash, \Sent)
    const specialUseMap: Record<string, string> = {
      junk: '\\Junk',
      spam: '\\Junk',
      trash: '\\Trash',
      sent: '\\Sent',
      drafts: '\\Drafts',
      archive: '\\Archive',
      inbox: '\\Inbox',
    };
    const specialUseFlag = specialUseMap[lowerFolder];
    if (specialUseFlag) {
      const specialMatch = folders.find(
        (f: any) => f.specialUse === specialUseFlag
      );
      if (specialMatch) return specialMatch.path;
    }

    // Match by alias list
    const aliases = FOLDER_ALIASES[lowerFolder];
    if (aliases) {
      for (const alias of aliases) {
        const aliasMatch = folders.find(
          (f: any) => f.path === alias || f.name === alias ||
            f.path.toLowerCase() === alias.toLowerCase()
        );
        if (aliasMatch) return aliasMatch.path;
      }
    }

    // No match found -- return the original path and let SELECT report the error
    return folder;
  }

  async search(query: SearchQuery): Promise<Email[]> {
    if (!this.client) throw new Error('Not connected');

    const requestedFolder = query.folder || 'INBOX';

    // Resolve the folder path -- this handles provider-specific naming differences
    // (e.g., iCloud uses "Junk" not "Spam", "Deleted Messages" not "Trash")
    let folder: string;
    try {
      folder = await this.resolveFolder(requestedFolder);
    } catch {
      folder = requestedFolder;
    }

    // Refresh connection state before search (helps with iCloud stale sessions)
    try { await this.client.noop(); } catch { /* ignore */ }

    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }

    try {
      const mailboxExists = (this.client as any).mailbox?.exists ?? 0;
      if (mailboxExists === 0) {
        return [];
      }

      const criteria = this.buildSearchCriteria(query);
      const hasCriteria = Object.keys(criteria).length > 0;
      let allUids: number[] = [];

      try {
        const searchResult = await this.client.search(
          hasCriteria ? criteria : { all: true },
          { uid: true }
        );
        allUids = Array.isArray(searchResult) ? searchResult : [];
      } catch {
        // SEARCH failed — fall back to FETCH-based UID collection
        try {
          allUids = await this.collectUidsViaFetch(query);
        } catch {
          return [];
        }
      }

      const offset = query.offset || 0;
      const slicedUids = query.limit
        ? allUids.slice(offset, offset + query.limit)
        : allUids.slice(offset);

      if (slicedUids.length === 0) return [];

      return await this.fetchEmails(slicedUids, folder, query.returnBody);
    } catch (error: any) {
      throw formatImapError(error, `Search failed in folder "${folder}"`);
    } finally {
      lock.release();
    }
  }

  /**
   * Fallback UID collection when UID SEARCH fails (e.g. iCloud "Invalid message number").
   * Uses a multi-level fallback chain:
   * 1. FETCH 1:* with sequence numbers
   * 2. FETCH 1:N using mailbox.exists as explicit range
   * 3. Individual sequence number fetches (slowest but most resilient)
   */
  private async collectUidsViaFetch(query: SearchQuery): Promise<number[]> {
    if (!this.client) return [];
    const uids: number[] = [];
    const exists = (this.client as any).mailbox?.exists ?? 0;

    // Helper: safely iterate a fetch stream, collecting UIDs
    const safeFetch = async (range: string): Promise<boolean> => {
      try {
        const messages = await this.client!.fetchAll(range, { uid: true, flags: true });
        for (const msg of messages) {
          if (query.unreadOnly && msg.flags?.has('\\Seen')) continue;
          if (query.starredOnly && !msg.flags?.has('\\Flagged')) continue;
          uids.push(msg.uid);
        }
        return uids.length > 0;
      } catch {
        return false;
      }
    };

    // Strategy 1: FETCH 1:* (all messages by sequence)
    if (await safeFetch('1:*')) return uids;
    uids.length = 0;

    // Strategy 2: FETCH 1:N using explicit range from mailbox.exists
    if (exists > 0) {
      if (await safeFetch(`1:${exists}`)) return uids;
      uids.length = 0;
    }

    // Strategy 3: individual sequence fetches (slowest but most resilient)
    const count = exists > 0 ? exists : 50;
    for (let seq = 1; seq <= count; seq++) {
      try {
        const msgs = await this.client.fetchAll(String(seq), { uid: true, flags: true });
        for (const msg of msgs) {
          if (query.unreadOnly && msg.flags?.has('\\Seen')) continue;
          if (query.starredOnly && !msg.flags?.has('\\Flagged')) continue;
          uids.push(msg.uid);
        }
      } catch { /* skip — message at this sequence may not exist */ }
    }
    return uids;
  }

  /**
   * Fetches email data for a set of UIDs, either with full body or lightweight headers.
   */
  private async fetchEmails(uids: number[], folder: string, returnBody?: boolean): Promise<Email[]> {
    if (!this.client) return [];
    const emails: Email[] = [];

    const fetchOpts = returnBody
      ? { source: true, uid: true, flags: true }
      : { envelope: true, uid: true, flags: true, bodyStructure: true };

    // Try batch fetch first (fast path), fall back to individual UIDs.
    // iCloud can reject batch UID FETCH on Junk/Trash folders.
    // NOTE: { uid: true } in 3rd arg tells ImapFlow to treat range as UIDs, not sequence numbers.
    const uidRange = uids.join(',');
    let messages: any[];
    try {
      messages = await this.client.fetchAll(uidRange, fetchOpts, { uid: true });
    } catch {
      // Batch failed — fetch individually, skipping failures
      messages = [];
      for (const uid of uids) {
        try {
          const batch = await this.client.fetchAll(String(uid), fetchOpts, { uid: true });
          messages.push(...batch);
        } catch { /* skip this UID */ }
      }
    }

    for (const msg of messages) {
      if (returnBody) {
        const parsed = await simpleParser(msg.source);
        (parsed as any).flags = msg.flags;
        emails.push(mapParsedEmail(parsed, folder, this.accountId, msg.uid));
      } else {
        const env = msg.envelope;
        emails.push({
          id: String(msg.uid),
          accountId: this.accountId,
          threadId: env.messageId || undefined,
          folder,
          from: env.from?.[0] ? { name: env.from[0].name || undefined, email: env.from[0].address || '' } : { email: '' },
          to: (env.to || []).map((a: any) => ({ name: a.name || undefined, email: a.address || '' })),
          cc: env.cc?.length ? env.cc.map((a: any) => ({ name: a.name || undefined, email: a.address || '' })) : undefined,
          bcc: env.bcc?.length ? env.bcc.map((a: any) => ({ name: a.name || undefined, email: a.address || '' })) : undefined,
          subject: env.subject || '(no subject)',
          date: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
          body: { text: undefined, html: undefined },
          snippet: env.subject || '',
          attachments: [],
          flags: {
            read: msg.flags?.has('\\Seen') ?? false,
            starred: msg.flags?.has('\\Flagged') ?? false,
            flagged: msg.flags?.has('\\Flagged') ?? false,
            draft: msg.flags?.has('\\Draft') ?? false,
          },
        });
      }
    }

    return emails;
  }

  async getEmail(id: string, folder?: string): Promise<Email> {
    if (!this.client) throw new Error('Not connected');

    const targetFolder = folder || 'INBOX';
    let lock;
    try {
      lock = await this.client.getMailboxLock(targetFolder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${targetFolder}"`);
    }

    try {
      const uid = parseInt(id, 10);
      const msg = await this.client.fetchOne(String(uid), { source: true, uid: true, flags: true }, { uid: true });
      if (!msg) throw new Error(`Email ${id} not found`);

      const parsed = await simpleParser(msg.source);
      (parsed as any).flags = msg.flags;
      return mapParsedEmail(parsed, targetFolder, this.accountId, msg.uid);
    } finally {
      lock.release();
    }
  }

  async getThread(threadId: string): Promise<Thread> {
    if (!this.client) throw new Error('Not connected');

    let lock;
    try {
      lock = await this.client.getMailboxLock('INBOX');
    } catch (error: any) {
      throw formatImapError(error, 'Failed to open folder "INBOX"');
    }
    try {
      // Search for messages that reference this thread ID via header
      const searchResult = await this.client.search(
        { or: [{ header: { 'message-id': threadId } }, { header: { references: threadId } }, { header: { 'in-reply-to': threadId } }] },
        { uid: true }
      );
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) throw new Error(`Thread ${threadId} not found`);

      const messages: Email[] = [];
      for await (const msg of this.client.fetch(uids, { source: true, uid: true, flags: true })) {
        const parsed = await simpleParser(msg.source);
        (parsed as any).flags = msg.flags;
        messages.push(mapParsedEmail(parsed, 'INBOX', this.accountId, msg.uid));
      }

      // Collect unique participants
      const participantMap = new Map<string, { name?: string; email: string }>();
      for (const msg of messages) {
        if (msg.from.email) participantMap.set(msg.from.email, msg.from);
        for (const to of msg.to) {
          if (to.email) participantMap.set(to.email, to);
        }
      }

      // Sort messages by date
      messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      return {
        id: threadId,
        subject: messages[0]?.subject || '(no subject)',
        participants: Array.from(participantMap.values()),
        messageCount: messages.length,
        messages,
        lastMessageDate: messages[messages.length - 1]?.date || new Date().toISOString(),
      };
    } finally {
      lock.release();
    }
  }

  async getAttachment(emailId: string, attachmentId: string): Promise<{ data: Buffer; meta: AttachmentMeta }> {
    if (!this.client) throw new Error('Not connected');

    let lock;
    try {
      lock = await this.client.getMailboxLock('INBOX');
    } catch (error: any) {
      throw formatImapError(error, 'Failed to open folder "INBOX"');
    }
    try {
      const msg = await this.client.fetchOne(String(emailId), { source: true, uid: true }, { uid: true });
      if (!msg) throw new Error(`Email ${emailId} not found`);

      const parsed = await simpleParser(msg.source);
      const attachment = (parsed.attachments || []).find(
        (att: any) => att.contentId === attachmentId || att.filename === attachmentId
      );
      if (!attachment) throw new Error(`Attachment ${attachmentId} not found in email ${emailId}`);

      return {
        data: attachment.content,
        meta: {
          id: attachment.contentId || attachmentId,
          filename: attachment.filename || 'attachment',
          contentType: attachment.contentType || 'application/octet-stream',
          size: attachment.size || 0,
        },
      };
    } finally {
      lock.release();
    }
  }

  async sendEmail(params: SendEmailParams): Promise<{ id: string; threadId?: string }> {
    if (!this.passwordCreds) throw new Error('No credentials available');
    const transport = createSmtpTransport(this.email, this.passwordCreds);
    const messageId = await sendViaSmtp(transport, this.email, params);
    return { id: messageId };
  }

  async createDraft(params: SendEmailParams): Promise<{ id: string }> {
    if (!this.client) throw new Error('Not connected');

    // Build RFC 2822 message
    const lines: string[] = [];
    lines.push(`From: ${this.email}`);
    lines.push(`To: ${params.to.map((c) => (c.name ? `"${c.name}" <${c.email}>` : c.email)).join(', ')}`);
    if (params.cc?.length) {
      lines.push(`Cc: ${params.cc.map((c) => c.email).join(', ')}`);
    }
    lines.push(`Subject: ${params.subject}`);
    lines.push(`Date: ${new Date().toUTCString()}`);
    if (params.inReplyTo) lines.push(`In-Reply-To: ${params.inReplyTo}`);
    if (params.references?.length) lines.push(`References: ${params.references.join(' ')}`);
    lines.push('MIME-Version: 1.0');
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(params.body.text || '');

    const rawMessage = lines.join('\r\n');
    // Resolve the real drafts mailbox instead of assuming a top-level "Drafts"
    // folder. Gmail (and localized accounts) expose it as "[Gmail]/Drafts" /
    // "[Gmail]/Entwürfe", so a hardcoded path makes append fail. See issue #3.
    const draftsFolder = await this.resolveFolder('Drafts');
    const result = await this.client.append(draftsFolder, rawMessage, ['\\Draft', '\\Seen']);
    return { id: String(result.uid || result) };
  }

  async listDrafts(limit?: number, offset?: number): Promise<Email[]> {
    return this.search({
      folder: 'Drafts',
      limit,
      offset,
    });
  }

  async moveEmail(emailId: string, targetFolder: string, sourceFolder?: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const folder = sourceFolder || 'INBOX';
    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }
    try {
      await this.client.messageMove(emailId, targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  /**
   * Best-effort only: generic IMAP has no server-side ML classifier to
   * train, so this just moves the message to the account's Junk-typed
   * folder (via the same alias resolution `deleteEmail` uses for Trash).
   * No standing block-rule mechanism exists across IMAP servers (Sieve
   * exists on some but isn't universal), so `createBlockRule` is
   * intentionally left unimplemented for this provider.
   */
  async reportSpam(emailId: string, sourceFolder?: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const folder = sourceFolder || 'INBOX';
    const junkFolder = await this.resolveFolder('junk');
    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }
    try {
      await this.client.messageMove(emailId, junkFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  async deleteEmail(emailId: string, permanent?: boolean, sourceFolder?: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const folder = sourceFolder ? await this.resolveFolder(sourceFolder) : 'INBOX';
    const trashFolder = await this.resolveFolder('Trash');
    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }
    try {
      if (permanent || folder === trashFolder) {
        // Permanently delete if requested or if already in trash
        await this.client.messageDelete(emailId, { uid: true });
      } else {
        await this.client.messageMove(emailId, trashFolder, { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async markEmail(emailId: string, flags: { read?: boolean; starred?: boolean; flagged?: boolean }, sourceFolder?: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    const folder = sourceFolder || 'INBOX';
    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }
    try {
      if (flags.read === true) {
        await this.client.messageFlagsAdd(emailId, ['\\Seen'], { uid: true });
      } else if (flags.read === false) {
        await this.client.messageFlagsRemove(emailId, ['\\Seen'], { uid: true });
      }

      if (flags.starred === true || flags.flagged === true) {
        await this.client.messageFlagsAdd(emailId, ['\\Flagged'], { uid: true });
      } else if (flags.starred === false || flags.flagged === false) {
        await this.client.messageFlagsRemove(emailId, ['\\Flagged'], { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  async getRawMessage(emailId: string, sourceFolder?: string): Promise<Buffer> {
    if (!this.client) throw new Error('Not connected');
    const folder = sourceFolder ? await this.resolveFolder(sourceFolder) : 'INBOX';
    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }
    try {
      const msg = await this.client.fetchOne(String(emailId), { source: true, uid: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`Email ${emailId} not found in "${folder}"`);
      return msg.source;
    } finally {
      lock.release();
    }
  }

  async appendRawMessage(
    raw: Buffer,
    targetFolder?: string,
    flags?: { read?: boolean; starred?: boolean },
  ): Promise<{ id: string }> {
    if (!this.client) throw new Error('Not connected');
    const folder = targetFolder ? await this.resolveFolder(targetFolder) : 'INBOX';
    const imapFlags: string[] = [];
    if (flags?.read) imapFlags.push('\\Seen');
    if (flags?.starred) imapFlags.push('\\Flagged');
    const result = await this.client.append(folder, raw, imapFlags);
    return { id: String((result as any)?.uid ?? '') };
  }

  async batchDelete(emailIds: string[], permanent?: boolean, sourceFolder?: string): Promise<BatchResult> {
    if (!this.client) throw new Error('Not connected');
    const result: BatchResult = { succeeded: [], failed: [] };
    const folder = sourceFolder ? await this.resolveFolder(sourceFolder) : 'INBOX';
    const trashFolder = await this.resolveFolder('Trash');
    const shouldPermanentDelete = permanent || folder === trashFolder;
    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }

    try {
      // ImapFlow supports UID ranges as comma-separated strings
      const uidRange = emailIds.join(',');
      if (shouldPermanentDelete) {
        await this.client.messageDelete(uidRange, { uid: true });
      } else {
        await this.client.messageMove(uidRange, trashFolder, { uid: true });
      }
      result.succeeded = [...emailIds];
    } catch (error: any) {
      // If batch fails, try individually
      for (const id of emailIds) {
        try {
          if (shouldPermanentDelete) {
            await this.client.messageDelete(id, { uid: true });
          } else {
            await this.client.messageMove(id, trashFolder, { uid: true });
          }
          result.succeeded.push(id);
        } catch (e: any) {
          result.failed.push({ id, error: e.message });
        }
      }
    } finally {
      lock.release();
    }

    return result;
  }

  async batchMove(emailIds: string[], targetFolder: string, sourceFolder?: string): Promise<BatchResult> {
    if (!this.client) throw new Error('Not connected');
    const result: BatchResult = { succeeded: [], failed: [] };
    const folder = sourceFolder || 'INBOX';
    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }

    try {
      const uidRange = emailIds.join(',');
      await this.client.messageMove(uidRange, targetFolder, { uid: true });
      result.succeeded = [...emailIds];
    } catch (error: any) {
      for (const id of emailIds) {
        try {
          await this.client.messageMove(id, targetFolder, { uid: true });
          result.succeeded.push(id);
        } catch (e: any) {
          result.failed.push({ id, error: e.message });
        }
      }
    } finally {
      lock.release();
    }

    return result;
  }

  async batchMark(emailIds: string[], flags: { read?: boolean; starred?: boolean; flagged?: boolean }, sourceFolder?: string): Promise<BatchResult> {
    if (!this.client) throw new Error('Not connected');
    const result: BatchResult = { succeeded: [], failed: [] };
    const folder = sourceFolder || 'INBOX';
    let lock;
    try {
      lock = await this.client.getMailboxLock(folder);
    } catch (error: any) {
      throw formatImapError(error, `Failed to open folder "${folder}"`);
    }

    try {
      const uidRange = emailIds.join(',');

      if (flags.read === true) {
        await this.client.messageFlagsAdd(uidRange, ['\\Seen'], { uid: true });
      } else if (flags.read === false) {
        await this.client.messageFlagsRemove(uidRange, ['\\Seen'], { uid: true });
      }

      if (flags.starred === true || flags.flagged === true) {
        await this.client.messageFlagsAdd(uidRange, ['\\Flagged'], { uid: true });
      } else if (flags.starred === false || flags.flagged === false) {
        await this.client.messageFlagsRemove(uidRange, ['\\Flagged'], { uid: true });
      }

      result.succeeded = [...emailIds];
    } catch (error: any) {
      for (const id of emailIds) {
        try {
          await this.markEmail(id, flags, folder);
          result.succeeded.push(id);
        } catch (e: any) {
          result.failed.push({ id, error: e.message });
        }
      }
    } finally {
      lock.release();
    }

    return result;
  }
}
