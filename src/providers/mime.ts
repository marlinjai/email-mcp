import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { convert } from 'html-to-text';
import type { SendEmailParams } from './provider.js';
import type { Contact } from '../models/types.js';

/**
 * Derives a readable plain-text rendering of an HTML body, used as the
 * text/plain alternative when a caller only supplies HTML. Links keep their
 * target in brackets and images are dropped, so the text part reads like the
 * HTML part instead of showing markup.
 */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  }).trim();
}

/**
 * Resolves the body parts a message should carry:
 * - text only: text only (the message stays text/plain)
 * - html only: html plus a text part derived from it (multipart/alternative)
 * - both: both, exactly as given (multipart/alternative)
 * - neither: an empty text part
 */
export function normalizeBody(body: SendEmailParams['body']): { text: string; html?: string } {
  const html = body.html ? body.html : undefined;
  if (body.text) return { text: body.text, html };
  if (html) return { text: htmlToText(html), html };
  return { text: '' };
}

/**
 * Structured address objects let nodemailer quote display names that contain
 * commas or quotes and RFC 2047 encode non-ASCII names, which a hand-built
 * `"Name" <addr>` string does not.
 */
export function toAddress(contact: Contact): Mail.Address | string {
  return contact.name ? { name: contact.name, address: contact.email } : contact.email;
}

function toAddressList(contacts: Contact[] | undefined): Array<Mail.Address | string> | undefined {
  return contacts?.length ? contacts.map(toAddress) : undefined;
}

/**
 * Builds a complete RFC 5322 message (headers plus MIME body) for a send or a
 * draft. Headers such as Subject and display names are RFC 2047 encoded when
 * they carry non-ASCII characters, bodies are UTF-8 with quoted-printable or
 * base64 transfer encoding as needed, and attachments become
 * multipart/mixed parts.
 *
 * Bcc is kept in the headers on purpose: Gmail's `raw` send reads the
 * recipients from the Bcc header (and strips it before delivery), and a draft
 * has to remember its Bcc recipients. Never hand this output to an SMTP relay
 * without an explicit envelope.
 */
export async function buildMimeMessage(from: string, params: SendEmailParams): Promise<Buffer> {
  const { text, html } = normalizeBody(params.body);
  const mail: Mail.Options = {
    from,
    to: toAddressList(params.to),
    cc: toAddressList(params.cc),
    bcc: toAddressList(params.bcc),
    subject: params.subject,
    text,
    html,
    inReplyTo: params.inReplyTo,
    references: params.references?.length ? params.references : undefined,
    attachments: params.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  };

  const node = new MailComposer(mail).compile();
  node.keepBcc = true;
  return node.build();
}
