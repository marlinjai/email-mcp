import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type { gmail_v1 } from 'googleapis';
import type { EmailProvider, SendEmailParams } from '../provider.js';
import type {
  Email,
  Folder,
  Thread,
  SearchQuery,
  AttachmentMeta,
  AccountCredentials,
  ProviderTypeValue,
  BatchResult,
  BlockRuleInput,
  BlockRule,
} from '../../models/types.js';
import { ProviderType } from '../../models/types.js';
import { mapGmailLabel, mapGmailMessage, buildGmailQuery } from './mapper.js';

export class GmailAdapter implements EmailProvider {
  readonly providerType: ProviderTypeValue = ProviderType.Gmail;
  private gmail: gmail_v1.Gmail | null = null;
  private accountId: string = '';
  private email: string = '';

  async connect(credentials: AccountCredentials): Promise<void> {
    if (!credentials.oauth) {
      throw new Error('Gmail adapter requires OAuth credentials');
    }
    this.accountId = credentials.id;
    this.email = credentials.email;

    const auth = new OAuth2Client();
    auth.setCredentials({
      access_token: credentials.oauth.access_token,
      refresh_token: credentials.oauth.refresh_token,
      expiry_date: credentials.oauth.expiry
        ? new Date(credentials.oauth.expiry).getTime()
        : undefined,
    });

    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async disconnect(): Promise<void> {
    this.gmail = null;
  }

  async testConnection(): Promise<{ success: boolean; folderCount: number; error?: string }> {
    try {
      const folders = await this.listFolders();
      return { success: true, folderCount: folders.length };
    } catch (error: any) {
      return { success: false, folderCount: 0, error: error.message };
    }
  }

  private ensureConnected(): gmail_v1.Gmail {
    if (!this.gmail) throw new Error('Not connected');
    return this.gmail;
  }

  async listFolders(): Promise<Folder[]> {
    const gmail = this.ensureConnected();
    const res = await gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels || [];
    return labels.map(mapGmailLabel);
  }

  async createFolder(name: string, parentPath?: string): Promise<Folder> {
    const gmail = this.ensureConnected();
    // Gmail has no real folder hierarchy — nesting is purely a `/`-delimited
    // label name (e.g. "Tech/Anthropic") that the UI renders as a tree.
    const fullName = parentPath ? `${parentPath}/${name}` : name;
    const res = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name: fullName },
    });
    return mapGmailLabel(res.data);
  }

  async search(query: SearchQuery): Promise<Email[]> {
    const gmail = this.ensureConnected();
    const q = buildGmailQuery(query);

    const limit = query.limit || 20;
    const offset = query.offset || 0;
    const needed = offset + limit;

    // Gmail's API has no numeric offset — only an opaque pageToken cursor.
    // To honor `offset`, page forward through the lightweight message-id list
    // until we have collected `offset + limit` ids, then take the window.
    // Only the final window incurs the expensive per-message `get`.
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: any = {
        userId: 'me',
        maxResults: Math.min(500, needed - ids.length),
      };
      if (q) params.q = q;
      if (query.folder) params.labelIds = [query.folder];
      if (pageToken) params.pageToken = pageToken;

      const res = await gmail.users.messages.list(params);
      for (const msg of res.data.messages || []) {
        if (msg.id) ids.push(msg.id);
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken && ids.length < needed);

    const windowIds = ids.slice(offset, offset + limit);
    if (windowIds.length === 0) return [];

    // Fetch full message details for each result in the window
    const emails: Email[] = [];
    for (const id of windowIds) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });
      emails.push(mapGmailMessage(full.data, this.accountId));
    }

    return emails;
  }

  async getEmail(id: string): Promise<Email> {
    const gmail = this.ensureConnected();
    const res = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    return mapGmailMessage(res.data, this.accountId);
  }

  async getThread(threadId: string): Promise<Thread> {
    const gmail = this.ensureConnected();
    const res = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const gmailMessages = res.data.messages || [];
    const messages = gmailMessages.map((msg: any) =>
      mapGmailMessage(msg, this.accountId),
    );

    // Collect unique participants
    const participantMap = new Map<string, { name?: string; email: string }>();
    for (const msg of messages) {
      participantMap.set(msg.from.email, msg.from);
      for (const to of msg.to) {
        participantMap.set(to.email, to);
      }
    }

    return {
      id: threadId,
      subject: messages[0]?.subject || '(no subject)',
      participants: Array.from(participantMap.values()),
      messageCount: messages.length,
      messages,
      lastMessageDate: messages[messages.length - 1]?.date || new Date().toISOString(),
    };
  }

  async getAttachment(
    emailId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; meta: AttachmentMeta }> {
    const gmail = this.ensureConnected();

    // Get the attachment data
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: emailId,
      id: attachmentId,
    });

    // Get the email to find attachment metadata
    const email = await this.getEmail(emailId);
    const attachment = email.attachments.find((a) => a.id === attachmentId);

    return {
      data: Buffer.from(res.data.data || '', 'base64url'),
      meta: attachment || {
        id: attachmentId,
        filename: 'unknown',
        contentType: 'application/octet-stream',
        size: res.data.size || 0,
      },
    };
  }

  async sendEmail(params: SendEmailParams): Promise<{ id: string; threadId?: string }> {
    const gmail = this.ensureConnected();
    const raw = this.buildRfc2822(params);

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return {
      id: res.data.id || '',
      threadId: res.data.threadId || undefined,
    };
  }

  async createDraft(params: SendEmailParams): Promise<{ id: string }> {
    const gmail = this.ensureConnected();
    const raw = this.buildRfc2822(params);

    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw },
      },
    });

    return { id: res.data.id || '' };
  }

  async updateDraft(draftId: string, params: SendEmailParams): Promise<{ id: string }> {
    const gmail = this.ensureConnected();
    const raw = this.buildRfc2822(params);

    const res = await gmail.users.drafts.update({
      userId: 'me',
      id: draftId,
      requestBody: {
        message: { raw },
      },
    });

    return { id: res.data.id || draftId };
  }

  async listDrafts(limit?: number, _offset?: number): Promise<Email[]> {
    const gmail = this.ensureConnected();

    const res = await gmail.users.drafts.list({
      userId: 'me',
      maxResults: limit || 20,
    });

    const drafts = res.data.drafts || [];
    const emails: Email[] = [];

    for (const draft of drafts) {
      const full = await gmail.users.drafts.get({
        userId: 'me',
        id: draft.id!,
        format: 'full',
      });
      if (full.data.message) {
        emails.push(mapGmailMessage(full.data.message, this.accountId));
      }
    }

    return emails;
  }

  async moveEmail(emailId: string, targetFolder: string, _sourceFolder?: string): Promise<void> {
    const gmail = this.ensureConnected();

    // Get current labels to determine source
    const email = await this.getEmail(emailId);
    const currentLabels = email.labels || [];

    // Remove folder-type labels, add target
    const systemFolderLabels = ['INBOX', 'SENT', 'TRASH', 'SPAM', 'DRAFT'];
    const removeLabelIds = currentLabels.filter((l) =>
      systemFolderLabels.includes(l),
    );

    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: {
        addLabelIds: [targetFolder],
        removeLabelIds,
      },
    });
  }

  async deleteEmail(emailId: string, permanent?: boolean, _sourceFolder?: string): Promise<void> {
    const gmail = this.ensureConnected();

    if (permanent) {
      await gmail.users.messages.delete({ userId: 'me', id: emailId });
    } else {
      await gmail.users.messages.trash({ userId: 'me', id: emailId });
    }
  }

  async markEmail(
    emailId: string,
    flags: { read?: boolean; starred?: boolean; flagged?: boolean },
    _sourceFolder?: string,
  ): Promise<void> {
    const gmail = this.ensureConnected();
    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];

    if (flags.read === true) removeLabelIds.push('UNREAD');
    if (flags.read === false) addLabelIds.push('UNREAD');
    if (flags.starred === true || flags.flagged === true) addLabelIds.push('STARRED');
    if (flags.starred === false || flags.flagged === false) removeLabelIds.push('STARRED');

    if (addLabelIds.length > 0 || removeLabelIds.length > 0) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: emailId,
        requestBody: { addLabelIds, removeLabelIds },
      });
    }
  }

  async batchDelete(emailIds: string[], permanent?: boolean, _sourceFolder?: string): Promise<BatchResult> {
    const gmail = this.ensureConnected();
    const result: BatchResult = { succeeded: [], failed: [] };

    if (permanent) {
      // Gmail batchDelete permanently deletes
      try {
        await gmail.users.messages.batchDelete({
          userId: 'me',
          requestBody: { ids: emailIds },
        });
        result.succeeded = [...emailIds];
      } catch (error: any) {
        // If batch fails, try individually
        for (const id of emailIds) {
          try {
            await gmail.users.messages.delete({ userId: 'me', id });
            result.succeeded.push(id);
          } catch (e: any) {
            result.failed.push({ id, error: e.message });
          }
        }
      }
    } else {
      // Move to trash — no native batch, but batchModify can add TRASH label
      try {
        await gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: emailIds,
            addLabelIds: ['TRASH'],
            removeLabelIds: ['INBOX'],
          },
        });
        result.succeeded = [...emailIds];
      } catch (error: any) {
        for (const id of emailIds) {
          try {
            await gmail.users.messages.trash({ userId: 'me', id });
            result.succeeded.push(id);
          } catch (e: any) {
            result.failed.push({ id, error: e.message });
          }
        }
      }
    }

    return result;
  }

  async batchMove(emailIds: string[], targetFolder: string, _sourceFolder?: string): Promise<BatchResult> {
    const gmail = this.ensureConnected();
    const result: BatchResult = { succeeded: [], failed: [] };

    const systemFolderLabels = ['INBOX', 'SENT', 'TRASH', 'SPAM', 'DRAFT'];
    // Determine which labels to remove (remove all system folder labels)
    const removeLabelIds = systemFolderLabels;

    try {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: emailIds,
          addLabelIds: [targetFolder],
          removeLabelIds,
        },
      });
      result.succeeded = [...emailIds];
    } catch (error: any) {
      // Fallback to individual moves
      for (const id of emailIds) {
        try {
          await this.moveEmail(id, targetFolder);
          result.succeeded.push(id);
        } catch (e: any) {
          result.failed.push({ id, error: e.message });
        }
      }
    }

    return result;
  }

  async batchMark(emailIds: string[], flags: { read?: boolean; starred?: boolean; flagged?: boolean }, _sourceFolder?: string): Promise<BatchResult> {
    const gmail = this.ensureConnected();
    const result: BatchResult = { succeeded: [], failed: [] };

    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];

    if (flags.read === true) removeLabelIds.push('UNREAD');
    if (flags.read === false) addLabelIds.push('UNREAD');
    if (flags.starred === true || flags.flagged === true) addLabelIds.push('STARRED');
    if (flags.starred === false || flags.flagged === false) removeLabelIds.push('STARRED');

    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      result.succeeded = [...emailIds];
      return result;
    }

    try {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids: emailIds, addLabelIds, removeLabelIds },
      });
      result.succeeded = [...emailIds];
    } catch (error: any) {
      for (const id of emailIds) {
        try {
          await this.markEmail(id, flags);
          result.succeeded.push(id);
        } catch (e: any) {
          result.failed.push({ id, error: e.message });
        }
      }
    }

    return result;
  }

  async batchLabel(emailIds: string[], addLabels?: string[], removeLabels?: string[]): Promise<BatchResult> {
    const gmail = this.ensureConnected();
    const result: BatchResult = { succeeded: [], failed: [] };

    const addLabelIds = addLabels ?? [];
    const removeLabelIds = removeLabels ?? [];

    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      result.succeeded = [...emailIds];
      return result;
    }

    try {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids: emailIds, addLabelIds, removeLabelIds },
      });
      result.succeeded = [...emailIds];
    } catch (error: any) {
      for (const id of emailIds) {
        try {
          if (addLabelIds.length > 0) await this.addLabels(id, addLabelIds);
          if (removeLabelIds.length > 0) await this.removeLabels(id, removeLabelIds);
          result.succeeded.push(id);
        } catch (e: any) {
          result.failed.push({ id, error: e.message });
        }
      }
    }

    return result;
  }

  async getRawMessage(emailId: string, _sourceFolder?: string): Promise<Buffer> {
    const gmail = this.ensureConnected();
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: emailId,
      format: 'raw',
    });
    return Buffer.from(res.data.raw || '', 'base64url');
  }

  async appendRawMessage(
    raw: Buffer,
    targetFolder?: string,
    flags?: { read?: boolean; starred?: boolean },
  ): Promise<{ id: string }> {
    const gmail = this.ensureConnected();

    const labelIds: string[] = [];
    labelIds.push(targetFolder ? await this.resolveLabelId(targetFolder) : 'INBOX');
    if (flags?.read === false) labelIds.push('UNREAD');
    if (flags?.starred === true) labelIds.push('STARRED');

    const res = await gmail.users.messages.insert({
      userId: 'me',
      internalDateSource: 'dateHeader',
      requestBody: { labelIds },
      media: { mimeType: 'message/rfc822', body: Readable.from(raw) },
    });
    return { id: res.data.id || '' };
  }

  /** Resolve a Gmail label name or id to a label id (accepts either). */
  private async resolveLabelId(nameOrId: string): Promise<string> {
    const gmail = this.ensureConnected();
    const res = await gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels || [];
    const byId = labels.find((l) => l.id === nameOrId);
    if (byId?.id) return byId.id;
    const byName = labels.find((l) => (l.name || '').toLowerCase() === nameOrId.toLowerCase());
    if (byName?.id) return byName.id;
    return nameOrId; // assume it is already a valid label id
  }

  async addLabels(emailId: string, labels: string[]): Promise<void> {
    const gmail = this.ensureConnected();
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: { addLabelIds: labels },
    });
  }

  async removeLabels(emailId: string, labels: string[]): Promise<void> {
    const gmail = this.ensureConnected();
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: { removeLabelIds: labels },
    });
  }

  async listLabels(): Promise<Array<{ id: string; name: string; messageCount: number }>> {
    const gmail = this.ensureConnected();
    const res = await gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels || [];
    return labels.map((label: any) => ({
      id: label.id,
      name: label.name,
      messageCount: label.messagesTotal ?? 0,
    }));
  }

  /**
   * Trains Gmail's own spam filter — the same signal the "Report spam" UI
   * button sends (add SPAM, drop INBOX). Not an abuse report to Google.
   */
  async reportSpam(emailId: string, _sourceFolder?: string): Promise<void> {
    const gmail = this.ensureConnected();
    await gmail.users.messages.modify({
      userId: 'me',
      id: emailId,
      requestBody: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
    });
  }

  async createBlockRule(rule: BlockRuleInput): Promise<{ id: string }> {
    const gmail = this.ensureConnected();
    const criteria: Record<string, unknown> = {};

    switch (rule.matchType) {
      case 'senderDomain':
        // Gmail's own filter UI represents "any sender at this domain" as
        // a From value starting with '@' — this is standard filter syntax,
        // not a documented API field, but it's what Gmail itself generates.
        criteria.from = `@${rule.value}`;
        break;
      case 'senderAddress':
        criteria.from = rule.value;
        break;
      case 'subjectContains':
        criteria.subject = rule.value;
        break;
      case 'headerContains':
        // Gmail's filter API has no field for an arbitrary header (e.g.
        // Reply-To). `query` accepts full Gmail search syntax and Gmail
        // indexes most header content for search, so this is the closest
        // available match — a heuristic, not a guaranteed header match.
        criteria.query = rule.value;
        break;
    }

    // Gmail's filter Action rejects SPAM in addLabelIds ("Invalid label
    // SPAM in AddLabelIds") — confirmed live, not just from docs. Only
    // Gmail's own classifier can proactively mark future mail as spam;
    // a filter can't. The closest a filter can actually do is skip the
    // inbox (archive), which is what Gmail's own "Skip the Inbox" filter
    // action does — reportSpam (direct message action, not a filter)
    // remains the only way to add the SPAM label programmatically.
    const action =
      rule.action === 'delete'
        ? { addLabelIds: ['TRASH'] }
        : { removeLabelIds: ['INBOX'] };

    const res = await gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: { criteria, action },
    });

    return { id: res.data.id || '' };
  }

  async listBlockRules(): Promise<BlockRule[]> {
    const gmail = this.ensureConnected();
    const res = await gmail.users.settings.filters.list({ userId: 'me' });
    return (res.data.filter || []).map((f: any): BlockRule => {
      const criteria = f.criteria || {};
      const addLabelIds: string[] = f.action?.addLabelIds || [];
      let matchType: BlockRuleInput['matchType'] = 'headerContains';
      let value = criteria.query || '';
      if (typeof criteria.from === 'string' && criteria.from.startsWith('@')) {
        matchType = 'senderDomain';
        value = criteria.from.slice(1);
      } else if (criteria.from) {
        matchType = 'senderAddress';
        value = criteria.from;
      } else if (criteria.subject) {
        matchType = 'subjectContains';
        value = criteria.subject;
      }
      return {
        id: f.id || '',
        matchType,
        value,
        action: addLabelIds.includes('TRASH') ? 'delete' : 'moveToJunk',
        createdAt: '', // Gmail's filter API does not expose a creation timestamp
      };
    });
  }

  async deleteBlockRule(ruleId: string): Promise<void> {
    const gmail = this.ensureConnected();
    await gmail.users.settings.filters.delete({ userId: 'me', id: ruleId });
  }

  private buildRfc2822(params: SendEmailParams): string {
    const lines: string[] = [];
    lines.push(`From: ${this.email}`);
    lines.push(
      `To: ${params.to.map((c) => (c.name ? `"${c.name}" <${c.email}>` : c.email)).join(', ')}`,
    );
    if (params.cc?.length) {
      lines.push(`Cc: ${params.cc.map((c) => c.email).join(', ')}`);
    }
    if (params.bcc?.length) {
      lines.push(`Bcc: ${params.bcc.map((c) => c.email).join(', ')}`);
    }
    lines.push(`Subject: ${params.subject}`);
    if (params.inReplyTo) {
      lines.push(`In-Reply-To: ${params.inReplyTo}`);
    }
    if (params.references?.length) {
      lines.push(`References: ${params.references.join(' ')}`);
    }
    lines.push('MIME-Version: 1.0');
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(params.body.text || params.body.html || '');

    return Buffer.from(lines.join('\r\n')).toString('base64url');
  }
}
