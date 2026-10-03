import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { buildMimeMessage, htmlToText, normalizeBody } from '../../src/providers/mime.js';
import type { SendEmailParams } from '../../src/providers/provider.js';

const FROM = 'me@example.com';

function params(overrides: Partial<SendEmailParams> = {}): SendEmailParams {
  return {
    to: [{ email: 'bob@example.com' }],
    subject: 'Hello',
    body: { text: 'Hi Bob' },
    ...overrides,
  };
}

/** Splits a built message into its top-level header block and the rest. */
function headerBlock(raw: Buffer): string {
  const s = raw.toString('utf-8');
  return s.slice(0, s.indexOf('\r\n\r\n'));
}

describe('buildMimeMessage', () => {
  it('keeps both parts when text and html are given, text first, html second', async () => {
    const raw = await buildMimeMessage(
      FROM,
      params({ body: { text: 'Plain version', html: '<p>Rich <b>version</b></p>' } }),
    );
    const parsed = await simpleParser(raw);

    expect(headerBlock(raw)).toMatch(/Content-Type: multipart\/alternative/);
    expect(parsed.text?.trim()).toBe('Plain version');
    expect(parsed.html).toContain('<p>Rich <b>version</b></p>');

    const s = raw.toString('utf-8');
    expect(s.indexOf('Content-Type: text/plain')).toBeGreaterThan(-1);
    expect(s.indexOf('Content-Type: text/plain')).toBeLessThan(s.indexOf('Content-Type: text/html'));
  });

  it('turns html-only input into multipart/alternative with a derived text part', async () => {
    const raw = await buildMimeMessage(
      FROM,
      params({
        body: {
          html: '<h1>Rechnung</h1><p>Hallo <b>Anna</b>,</p><p>siehe <a href="https://example.com/r/59">Rechnung 59</a>.</p>',
        },
      }),
    );
    const parsed = await simpleParser(raw);

    expect(headerBlock(raw)).toMatch(/Content-Type: multipart\/alternative/);
    expect(parsed.html).toContain('<b>Anna</b>');
    expect(parsed.text).toBeTruthy();
    expect(parsed.text).toContain('Hallo Anna');
    expect(parsed.text).toContain('https://example.com/r/59');
    expect(parsed.text).not.toMatch(/<[a-z/][^>]*>/i);
  });

  it('keeps a text-only message as a single text/plain part', async () => {
    const raw = await buildMimeMessage(FROM, params({ body: { text: 'Just text' } }));
    const parsed = await simpleParser(raw);

    expect(headerBlock(raw)).toMatch(/Content-Type: text\/plain; charset=utf-8/i);
    expect(headerBlock(raw)).not.toMatch(/multipart/);
    expect(parsed.text?.trim()).toBe('Just text');
    expect(parsed.html).toBe(false);
  });

  it('round-trips a German subject with umlauts and an emoji, RFC 2047 encoded', async () => {
    const subject = 'Grüße aus Köln: Überweisung für März 🎉';
    const raw = await buildMimeMessage(FROM, params({ subject }));
    const parsed = await simpleParser(raw);

    expect(parsed.subject).toBe(subject);
    const headers = headerBlock(raw);
    expect(headers).toMatch(/Subject: =\?UTF-8\?/i);
    // The header block must be pure ASCII: no raw 8-bit bytes on the wire.
    expect(/^[\x00-\x7f]*$/.test(headers)).toBe(true);
  });

  it('encodes non-ASCII bodies with a 7-bit-safe transfer encoding', async () => {
    const raw = await buildMimeMessage(
      FROM,
      params({ body: { text: 'Schöne Grüße, Jürgen 👋', html: '<p>Schöne Grüße, Jürgen 👋</p>' } }),
    );
    const parsed = await simpleParser(raw);

    expect(raw.toString('utf-8')).toMatch(/Content-Transfer-Encoding: (quoted-printable|base64)/i);
    expect(/^[\x00-\x7f]*$/.test(raw.toString('latin1'))).toBe(true);
    expect(parsed.text?.trim()).toBe('Schöne Grüße, Jürgen 👋');
    expect(parsed.html).toContain('Schöne Grüße, Jürgen 👋');
  });

  it('keeps a display name containing a comma as one recipient', async () => {
    const raw = await buildMimeMessage(
      FROM,
      params({ to: [{ name: 'Müller, Hans', email: 'hans@example.com' }, { email: 'eve@example.com' }] }),
    );
    const parsed = await simpleParser(raw);
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;

    expect(to?.value).toHaveLength(2);
    expect(to?.value[0]).toMatchObject({ name: 'Müller, Hans', address: 'hans@example.com' });
    expect(to?.value[1]).toMatchObject({ address: 'eve@example.com' });
  });

  it('keeps a display name containing double quotes intact', async () => {
    const raw = await buildMimeMessage(
      FROM,
      params({ to: [{ name: 'Anna "Ann" Schmidt', email: 'anna@example.com' }] }),
    );
    const parsed = await simpleParser(raw);
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;

    expect(to?.value).toHaveLength(1);
    expect(to?.value[0]).toMatchObject({ name: 'Anna "Ann" Schmidt', address: 'anna@example.com' });
  });

  it('keeps Cc and Bcc (with names), In-Reply-To and References', async () => {
    const raw = await buildMimeMessage(
      FROM,
      params({
        cc: [{ name: 'Carol', email: 'carol@example.com' }],
        bcc: [{ email: 'secret@example.com' }],
        inReplyTo: '<orig-1@example.com>',
        references: ['<root@example.com>', '<orig-1@example.com>'],
      }),
    );
    const parsed = await simpleParser(raw);
    const cc = Array.isArray(parsed.cc) ? parsed.cc[0] : parsed.cc;
    const bcc = Array.isArray(parsed.bcc) ? parsed.bcc[0] : parsed.bcc;

    expect(cc?.value[0]).toMatchObject({ name: 'Carol', address: 'carol@example.com' });
    expect(bcc?.value[0]).toMatchObject({ address: 'secret@example.com' });
    expect(parsed.inReplyTo).toBe('<orig-1@example.com>');
    expect(parsed.references).toEqual(['<root@example.com>', '<orig-1@example.com>']);
    expect(parsed.from?.value[0].address).toBe(FROM);
    expect(parsed.messageId).toBeTruthy();
    expect(parsed.date).toBeInstanceOf(Date);
  });

  it('includes attachments next to both body parts', async () => {
    const raw = await buildMimeMessage(
      FROM,
      params({
        body: { text: 'See attached', html: '<p>See attached</p>' },
        attachments: [{ filename: 'Rechnung Nr. 59.pdf', content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' }],
      }),
    );
    const parsed = await simpleParser(raw);

    expect(headerBlock(raw)).toMatch(/Content-Type: multipart\/mixed/);
    expect(parsed.text?.trim()).toBe('See attached');
    expect(parsed.html).toContain('<p>See attached</p>');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: 'Rechnung Nr. 59.pdf', contentType: 'application/pdf' });
    expect(parsed.attachments[0].content.toString()).toBe('%PDF-1.4 fake');
  });

  it('produces a valid empty text message when no body is given', async () => {
    const raw = await buildMimeMessage(FROM, params({ body: {} }));
    const parsed = await simpleParser(raw);

    expect(headerBlock(raw)).toMatch(/Content-Type: text\/plain/);
    expect(parsed.html).toBe(false);
    expect(parsed.subject).toBe('Hello');
  });
});

