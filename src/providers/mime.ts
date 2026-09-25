import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { SendEmailParams } from './provider.js';

const formatContact = (c: { name?: string; email: string }) =>
  c.name ? `"${c.name}" <${c.email}>` : c.email;

/**
 * Build a complete RFC 822 message (multipart when there is an HTML body or
 * attachments) from SendEmailParams. Used by the Gmail API paths and IMAP
 * draft appends, which previously hand-rolled a single text/plain part and so
 * dropped attachments and sent HTML bodies as literal markup.
 */
export async function buildMimeMessage(
  from: string,
  params: SendEmailParams,
  options: { includeBcc?: boolean } = {},
): Promise<Buffer> {
  const composer = new MailComposer({
    from,
    to: params.to.map(formatContact).join(', '),
    cc: params.cc?.length ? params.cc.map(formatContact).join(', ') : undefined,
    bcc: options.includeBcc && params.bcc?.length ? params.bcc.map(formatContact).join(', ') : undefined,
    subject: params.subject,
    text: params.body.text,
    html: params.body.html,
    inReplyTo: params.inReplyTo,
    references: params.references?.length ? params.references.join(' ') : undefined,
    attachments: params.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });

  const mail = composer.compile();
  // Gmail's API reads Bcc from the raw message; MailComposer strips it unless asked.
  if (options.includeBcc) mail.keepBcc = true;

  return new Promise((resolve, reject) => {
    mail.build((err: Error | null, message: Buffer) => (err ? reject(err) : resolve(message)));
  });
}
