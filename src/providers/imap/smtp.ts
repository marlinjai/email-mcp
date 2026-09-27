import nodemailer from 'nodemailer';
import type { SendEmailParams } from '../provider.js';
import { normalizeBody, toAddress } from '../mime.js';
import type { PasswordCredentials } from '../../models/types.js';

export function createSmtpTransport(email: string, creds: PasswordCredentials) {
  return nodemailer.createTransport({
    host: creds.smtpHost || creds.host.replace('imap', 'smtp'),
    port: creds.smtpPort || 587,
    secure: creds.smtpPort === 465,
    auth: { user: email, pass: creds.password },
  });
}

export async function sendViaSmtp(
  transport: ReturnType<typeof nodemailer.createTransport>,
  from: string,
  params: SendEmailParams
): Promise<string> {
  // nodemailer only builds multipart/alternative when it gets both parts; it
  // never derives a text part from HTML, so HTML-only input is normalized here.
  const { text, html } = normalizeBody(params.body);
  const result = await transport.sendMail({
    from,
    to: params.to.map(toAddress),
    cc: params.cc?.length ? params.cc.map(toAddress) : undefined,
    bcc: params.bcc?.length ? params.bcc.map(toAddress) : undefined,
    subject: params.subject,
    text,
    html,
    inReplyTo: params.inReplyTo,
    references: params.references?.join(' '),
    attachments: params.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });
  return result.messageId;
}
