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
    hasAttachments: message.hasAttachments ?? undefined,
    categories: message.categories || [],
    inferenceClassification: message.inferenceClassification ?? undefined,
    webLink: message.webLink ?? undefined,
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

export function buildGraphFilter(query: any): { filter?: string; search?: string } {
  const filters: string[] = [];
  const searchParts: string[] = [];

  if (query.from) {
    filters.push(`from/emailAddress/address eq '${query.from}'`);
  }
  if (query.to) {
    filters.push(`toRecipients/any(r:r/emailAddress/address eq '${query.to}')`);
  }
  if (query.unreadOnly) {
    filters.push('isRead eq false');
  }
  if (query.starredOnly) {
    filters.push("importance eq 'high'");
  }
  if (query.hasAttachment) {
    filters.push('hasAttachments eq true');
  }
  if (query.since) {
    filters.push(`receivedDateTime ge ${query.since}`);
  }
  if (query.before) {
    filters.push(`receivedDateTime lt ${query.before}`);
  }

  if (query.subject) {
    searchParts.push(`subject:${query.subject}`);
  }
  if (query.body) {
    searchParts.push(`body:${query.body}`);
  }

  return {
    filter: filters.length > 0 ? filters.join(' and ') : undefined,
    search: searchParts.length > 0 ? `"${searchParts.join(' AND ')}"` : undefined,
  };
}
