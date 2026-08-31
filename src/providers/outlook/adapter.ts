import { Client } from '@microsoft/microsoft-graph-client';
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
import { mapGraphFolder, mapGraphMessage, mapGraphAttachment, buildGraphFilter, resolveWellKnownFolder } from './mapper.js';

export class OutlookAdapter implements EmailProvider {
  readonly providerType: ProviderTypeValue = ProviderType.Outlook;
  private client: InstanceType<typeof Client> | null = null;
  private accountId: string = '';
  private accessToken: string = '';
  private folderIdCache: Map<string, string> = new Map();

  async connect(credentials: AccountCredentials): Promise<void> {
    if (!credentials.oauth) {
      throw new Error('Outlook adapter requires OAuth credentials');
    }
    this.accountId = credentials.id;
    this.accessToken = credentials.oauth.access_token;

    const client = Client.init({
      authProvider: (done) => {
        done(null, this.accessToken);
      },
    });

    // Wrap the api() method to inject `Prefer: IdType="ImmutableId"` on every
    // request.  This makes the Graph API return stable, immutable message IDs
    // that survive moves across folders.  Without this, older Outlook.com
    // messages can have IDs in a shorter format that the API rejects as
    // "Id is malformed" when the message has been moved internally.
    const originalApi = client.api.bind(client);
    client.api = (path: string) => {
      return originalApi(path).header('Prefer', 'IdType="ImmutableId"');
    };

    this.client = client;
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.accessToken = '';
  }

  async testConnection(): Promise<{ success: boolean; folderCount: number; error?: string }> {
    try {
      const folders = await this.listFolders();
      return { success: true, folderCount: folders.length };
    } catch (error: any) {
      return { success: false, folderCount: 0, error: error.message };
    }
  }

  private ensureClient(): InstanceType<typeof Client> {
    if (!this.client) throw new Error('Not connected');
    return this.client;
  }

  /**
   * Resolves a folder name/display name/ID to a valid Graph API folder reference.
   * Handles well-known names, localized display names, and raw folder IDs.
   */
  async resolveFolder(nameOrId: string): Promise<string> {
    // Check well-known name mappings (handles localized display names)
    const wellKnown = resolveWellKnownFolder(nameOrId);
    if (wellKnown) return wellKnown;

    // Check cache
    const cached = this.folderIdCache.get(nameOrId.toLowerCase());
    if (cached) return cached;

    // Looks like a raw folder ID (long base64 string) — use as-is
    if (nameOrId.length > 40) return nameOrId;

    // Fall back to listing folders and matching by display name
    const client = this.ensureClient();
    const response = await client.api('/me/mailFolders').get();
    const folders = response.value || [];
    for (const folder of folders) {
      // Cache all folders while we're at it
      this.folderIdCache.set(folder.displayName.toLowerCase(), folder.id);
      if (folder.displayName.toLowerCase() === nameOrId.toLowerCase()) {
        return folder.id;
      }
    }

    // Nothing matched — return original value and let Graph API error naturally
    return nameOrId;
  }

  async listFolders(): Promise<Folder[]> {
    const client = this.ensureClient();
    const response = await client.api('/me/mailFolders').get();
    return (response.value || []).map(mapGraphFolder);
  }

  async createFolder(name: string, parentPath?: string): Promise<Folder> {
    const client = this.ensureClient();
    const endpoint = parentPath
      ? `/me/mailFolders/${encodeURIComponent(parentPath)}/childFolders`
      : '/me/mailFolders';
    const result = await client.api(endpoint).post({ displayName: name });
    return mapGraphFolder(result);
  }

