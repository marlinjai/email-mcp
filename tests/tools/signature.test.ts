import { describe, it, expect, vi } from 'vitest';
import {
  hasSignature,
  renderSignature,
  resolveSignature,
  textToHtml,
  withSignature,
} from '../../src/tools/signature.js';
import type { EmailProvider } from '../../src/providers/provider.js';

const SIG = '<div>Marlin<br><a href="https://marlinjai.com" style="color:rgb(168,131,63)">marlinjai.com</a></div>';

function provider(overrides: Partial<EmailProvider> = {}): EmailProvider {
  return { providerType: 'gmail', ...overrides } as unknown as EmailProvider;
}

describe('signature helpers', () => {
  describe('renderSignature', () => {
    it("uses Gmail's own markup and a plain-text rendering", () => {
      const rendered = renderSignature(SIG);
      expect(rendered.html).toBe(
        '<span class="gmail_signature_prefix">-- </span><br>' +
          `<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${SIG}</div>`,
      );
      expect(rendered.text).toBe('-- \nMarlin\nmarlinjai.com [https://marlinjai.com]');
    });
  });

  describe('hasSignature', () => {
    it('finds a gmail_signature block in the HTML', () => {
      expect(hasSignature({ html: `<p>Hi</p>${renderSignature(SIG).html}` })).toBe(true);
    });

    it('finds the "-- " delimiter line in the text', () => {
      expect(hasSignature({ text: 'Hi\n\n-- \nMarlin' })).toBe(true);
      expect(hasSignature({ text: 'Hi\r\n\r\n-- \r\nMarlin' })).toBe(true);
    });

    it('is not fooled by a plain double dash or the word in prose', () => {
      expect(hasSignature({ text: 'Hi\n--\nMarlin', html: '<p>my gmail_signatures</p>' })).toBe(false);
      expect(hasSignature({})).toBe(false);
    });
  });

  describe('withSignature', () => {
    it('appends to both parts of an HTML body', () => {
      const body = withSignature({ text: 'Hi', html: '<p>Hi</p>' }, SIG);
      expect(body.html).toBe(`<p>Hi</p><br><div>${renderSignature(SIG).html}</div>`);
      expect(body.text).toBe(`Hi\n\n${renderSignature(SIG).text}`);
    });

    it('gives a text-only body an HTML part, escaped, so the signature keeps its logo and links', () => {
      const body = withSignature({ text: 'a < b\nnext line' }, SIG);
      expect(body.html).toBe(`<div dir="ltr">a &lt; b<br>next line</div><br><div>${renderSignature(SIG).html}</div>`);
      expect(body.text).toBe(`a < b\nnext line\n\n${renderSignature(SIG).text}`);
    });

    it('derives the text part of an HTML-only body', () => {
      const body = withSignature({ html: '<p>Hello there</p>' }, SIG);
      expect(body.text).toBe(`Hello there\n\n${renderSignature(SIG).text}`);
    });

    it('places the signature above quoted history, like Gmail', () => {
      const html = '<p>Sure.</p><div class="gmail_quote"><div>On Mon, Bob wrote:</div><blockquote>old</blockquote></div>';
      const text = 'Sure.\n\nOn Mon, 27 Oct 2026, Bob <bob@example.com> wrote:\n> old';
      const body = withSignature({ html, text }, SIG);
      expect(body.html).toBe(
        `<p>Sure.</p><br><div>${renderSignature(SIG).html}</div><br><div class="gmail_quote"><div>On Mon, Bob wrote:</div><blockquote>old</blockquote></div>`,
      );
      expect(body.text).toBe(
        `Sure.\n\n${renderSignature(SIG).text}\n\nOn Mon, 27 Oct 2026, Bob <bob@example.com> wrote:\n> old`,
      );
    });

    it('places it above a forwarded message in text', () => {
      const body = withSignature({ text: 'FYI\n---------- Forwarded message ----------\nFrom: a' }, SIG);
      expect(body.text).toBe(`FYI\n\n${renderSignature(SIG).text}\n\n---------- Forwarded message ----------\nFrom: a`);
    });

    it('stands alone in an empty body', () => {
      const body = withSignature({}, SIG);
      expect(body.html).toBe(`<div>${renderSignature(SIG).html}</div>`);
      expect(body.text).toBe(renderSignature(SIG).text);
    });
  });

  describe('textToHtml', () => {
    it('escapes markup and keeps line breaks', () => {
      expect(textToHtml('<b>"x" & y</b>\r\nz')).toBe('<div dir="ltr">&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;<br>z</div>');
    });
  });
});

describe('resolveSignature', () => {
  it('adds the signature and names the send-as address', async () => {
    const getSignature = vi.fn().mockResolvedValue({ sendAs: 'founder@example.com', html: SIG });
    const result = await resolveSignature(provider({ getSignature }), { text: 'Hi' }, undefined);
    expect(result.signature).toEqual({ status: 'added', sendAs: 'founder@example.com' });
    expect(result.body.html).toContain('data-smartmail="gmail_signature"');
  });

  it('does nothing, and reads nothing, when switched off', async () => {
    const getSignature = vi.fn();
    const result = await resolveSignature(provider({ getSignature }), { text: 'Hi' }, false);
    expect(result).toEqual({ body: { text: 'Hi' }, signature: { status: 'disabled' } });
    expect(getSignature).not.toHaveBeenCalled();
  });

  it('leaves a body that already holds a signature alone', async () => {
    const getSignature = vi.fn();
    const body = { html: `<p>Hi</p>${renderSignature(SIG).html}` };
    const result = await resolveSignature(provider({ getSignature }), body, true);
    expect(result).toEqual({ body, signature: { status: 'already_present' } });
    expect(getSignature).not.toHaveBeenCalled();
  });

  it('reports a provider without a signature API instead of faking one', async () => {
    const outlook = await resolveSignature(provider({ providerType: 'outlook' }), { text: 'Hi' }, undefined);
    expect(outlook.signature).toEqual({ status: 'unsupported', reason: expect.stringMatching(/^Outlook: Microsoft Graph has no signature API/) });
    expect(outlook.body).toEqual({ text: 'Hi' });
    const icloud = await resolveSignature(provider({ providerType: 'icloud' }), { text: 'Hi' }, undefined);
    expect(icloud.signature).toEqual({ status: 'unsupported', reason: expect.stringMatching(/^iCloud: /) });
    const imap = await resolveSignature(provider({ providerType: 'imap' }), { text: 'Hi' }, undefined);
    expect(imap.signature).toEqual({ status: 'unsupported', reason: expect.stringMatching(/^IMAP: /) });
  });

  it('says so when the address has no signature', async () => {
    const getSignature = vi.fn().mockResolvedValue({ sendAs: 'billing@example.com', html: null });
    const result = await resolveSignature(provider({ getSignature }), { text: 'Hi' }, undefined);
    expect(result).toEqual({
      body: { text: 'Hi' },
      signature: { status: 'none_configured', sendAs: 'billing@example.com', reason: "billing@example.com has no signature in Gmail's settings." },
    });
  });

  it('never throws when the signature cannot be read, and gives the reason', async () => {
    const getSignature = vi.fn().mockRejectedValue(new Error('Request had insufficient authentication scopes.'));
    const result = await resolveSignature(provider({ getSignature }), { text: 'Hi' }, undefined);
    expect(result).toEqual({
      body: { text: 'Hi' },
      signature: {
        status: 'skipped',
        reason: 'The signature could not be read, so none was added: Request had insufficient authentication scopes.',
      },
    });
  });
});