describe('normalizeBody', () => {
  it('passes text-only through without an html part', () => {
    expect(normalizeBody({ text: 'a' })).toEqual({ text: 'a', html: undefined });
  });

  it('keeps both parts exactly as given', () => {
    expect(normalizeBody({ text: 'a', html: '<p>b</p>' })).toEqual({ text: 'a', html: '<p>b</p>' });
  });

  it('derives text from html when text is missing or empty', () => {
    expect(normalizeBody({ html: '<p>Hi</p>' })).toEqual({ text: 'Hi', html: '<p>Hi</p>' });
    expect(normalizeBody({ text: '', html: '<p>Hi</p>' })).toEqual({ text: 'Hi', html: '<p>Hi</p>' });
  });

  it('falls back to an empty text body', () => {
    expect(normalizeBody({})).toEqual({ text: '' });
  });
});

describe('htmlToText', () => {
  it('drops tags, scripts and images but keeps words, line breaks and link targets', () => {
    const text = htmlToText(
      '<style>p{color:red}</style><p>Line one<br>Line two</p><img src="x.png" alt="logo"><a href="https://x.test">Link</a>',
    );
    expect(text).toContain('Line one\nLine two');
    expect(text).toContain('Link [https://x.test]');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('logo');
    expect(text).not.toMatch(/<[a-z/][^>]*>/i);
  });

  it('decodes entities', () => {
    expect(htmlToText('<p>Fish &amp; Chips &euro;5</p>')).toBe('Fish & Chips €5');
  });
});

describe('sendViaSmtp message on the wire (real nodemailer, stream transport)', () => {
  async function sendAndParse(p: SendEmailParams) {
    const nodemailer = (await import('nodemailer')).default;
    const { sendViaSmtp } = await import('../../src/providers/imap/smtp.js');
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    let captured: Buffer | undefined;
    const originalSendMail = transport.sendMail.bind(transport);
    (transport as any).sendMail = async (mail: any) => {
      const info: any = await originalSendMail(mail);
      captured = info.message as Buffer;
      return info;
    };
    await sendViaSmtp(transport as any, FROM, p);
    return simpleParser(captured!);
  }

  it('html-only input goes out as multipart/alternative with a derived text part', async () => {
    const parsed = await sendAndParse(params({ body: { html: '<p>Hello <i>Bob</i></p>' } }));
    expect(parsed.headers.get('content-type')).toMatchObject({ value: 'multipart/alternative' });
    expect(parsed.text?.trim()).toBe('Hello Bob');
    expect(parsed.html).toContain('<p>Hello <i>Bob</i></p>');
  });

  it('a display name with a comma and an umlaut subject survive', async () => {
    const parsed = await sendAndParse(
      params({ to: [{ name: 'Müller, Hans', email: 'hans@example.com' }], subject: 'Grüße 🎉' }),
    );
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    expect(to?.value).toEqual([{ name: 'Müller, Hans', address: 'hans@example.com' }]);
    expect(parsed.subject).toBe('Grüße 🎉');
  });
});
