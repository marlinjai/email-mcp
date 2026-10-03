import type { Folder, Email, Contact, AttachmentMeta, FolderTypeValue } from '../../models/types.js';
import { FolderType } from '../../models/types.js';

const SPECIAL_USE_MAP: Record<string, FolderTypeValue> = {
  '\\Inbox': FolderType.Inbox,
  '\\Sent': FolderType.Sent,
  '\\Drafts': FolderType.Drafts,
  '\\Trash': FolderType.Trash,
  '\\Junk': FolderType.Spam,
  '\\Archive': FolderType.Archive,
};

export function mapImapFolder(imapFolder: any): Folder {
  return {
    id: imapFolder.path,
    name: imapFolder.name,
    path: imapFolder.path,
    type: (imapFolder.specialUse && SPECIAL_USE_MAP[imapFolder.specialUse]) || FolderType.Other,
    totalCount: imapFolder.status?.messages,
    unreadCount: imapFolder.status?.unseen,
  };
}

/**
 * The id an attachment is listed under: its Content-ID when it has one,
 * otherwise its position in the message. `getAttachment` looks attachments up
 * with the same function, so every id handed out here resolves.
 */
export function imapAttachmentId(att: any, index: number): string {
  return att.contentId || `att-${index}`;
}

// mailparser's headerLines carry the whole raw line ("Message-ID: <x>",
// folded lines included). Callers want the value alone.
function headerValue(line: string): string {
  return line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
}

export function mapParsedEmail(parsed: any, folder: string, accountId: string, uid?: number): Email {
  const mapContact = (addr: any): Contact => ({
    name: addr.name || undefined,
    email: addr.address,
  });

  const mapContacts = (addrs: any): Contact[] => {
    if (!addrs?.value) return [];
    return addrs.value.map(mapContact);
  };

  const attachments: AttachmentMeta[] = (parsed.attachments || []).map((att: any, i: number) => ({
    id: imapAttachmentId(att, i),
    filename: att.filename || `attachment-${i}`,
    contentType: att.contentType || 'application/octet-stream',
    size: att.size || 0,
  }));

  const from = parsed.from?.value?.[0];

  return {
    id: String(uid || parsed.messageId || ''),
    accountId,
    threadId: parsed.references?.[0] || parsed.messageId,
    folder,
    from: from ? mapContact(from) : { email: 'unknown' },
    to: mapContacts(parsed.to),
    cc: parsed.cc ? mapContacts(parsed.cc) : undefined,
    bcc: parsed.bcc ? mapContacts(parsed.bcc) : undefined,
    subject: parsed.subject || '(no subject)',
    date: parsed.date?.toISOString() || new Date().toISOString(),
    body: {
      text: parsed.text,
      html: parsed.html || undefined,
    },
    snippet: parsed.text?.substring(0, 200),
    attachments,
    flags: {
      read: parsed.flags?.has('\\Seen') || false,
      starred: parsed.flags?.has('\\Flagged') || false,
      flagged: parsed.flags?.has('\\Flagged') || false,
      draft: parsed.flags?.has('\\Draft') || false,
    },
    headers: parsed.headerLines
      ? Object.fromEntries(parsed.headerLines.map((h: any) => [h.key, headerValue(h.line)]))
      : undefined,
  };
}
