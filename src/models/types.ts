export const ProviderType = {
  Gmail: 'gmail',
  Outlook: 'outlook',
  ICloud: 'icloud',
  IMAP: 'imap',
} as const;

export type ProviderTypeValue = (typeof ProviderType)[keyof typeof ProviderType];

export const FolderType = {
  Inbox: 'inbox',
  Sent: 'sent',
  Drafts: 'drafts',
  Trash: 'trash',
  Spam: 'spam',
  Archive: 'archive',
  Other: 'other',
} as const;

export type FolderTypeValue = (typeof FolderType)[keyof typeof FolderType];

export function isProviderSupported(provider: string): provider is ProviderTypeValue {
  return Object.values(ProviderType).includes(provider as ProviderTypeValue);
}

export interface Contact {
  name?: string;
  email: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface Email {
  id: string;
  accountId: string;
  threadId?: string;
  folder: string;
  from: Contact;
  to: Contact[];
  cc?: Contact[];
  bcc?: Contact[];
  subject: string;
  date: string;
  body: { text?: string; html?: string };
  snippet?: string;
  attachments: AttachmentMeta[];
  labels?: string[];
  categories?: string[];
  flags: {
    read: boolean;
    starred: boolean;
    flagged: boolean;
    draft: boolean;
  };
  headers?: Record<string, string>;
  truncated?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  path: string;
  type?: FolderTypeValue;
  unreadCount?: number;
  totalCount?: number;
  children?: Folder[];
}

export interface Thread {
  id: string;
  subject: string;
  participants: Contact[];
  messageCount: number;
  messages: Email[];
  lastMessageDate: string;
}

export interface SearchQuery {
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  hasAttachment?: boolean;
  limit?: number;
  offset?: number;
  returnBody?: boolean;
}

export interface Account {
  id: string;
  name: string;
  provider: ProviderTypeValue;
  email: string;
  connected: boolean;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expiry: string;
  /** MSAL home account ID for acquireTokenSilent (Outlook only) */
  msal_home_account_id?: string;
}

export interface PasswordCredentials {
  password: string;
  host: string;
  port: number;
  tls: boolean;
  smtpHost?: string;
  smtpPort?: number;
}

export interface AccountCredentials {
  id: string;
  name: string;
  provider: ProviderTypeValue;
  email: string;
  oauth?: OAuthTokens;
  password?: PasswordCredentials;
}

export interface ProviderError {
  success: false;
  error: string;
  provider?: string;
  supportedProviders?: string[];
}

export interface ProviderSuccess<T> {
  success: true;
  data: T;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderError;

export interface BatchResult {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * A rule that intercepts future mail matching a pattern, before it's
 * even filed to a folder. `headerContains` is the general escape hatch for
 * matching a stable element of a spam template (e.g. a Reply-To domain)
 * when the visible From address/domain rotates.
 */
export interface BlockRuleInput {
  matchType: 'senderDomain' | 'senderAddress' | 'subjectContains' | 'headerContains';
  value: string;
  /** Required when matchType is 'headerContains', e.g. 'Reply-To'. */
  headerName?: string;
  action: 'delete' | 'moveToJunk';
}

export interface BlockRule extends BlockRuleInput {
  id: string;
  createdAt: string;
}

/**
 * A standing rule that forwards future mail matching a pattern to another
 * address. Forwarding is the classic way mail leaves a mailbox unnoticed, so
 * the tool layer only accepts targets the user listed in
 * EMAIL_MCP_FORWARD_ALLOWLIST (see src/tools/forwarding.ts).
 */
export interface ForwardRuleInput {
  matchType: 'senderDomain' | 'senderAddress' | 'subjectContains' | 'headerContains';
  value: string;
  forwardTo: string;
  /** When false the original skips the inbox (archived). */
  keepInInbox: boolean;
}

export interface ForwardRule extends ForwardRuleInput {
  id: string;
  createdAt: string;
}
