import type {
  Folder,
  Email,
  Contact,
  AttachmentMeta,
  FolderTypeValue,
  SearchQuery,
} from '../../models/types.js';
import { FolderType } from '../../models/types.js';

const LABEL_TYPE_MAP: Record<string, FolderTypeValue> = {
  INBOX: FolderType.Inbox,
  SENT: FolderType.Sent,
  DRAFT: FolderType.Drafts,
  TRASH: FolderType.Trash,
  SPAM: FolderType.Spam,
  STARRED: FolderType.Other,
  IMPORTANT: FolderType.Other,
  CATEGORY_PERSONAL: FolderType.Other,
  CATEGORY_SOCIAL: FolderType.Other,
  CATEGORY_PROMOTIONS: FolderType.Other,
  CATEGORY_UPDATES: FolderType.Other,
  CATEGORY_FORUMS: FolderType.Other,
};

export function mapGmailLabel(label: any): Folder {
  return {
    id: label.id,
    name: label.name,
    path: label.id,
    type: LABEL_TYPE_MAP[label.id] ?? FolderType.Other,
    totalCount: label.messagesTotal ?? 0,
    unreadCount: label.messagesUnread ?? 0,
  };
}

function getHeader(headers: any[], name: string): string | undefined {
  const header = headers?.find(
    (h: any) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return header?.value;
}

function parseContact(raw: string): Contact {
  // Formats: "Name <email>" or "email"
  const match = raw.match(/^"?(.+?)"?\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { email: raw.trim() };
}

function parseContacts(raw: string | undefined): Contact[] {
  if (!raw) return [];
  return raw.split(',').map((s) => parseContact(s.trim()));
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

export function extractBody(
  payload: any,
): { text?: string; html?: string } {
  const result: { text?: string; html?: string } = {};

  if (!payload) return result;

  // Single-part message
  if (payload.body?.data && payload.mimeType) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/plain') result.text = decoded;
    if (payload.mimeType === 'text/html') result.html = decoded;
    return result;
  }

  // Multi-part message
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        result.text = decodeBase64Url(part.body.data);
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        result.html = decodeBase64Url(part.body.data);
      } else if (part.parts) {
        // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
        const nested = extractBody(part);
        if (nested.text && !result.text) result.text = nested.text;
        if (nested.html && !result.html) result.html = nested.html;
      }
    }
  }

  return result;
}

function extractAttachments(payload: any): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];

  if (!payload?.parts) return attachments;

  for (const part of payload.parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        filename: part.filename,
        contentType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
      });
    }
    // Recurse into nested parts
    if (part.parts) {
      attachments.push(...extractAttachments(part));
    }
  }

  return attachments;
}

// The headers a reply is built from, under lower-case names like the IMAP
// mapper uses. Without them a reply has no Message-ID to point at.
function threadingHeaders(headers: any[]): Record<string, string> | undefined {
  const picked: Record<string, string> = {};
  for (const name of ['Message-ID', 'In-Reply-To', 'References']) {
    const value = getHeader(headers, name);
    if (value) picked[name.toLowerCase()] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function mapGmailMessage(message: any, accountId: string): Email {
  const headers = message.payload?.headers || [];
  const labelIds: string[] = message.labelIds || [];

  const from = parseContact(getHeader(headers, 'From') || 'unknown@unknown.com');
  const to = parseContacts(getHeader(headers, 'To'));
  const cc = parseContacts(getHeader(headers, 'Cc'));
  const bcc = parseContacts(getHeader(headers, 'Bcc'));
  const subject = getHeader(headers, 'Subject') || '(no subject)';
  const dateStr = getHeader(headers, 'Date');
  const date = dateStr
    ? new Date(dateStr).toISOString()
    : new Date(parseInt(message.internalDate, 10)).toISOString();

  const body = extractBody(message.payload);
  const attachments = extractAttachments(message.payload);

  // Determine folder from labels
  let folder = 'INBOX';
  for (const labelId of labelIds) {
    if (LABEL_TYPE_MAP[labelId] && labelId !== 'STARRED' && labelId !== 'IMPORTANT') {
      folder = labelId;
      break;
    }
  }

  return {
    id: message.id,
    accountId,
    threadId: message.threadId,
    folder,
    from,
    to,
    cc: cc.length > 0 ? cc : undefined,
    bcc: bcc.length > 0 ? bcc : undefined,
    subject,
    date,
    body,
    snippet: message.snippet,
    attachments,
    labels: labelIds,
    headers: threadingHeaders(headers),
    flags: {
      read: !labelIds.includes('UNREAD'),
      starred: labelIds.includes('STARRED'),
      flagged: labelIds.includes('STARRED'),
      draft: labelIds.includes('DRAFT'),
    },
  };
}

export function buildGmailQuery(query: SearchQuery): string {
  const parts: string[] = [];

  if (query.from) parts.push(`from:${query.from}`);
  if (query.to) parts.push(`to:${query.to}`);
  if (query.subject) parts.push(`subject:${query.subject}`);
  if (query.body) parts.push(query.body);
  if (query.since) {
    const d = new Date(query.since);
    parts.push(`after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  }
  if (query.before) {
    const d = new Date(query.before);
    parts.push(`before:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  }
  if (query.unreadOnly) parts.push('is:unread');
  if (query.starredOnly) parts.push('is:starred');
  if (query.hasAttachment) parts.push('has:attachment');

  return parts.join(' ');
}