  async search(query: SearchQuery): Promise<Email[]> {
    const client = this.ensureClient();
    let endpoint = '/me/messages';
    if (query.folder) {
      const folderId = await this.resolveFolder(query.folder);
      endpoint = `/me/mailFolders/${encodeURIComponent(folderId)}/messages`;
    }

    const { filter, search } = buildGraphFilter(query);
    let request = client.api(endpoint);

    // When body is not needed, use $select to exclude it — dramatically reduces payload
    if (!query.returnBody) {
      request = request.select('id,conversationId,parentFolderId,from,toRecipients,ccRecipients,bccRecipients,subject,receivedDateTime,bodyPreview,hasAttachments,isRead,importance,flag,isDraft,categories');
    }

    if (filter) {
      request = request.filter(filter);
    }
    if (search) {
      request = request.search(search);
    }
    if (query.limit) {
      request = request.top(query.limit);
    }
    if (query.offset) {
      request = request.skip(query.offset);
    }

    request = request.orderby('receivedDateTime desc');

    const response = await request.get();
    return (response.value || []).map((msg: any) => mapGraphMessage(msg, this.accountId));
  }

  async getEmail(id: string): Promise<Email> {
    const client = this.ensureClient();
    const message = await client.api(`/me/messages/${encodeURIComponent(id)}`).get();
    const email = mapGraphMessage(message, this.accountId);

    if (message.hasAttachments) {
      const attachments = await client.api(`/me/messages/${encodeURIComponent(id)}/attachments`).get();
      email.attachments = (attachments.value || []).map(mapGraphAttachment);
    }

    return email;
  }

  async getThread(threadId: string): Promise<Thread> {
    const client = this.ensureClient();
    const response = await client
      .api('/me/messages')
      .filter(`conversationId eq '${threadId}'`)
      .orderby('receivedDateTime asc')
      .get();

    const messages: Email[] = (response.value || []).map((msg: any) =>
      mapGraphMessage(msg, this.accountId)
    );

    const participantMap = new Map<string, { name?: string; email: string }>();
    for (const msg of messages) {
      participantMap.set(msg.from.email, msg.from);
      for (const to of msg.to) {
        participantMap.set(to.email, to);
      }
    }

    return {
      id: threadId,
      subject: messages[0]?.subject || '',
      participants: Array.from(participantMap.values()),
      messageCount: messages.length,
      messages,
      lastMessageDate: messages[messages.length - 1]?.date || '',
    };
  }

  async getAttachment(
    emailId: string,
    attachmentId: string
  ): Promise<{ data: Buffer; meta: AttachmentMeta }> {
    const client = this.ensureClient();
    const attachment = await client
      .api(`/me/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`)
      .get();

    return {
      data: Buffer.from(attachment.contentBytes || '', 'base64'),
      meta: mapGraphAttachment(attachment),
    };
  }

