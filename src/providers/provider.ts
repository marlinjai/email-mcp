import type {
  Email,
  Folder,
  Thread,
  SearchQuery,
  Contact,
  AttachmentMeta,
  AccountCredentials,
  ProviderTypeValue,
  BatchResult,
  BlockRuleInput,
  BlockRule,
  ForwardRuleInput,
  ForwardRule,
} from '../models/types.js';

export interface SendEmailParams {
  to: Contact[];
  cc?: Contact[];
  bcc?: Contact[];
  subject: string;
  body: { text?: string; html?: string };
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  inReplyTo?: string;
  references?: string[];
  /** Gmail thread to join. Header-based threading alone does not place a
   *  message in a Gmail thread; the API needs the threadId as well. Gmail in
   *  turn only accepts it next to In-Reply-To, References and a subject, so
   *  the adapter leaves it out when one of those is missing. */
  threadId?: string;
  /** Outlook: Graph item id of the message being replied to. Graph threads a
   *  reply only through createReply, which needs this id (not the RFC
   *  Message-ID in inReplyTo). Other providers ignore it. */
  replyToGraphId?: string;
}

export interface EmailProvider {
  readonly providerType: ProviderTypeValue;

  connect(credentials: AccountCredentials): Promise<void>;
  disconnect(): Promise<void>;
  testConnection(): Promise<{ success: boolean; folderCount: number; error?: string }>;

  listFolders(): Promise<Folder[]>;
  createFolder(name: string, parentPath?: string): Promise<Folder>;

  search(query: SearchQuery): Promise<Email[]>;
  // `sourceFolder` on getEmail and getAttachment: IMAP and iCloud ids are
  // UIDs, which only mean something inside one folder, so a message outside
  // INBOX needs its folder named. Gmail and Outlook ids are global and those
  // adapters ignore it. On getThread it is the one folder IMAP and iCloud
  // search for the thread's messages (INBOX when omitted).
  getEmail(id: string, sourceFolder?: string): Promise<Email>;
  getThread(threadId: string, sourceFolder?: string): Promise<Thread>;
  getAttachment(emailId: string, attachmentId: string, sourceFolder?: string): Promise<{ data: Buffer; meta: AttachmentMeta }>;

  sendEmail(params: SendEmailParams): Promise<{ id: string; threadId?: string }>;
  createDraft(params: SendEmailParams): Promise<{ id: string }>;
  // Gmail and Outlook update the draft message in place, so `id` is
  // unchanged on return. IMAP/iCloud have no in-place update primitive —
  // a draft is just a message in the Drafts folder, and IMAP messages are
  // immutable — so it's implemented there as delete-old + append-new,
  // which means the returned `id` is a NEW id and the old one no longer
  // resolves. Callers should always use the returned id going forward,
  // never assume it matches the id passed in.
  updateDraft(draftId: string, params: SendEmailParams, sourceFolder?: string): Promise<{ id: string }>;
  listDrafts(limit?: number, offset?: number): Promise<Email[]>;

  moveEmail(emailId: string, targetFolder: string, sourceFolder?: string): Promise<void>;
  deleteEmail(emailId: string, permanent?: boolean, sourceFolder?: string): Promise<void>;
  markEmail(emailId: string, flags: { read?: boolean; starred?: boolean; flagged?: boolean }, sourceFolder?: string): Promise<void>;

  // Batch operations (optional - providers that don't implement fall back to sequential)
  batchDelete?(emailIds: string[], permanent?: boolean, sourceFolder?: string): Promise<BatchResult>;
  batchMove?(emailIds: string[], targetFolder: string, sourceFolder?: string): Promise<BatchResult>;
  batchMark?(emailIds: string[], flags: { read?: boolean; starred?: boolean; flagged?: boolean }, sourceFolder?: string): Promise<BatchResult>;
  batchLabel?(emailIds: string[], addLabels?: string[], removeLabels?: string[]): Promise<BatchResult>;

  // Raw MIME transfer primitives (used for cross-account moves).
  // getRawMessage returns the full RFC822 message bytes.
  // appendRawMessage imports raw RFC822 bytes into the account, returning the new id.
  getRawMessage?(emailId: string, sourceFolder?: string): Promise<Buffer>;
  appendRawMessage?(
    raw: Buffer,
    targetFolder?: string,
    flags?: { read?: boolean; starred?: boolean },
  ): Promise<{ id: string }>;

  // Provider-specific (optional)
  addLabels?(emailId: string, labels: string[]): Promise<void>;
  removeLabels?(emailId: string, labels: string[]): Promise<void>;
  listLabels?(): Promise<Array<{ id: string; name: string; messageCount: number }>>;
  getCategories?(): Promise<string[]>;

  // Spam moderation (optional — see docs/plans/2026-08-27-spam-report-and-block-rules.md).
  // reportSpam trains the provider's own filter (the same signal "Report Junk"
  // sends in the UI); it is not an abuse report to the provider's security team.
  // Providers without a native filter/rule API (generic IMAP) implement only
  // reportSpam (best-effort move to a Junk-typed folder) and omit the rest.
  reportSpam?(emailId: string, sourceFolder?: string): Promise<void>;
  createBlockRule?(rule: BlockRuleInput): Promise<{ id: string }>;
  listBlockRules?(): Promise<BlockRule[]>;
  deleteBlockRule?(ruleId: string): Promise<void>;

  // Forwarding rules (optional, Gmail and Outlook only; see
  // docs/plans/2026-10-02-forward-rules.md). The allowlist check on the
  // target address happens in the tool layer, before any of these is called.
  // createForwardRule returns the existing rule's id with alreadyExisted set
  // when the same match already forwards to the same address.
  createForwardRule?(rule: ForwardRuleInput): Promise<{ id: string; alreadyExisted?: boolean }>;
  listForwardRules?(): Promise<ForwardRule[]>;
  deleteForwardRule?(ruleId: string): Promise<void>;
}
