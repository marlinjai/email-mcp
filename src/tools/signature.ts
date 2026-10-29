import type { EmailProvider, SendEmailParams } from '../providers/provider.js';
import type { ProviderTypeValue } from '../models/types.js';
import { htmlToText } from '../providers/mime.js';

/**
 * Account signatures on outgoing mail (docs/plans/2026-10-29-gmail-signature.md).
 *
 * The Gmail API never adds a signature; only Gmail's web editor does. So the
 * sending tools read the signature of the send-as address themselves and
 * place it the way that editor would: Gmail's own markup, above any quoted
 * history, once. Outlook.com, iCloud and IMAP keep no signature a client can
 * read, so there the outcome says so and the body is left as it is.
 */

type Body = SendEmailParams['body'];

/** What happened to the signature, returned in the tool result as `signature`. */
export type SignatureOutcome =
  | { status: 'added'; sendAs: string }
  | { status: 'already_present' }
  | { status: 'disabled' }
  | { status: 'none_configured'; sendAs: string; reason: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'skipped'; reason: string };

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A plain-text body as HTML, the way Gmail's editor holds typed text. */
export function textToHtml(text: string): string {
  return `<div dir="ltr">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
}

// The "-- " line (RFC 3676 section 4.3) opens a signature in plain text.
const TEXT_DELIMITER = /^-- \r?$/m;
// Where quoted history starts: Gmail's quote containers in HTML, and in text
// the forward header this server writes or a reply attribution line.
const HTML_QUOTE = /<(?:div|blockquote)\b[^>]*\bclass="[^"]*\bgmail_quote/i;
const TEXT_QUOTE = /^(?:-{10} Forwarded message -{10}|On .+ wrote:)\s*$/m;

/** True when the body already carries a signature, so none is added. */
export function hasSignature(body: Body): boolean {
  return /\bgmail_signature\b/.test(body.html ?? '') || TEXT_DELIMITER.test(body.text ?? '');
}

/** The signature in Gmail's markup, and its plain-text rendering. */
export function renderSignature(signatureHtml: string): { html: string; text: string } {
  return {
    html:
      '<span class="gmail_signature_prefix">-- </span><br>' +
      `<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${signatureHtml}</div>`,
    text: `-- \n${htmlToText(signatureHtml)}`,
  };
}

function insertBefore(content: string, quote: RegExp, block: string, separator: string): string {
  const match = quote.exec(content);
  const at = match ? match.index : content.length;
  const before = content.slice(0, at).replace(/\s+$/, '');
  const after = content.slice(at);
  return [before, block, after].filter(Boolean).join(separator);
}

/**
 * Adds the signature to both parts, above any quoted history. A text-only
 * body gains an HTML part, because Gmail's editor always sends one and the
 * signature (a logo, colored links) only exists as HTML.
 */
export function withSignature(body: Body, signatureHtml: string): Body {
  const signature = renderSignature(signatureHtml);
  const html = body.html ?? (body.text ? textToHtml(body.text) : '');
  const text = body.text ?? (body.html ? htmlToText(body.html) : '');
  return {
    html: insertBefore(html, HTML_QUOTE, `<div>${signature.html}</div>`, '<br>'),
    text: insertBefore(text, TEXT_QUOTE, signature.text, '\n\n'),
  };
}

function unsupportedReason(provider: ProviderTypeValue): string {
  if (provider === 'outlook') {
    return 'Outlook: Microsoft Graph has no signature API for Outlook.com accounts, so no signature was added. Put it in the body if the mail needs one.';
  }
  return `${provider === 'icloud' ? 'iCloud' : 'IMAP'}: the server keeps no signature a client can read, so no signature was added. Put it in the body if the mail needs one.`;
}

/**
 * Decides and applies the signature for one outgoing body. It never throws:
 * when the signature cannot be read, the mail or draft still goes ahead
 * without one and the outcome carries the reason.
 */
export async function resolveSignature(
  provider: EmailProvider,
  body: Body,
  enabled: boolean | undefined,
): Promise<{ body: Body; signature: SignatureOutcome }> {
  if (enabled === false) return { body, signature: { status: 'disabled' } };
  if (hasSignature(body)) return { body, signature: { status: 'already_present' } };
  if (!provider.getSignature) {
    return { body, signature: { status: 'unsupported', reason: unsupportedReason(provider.providerType) } };
  }
  let found: { sendAs: string; html: string | null };
  try {
    found = await provider.getSignature();
  } catch (error: any) {
    const message: string = error?.message || String(error);
    return {
      body,
      signature: { status: 'skipped', reason: `The signature could not be read, so none was added: ${message}` },
    };
  }
  if (!found.html) {
    return {
      body,
      signature: {
        status: 'none_configured',
        sendAs: found.sendAs,
        reason: `${found.sendAs} has no signature in Gmail's settings.`,
      },
    };
  }
  return { body: withSignature(body, found.html), signature: { status: 'added', sendAs: found.sendAs } };
}