  async sendEmail(params: SendEmailParams): Promise<{ id: string; threadId?: string }> {
    const client = this.ensureClient();
    const message = this.buildGraphMessage(params);

    const payload: any = { message };
    if (params.attachments?.length) {
      payload.message.attachments = params.attachments.map((att) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: att.filename,
        contentType: att.contentType,
        contentBytes: att.content.toString('base64'),
      }));
    }

    await client.api('/me/sendMail').post(payload);

    return { id: `sent-${Date.now()}` };
  }

  async createDraft(params: SendEmailParams): Promise<{ id: string }> {
    const client = this.ensureClient();
    const message = this.buildGraphMessage(params);

    const result = await client.api('/me/messages').post(message);
    return { id: result.id };
  }

  async updateDraft(draftId: string, params: SendEmailParams): Promise<{ id: string }> {
    const client = this.ensureClient();
    const message = this.buildGraphMessage(params);

    await client.api(`/me/messages/${encodeURIComponent(draftId)}`).patch(message);
    return { id: draftId };
  }

  async listDrafts(limit?: number, offset?: number): Promise<Email[]> {
    const client = this.ensureClient();
    let request = client.api('/me/mailFolders/drafts/messages');

    if (limit !== undefined) {
      request = request.top(limit);
    }
    if (offset !== undefined) {
      request = request.skip(offset);
    }

    request = request.orderby('receivedDateTime desc');

    const response = await request.get();
    return (response.value || []).map((msg: any) => mapGraphMessage(msg, this.accountId));
  }

  async moveEmail(emailId: string, targetFolder: string, _sourceFolder?: string): Promise<void> {
    const client = this.ensureClient();
    const destinationId = await this.resolveFolder(targetFolder);
    await client.api(`/me/messages/${encodeURIComponent(emailId)}/move`).post({
      destinationId,
    });
  }

  async getRawMessage(emailId: string, _sourceFolder?: string): Promise<Buffer> {
    this.ensureClient();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(emailId)}/$value`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
    if (!res.ok) {
      throw new Error(`Graph $value fetch failed for ${emailId}: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async appendRawMessage(
    raw: Buffer,
    targetFolder?: string,
    flags?: { read?: boolean; starred?: boolean },
  ): Promise<{ id: string }> {
    this.ensureClient();
    const endpoint = targetFolder
      ? `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(await this.resolveFolder(targetFolder))}/messages`
      : 'https://graph.microsoft.com/v1.0/me/messages';

    // Graph imports an RFC822 message when the body is base64 MIME with a text/plain content type.
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'text/plain',
      },
      body: raw.toString('base64'),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Graph MIME import failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const data: any = await res.json().catch(() => ({}));

    // Imported messages default to unread; apply requested read/starred state best-effort.
    if (flags && data.id && (flags.read !== undefined || flags.starred !== undefined)) {
      try {
        await this.markEmail(data.id, flags);
      } catch { /* best-effort */ }
    }
    return { id: data.id || '' };
  }

  async deleteEmail(emailId: string, permanent?: boolean, _sourceFolder?: string): Promise<void> {
    const client = this.ensureClient();
    if (permanent) {
      await client.api(`/me/messages/${encodeURIComponent(emailId)}`).delete();
    } else {
      await client.api(`/me/messages/${encodeURIComponent(emailId)}/move`).post({
        destinationId: 'deleteditems',
      });
    }
  }

  async markEmail(
    emailId: string,
    flags: { read?: boolean; starred?: boolean; flagged?: boolean },
    _sourceFolder?: string,
  ): Promise<void> {
    const client = this.ensureClient();
    const patch: any = {};

    if (flags.read !== undefined) {
      patch.isRead = flags.read;
    }
    if (flags.starred !== undefined) {
      patch.importance = flags.starred ? 'high' : 'normal';
    }
    if (flags.flagged !== undefined) {
      patch.flag = { flagStatus: flags.flagged ? 'flagged' : 'notFlagged' };
    }

    await client.api(`/me/messages/${encodeURIComponent(emailId)}`).patch(patch);
  }

  private async executeBatch(requests: Array<{ id: string; method: string; url: string; body?: any }>): Promise<Map<string, { status: number; body?: any }>> {
    const client = this.ensureClient();
    const results = new Map<string, { status: number; body?: any }>();

    // Graph API allows max 20 requests per batch
    for (let i = 0; i < requests.length; i += 20) {
      const chunk = requests.slice(i, i + 20);

      // Use sequential numeric IDs for the batch request `id` field instead of
      // raw message IDs. The batch `id` is a correlation value only — it is
      // case-INsensitive and must be unique within the batch. Outlook message
      // IDs are long base64 strings that can collide under case-insensitive
      // comparison, causing "Id is malformed" or duplicate-id errors.
      const indexToId = new Map<string, string>();
      const batchPayload = {
        requests: chunk.map((req, idx) => {
          const batchId = String(idx);
          indexToId.set(batchId, req.id);
          return {
            id: batchId,
            method: req.method,
            url: req.url,
            ...(req.body ? { body: req.body, headers: { 'Content-Type': 'application/json' } } : {}),
          };
        }),
      };

      const response = await client.api('/$batch').post(batchPayload);
      for (const resp of response.responses || []) {
        // Map the sequential batch id back to the original email id
        const originalId = indexToId.get(resp.id) ?? resp.id;
        results.set(originalId, { status: resp.status, body: resp.body });
      }
    }

    return results;
  }

  async batchDelete(emailIds: string[], permanent?: boolean, _sourceFolder?: string): Promise<BatchResult> {
    const result: BatchResult = { succeeded: [], failed: [] };

    if (permanent) {
      const requests = emailIds.map((id) => ({
        id,
        method: 'DELETE',
        url: `/me/messages/${encodeURIComponent(id)}`,
      }));
      const responses = await this.executeBatch(requests);
      for (const [id, resp] of responses) {
        if (resp.status >= 200 && resp.status < 300) {
          result.succeeded.push(id);
        } else {
          result.failed.push({ id, error: resp.body?.error?.message || `HTTP ${resp.status}` });
        }
      }
    } else {
      const requests = emailIds.map((id) => ({
        id,
        method: 'POST',
        url: `/me/messages/${encodeURIComponent(id)}/move`,
        body: { destinationId: 'deleteditems' },
      }));
      const responses = await this.executeBatch(requests);
      for (const [id, resp] of responses) {
        if (resp.status >= 200 && resp.status < 300) {
          result.succeeded.push(id);
        } else {
          result.failed.push({ id, error: resp.body?.error?.message || `HTTP ${resp.status}` });
        }
      }
    }

    return result;
  }

  async batchMove(emailIds: string[], targetFolder: string, _sourceFolder?: string): Promise<BatchResult> {
    const result: BatchResult = { succeeded: [], failed: [] };
    const destinationId = await this.resolveFolder(targetFolder);

    const requests = emailIds.map((id) => ({
      id,
      method: 'POST',
      url: `/me/messages/${encodeURIComponent(id)}/move`,
      body: { destinationId },
    }));

    const responses = await this.executeBatch(requests);
    for (const [id, resp] of responses) {
      if (resp.status >= 200 && resp.status < 300) {
        result.succeeded.push(id);
      } else {
        result.failed.push({ id, error: resp.body?.error?.message || `HTTP ${resp.status}` });
      }
    }

    return result;
  }

  async batchMark(emailIds: string[], flags: { read?: boolean; starred?: boolean; flagged?: boolean }, _sourceFolder?: string): Promise<BatchResult> {
    const result: BatchResult = { succeeded: [], failed: [] };
    const patch: any = {};

    if (flags.read !== undefined) patch.isRead = flags.read;
    if (flags.starred !== undefined) patch.importance = flags.starred ? 'high' : 'normal';
    if (flags.flagged !== undefined) patch.flag = { flagStatus: flags.flagged ? 'flagged' : 'notFlagged' };

    if (Object.keys(patch).length === 0) {
      result.succeeded = [...emailIds];
      return result;
    }

    const requests = emailIds.map((id) => ({
      id,
      method: 'PATCH',
      url: `/me/messages/${encodeURIComponent(id)}`,
      body: patch,
    }));

    const responses = await this.executeBatch(requests);
    for (const [id, resp] of responses) {
      if (resp.status >= 200 && resp.status < 300) {
        result.succeeded.push(id);
      } else {
        result.failed.push({ id, error: resp.body?.error?.message || `HTTP ${resp.status}` });
      }
    }

    return result;
  }

  /**
   * Trains Outlook's own spam filter — the same signal "Report Junk" sends
   * in the UI (move to the Junk Email well-known folder). Not an abuse
   * report to Microsoft's security team.
   */
  async reportSpam(emailId: string, _sourceFolder?: string): Promise<void> {
    const client = this.ensureClient();
    await client.api(`/me/messages/${encodeURIComponent(emailId)}/move`).post({
      destinationId: 'junkemail',
    });
  }

  /**
   * Requires the `MailboxSettings.ReadWrite` delegated scope, confirmed by
   * Microsoft's own docs to be supported for personal Microsoft accounts
   * (outlook.com/hotmail), not just work/school. Accounts authenticated
   * before this scope was added need to re-run the setup wizard to
   * re-consent — old tokens will 403 on this call until then.
   */
  async createBlockRule(rule: BlockRuleInput): Promise<{ id: string }> {
    const client = this.ensureClient();
    const conditions: any = {};

    switch (rule.matchType) {
      case 'senderDomain':
      case 'senderAddress':
        // Graph's senderContains does substring matching against the From
        // address, so a bare domain (e.g. "getdrip.com") already matches
        // any sender at that domain — no "@" prefix needed.
        conditions.senderContains = [rule.value];
        break;
      case 'subjectContains':
        conditions.subjectContains = [rule.value];
        break;
      case 'headerContains':
        // Matches any header's raw content — the right predicate for a
        // stable element (e.g. a Reply-To domain) when the From domain
        // rotates across a spam template family.
        conditions.headerContains = [rule.value];
        break;
    }

    const actions: any = { stopProcessingRules: true };
    if (rule.action === 'delete') {
      actions.delete = true;
    } else {
      actions.moveToFolder = await this.resolveFolder('junkemail');
    }

    const existing = await this.listBlockRules();
    const result = await client.api('/me/mailFolders/inbox/messageRules').post({
      displayName: `email-mcp: ${rule.matchType} "${rule.value}"`.slice(0, 255),
      sequence: existing.length + 1,
      isEnabled: true,
      conditions,
      actions,
    });

    return { id: result.id };
  }

  async listBlockRules(): Promise<BlockRule[]> {
    const client = this.ensureClient();
    const response = await client.api('/me/mailFolders/inbox/messageRules').get();
    return (response.value || []).map((r: any): BlockRule => {
      const conditions = r.conditions || {};
      let matchType: BlockRuleInput['matchType'] = 'headerContains';
      let value = '';
      // Graph doesn't tag which of our four matchTypes a rule came from —
      // this reconstruction is a best-effort heuristic for listing/auditing,
      // not a guaranteed round-trip of what was originally requested.
      if (conditions.senderContains?.length) {
        value = conditions.senderContains[0];
        matchType = value.includes('@') ? 'senderAddress' : 'senderDomain';
      } else if (conditions.subjectContains?.length) {
        matchType = 'subjectContains';
        value = conditions.subjectContains[0];
      } else if (conditions.headerContains?.length) {
        matchType = 'headerContains';
        value = conditions.headerContains[0];
      }
      return {
        id: r.id,
        matchType,
        value,
        action: r.actions?.delete ? 'delete' : 'moveToJunk',
        createdAt: '', // Graph's messageRule resource has no creation timestamp field
      };
    });
  }

  async deleteBlockRule(ruleId: string): Promise<void> {
    const client = this.ensureClient();
    await client.api(`/me/mailFolders/inbox/messageRules/${encodeURIComponent(ruleId)}`).delete();
  }

  async getCategories(): Promise<string[]> {
    const client = this.ensureClient();
    const response = await client.api('/me/outlook/masterCategories').get();
    return (response.value || []).map((cat: any) => cat.displayName);
  }

  private buildGraphMessage(params: SendEmailParams): any {
    const toGraphRecipient = (contact: { name?: string; email: string }) => ({
      emailAddress: { name: contact.name, address: contact.email },
    });

    const bodyContent = params.body.html || params.body.text || '';
    const contentType = params.body.html ? 'html' : 'text';

    const message: any = {
      subject: params.subject,
      body: { contentType, content: bodyContent },
      toRecipients: params.to.map(toGraphRecipient),
    };

    if (params.cc?.length) {
      message.ccRecipients = params.cc.map(toGraphRecipient);
    }
    if (params.bcc?.length) {
      message.bccRecipients = params.bcc.map(toGraphRecipient);
    }

    return message;
  }
}
