import type { Folder, Email, Contact, AttachmentMeta, FolderTypeValue } from '../../models/types.js';
import { FolderType } from '../../models/types.js';

const WELL_KNOWN_FOLDER_MAP: Record<string, FolderTypeValue> = {
  inbox: FolderType.Inbox,
  sentitems: FolderType.Sent,
  drafts: FolderType.Drafts,
  deleteditems: FolderType.Trash,
  junkemail: FolderType.Spam,
  archive: FolderType.Archive,
};

// Maps localized display names to Graph API well-known folder names
const DISPLAY_NAME_TO_WELL_KNOWN: Record<string, string> = {
  // English
  'inbox': 'inbox',
  'sent items': 'sentitems',
  'sent': 'sentitems',
  'drafts': 'drafts',
  'deleted items': 'deleteditems',
  'trash': 'deleteditems',
  'junk email': 'junkemail',
  'junk': 'junkemail',
  'spam': 'junkemail',
  'archive': 'archive',
  // German
  'posteingang': 'inbox',
  'gesendete elemente': 'sentitems',
  'gesendet': 'sentitems',
  'entwürfe': 'drafts',
  'gelöschte elemente': 'deleteditems',
  'papierkorb': 'deleteditems',
  'junk-e-mail': 'junkemail',
  'archiv': 'archive',
  // Spanish
  'bandeja de entrada': 'inbox',
  'elementos enviados': 'sentitems',
  'enviados': 'sentitems',
  'borradores': 'drafts',
  'elementos eliminados': 'deleteditems',
  'correo no deseado': 'junkemail',
  'archivo': 'archive',
  // French
  'boîte de réception': 'inbox',
  'éléments envoyés': 'sentitems',
  'brouillons': 'drafts',
  'éléments supprimés': 'deleteditems',
  'courrier indésirable': 'junkemail',
  'archives': 'archive',
};

/**
 * Resolves a display name or well-known alias to a Graph API well-known folder name.
 * Returns undefined if not a recognized name.
 */
export function resolveWellKnownFolder(nameOrId: string): string | undefined {
  const lower = nameOrId.toLowerCase().trim();
  // Check if it's already a well-known name
  if (WELL_KNOWN_FOLDER_MAP[lower]) return lower;
  // Check display name mappings
  return DISPLAY_NAME_TO_WELL_KNOWN[lower];
}

export function mapGraphFolder(graphFolder: any): Folder {
  const wellKnown = graphFolder.wellKnownName?.toLowerCase();
  return {
    id: graphFolder.id,
    name: graphFolder.displayName,
    path: graphFolder.displayName,
    type: (wellKnown && WELL_KNOWN_FOLDER_MAP[wellKnown]) || FolderType.Other,
    totalCount: graphFolder.totalItemCount,
    unreadCount: graphFolder.unreadItemCount,
  };
}

function mapGraphContact(recipient: any): Contact {
  return {
    name: recipient?.emailAddress?.name || undefined,
    email: recipient?.emailAddress?.address || '',
  };
}

function mapGraphContacts(recipients: any[]): Contact[] {
  if (!recipients) return [];
  return recipients.map(mapGraphContact);
}

export function mapGraphMessage(message: any, accountId: string): Email {
  const bodyType = message.body?.contentType?.toLowerCase();

  return {
    id: message.id,
    accountId,
    threadId: message.conversationId,
    folder: message.parentFolderId || '',
    from: mapGraphContact(message.from),
    to: mapGraphContacts(message.toRecipients),
    cc: message.ccRecipients?.length ? mapGraphContacts(message.ccRecipients) : undefined,
    bcc: message.bccRecipients?.length ? mapGraphContacts(message.bccRecipients) : undefined,
    subject: message.subject || '(no subject)',
    date: message.receivedDateTime || new Date().toISOString(),
    body: {
      text: bodyType === 'text' ? message.body?.content : undefined,
      html: bodyType === 'html' ? message.body?.content : undefined,
    },
    snippet: message.bodyPreview,
    attachments: [],
    categories: message.categories || [],
    flags: {
      read: message.isRead ?? false,
      starred: message.importance === 'high',
      flagged: message.flag?.flagStatus === 'flagged',
      draft: message.isDraft ?? false,
    },
  };
}

export function mapGraphAttachment(attachment: any): AttachmentMeta {
  return {
    id: attachment.id,
    filename: attachment.name || 'unknown',
    contentType: attachment.contentType || 'application/octet-stream',
    size: attachment.size || 0,
  };
}

/**
 * Microsoft Graph refuses several combinations that look harmless:
 *  - `$search` cannot be combined with `$filter`, `$orderby` or `$skip`.
 *  - `from/emailAddress/address eq ...` plus `$orderby receivedDateTime` answers
 *    "The restriction or sort order is too complex for this operation".
 *
 * So whenever the query carries any text criterion (from, to, subject, body) the
 * whole query is expressed as one Keyword Query Language (KQL) `$search` string,
 * and the two flags KQL cannot express (unread, starred) are applied client-side.
 * A query without text criteria keeps the cheap `$filter` plus `$orderby` path.
 */
export interface GraphQueryPlan {
  /** OData `$filter`; only set when no `$search` is used. */
  filter?: string;
  /** KQL `$search` string; when set, `$filter`, `$orderby` and `$skip` must not be sent. */
  search?: string;
  /** Criteria KQL cannot express, applied to the returned messages. */
  clientSide: { unreadOnly?: boolean; starredOnly?: boolean };
}

/**
 * Quote a KQL value so spaces, hyphens and operators stay inside one term. The whole
 * `$search` string is itself wrapped in double quotes, so the inner quotes are
 * backslash-escaped (verified against the live Graph API: a raw inner quote is a
 * syntax error). Quote and backslash characters in the value are replaced by spaces
 * so a value can never close its own term.
 */
function kqlValue(value: string): string {
  return `\\"${String(value).replace(/["\\]/g, ' ').trim()}\\"`;
}

/** KQL date comparisons take a plain yyyy-mm-dd date. */
function kqlDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : parsed.toISOString().slice(0, 10);
}

export function buildGraphFilter(query: any): GraphQueryPlan {
  const hasText = Boolean(query.from || query.to || query.subject || query.body);

  if (hasText) {
    const parts: string[] = [];
    if (query.from) parts.push(`from:${kqlValue(query.from)}`);
    if (query.to) parts.push(`to:${kqlValue(query.to)}`);
    if (query.subject) parts.push(`subject:${kqlValue(query.subject)}`);
    if (query.body) parts.push(`body:${kqlValue(query.body)}`);
    if (query.hasAttachment) parts.push('hasattachments:true');
    if (query.since) parts.push(`received>=${kqlDate(query.since)}`);
    if (query.before) parts.push(`received<${kqlDate(query.before)}`);
    return {
      search: `"${parts.join(' AND ')}"`,
      clientSide: {
        ...(query.unreadOnly ? { unreadOnly: true } : {}),
        ...(query.starredOnly ? { starredOnly: true } : {}),
      },
    };
  }

  const filters: string[] = [];
  if (query.unreadOnly) filters.push('isRead eq false');
  if (query.starredOnly) filters.push("importance eq 'high'");
  if (query.hasAttachment) filters.push('hasAttachments eq true');
  if (query.since) filters.push(`receivedDateTime ge ${query.since}`);
  if (query.before) filters.push(`receivedDateTime lt ${query.before}`);
  return { filter: filters.length > 0 ? filters.join(' and ') : undefined, clientSide: {} };
}
