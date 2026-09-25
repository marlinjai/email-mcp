import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Email } from '../../src/models/types.js';
import {
  buildContactIndex, defaultConfig, findWaitingThreads, isAutomatedMessage, loadConfig, resolveContact,
  type DetectOptions,
} from '../../src/digest/core.js';
import { renderDigestHtml, renderDigestText } from '../../src/digest/render.js';

const NOW = new Date('2026-09-25T12:00:00Z');

function mail(o: Partial<Email> & { from: { email: string; name?: string } }): Email {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    accountId: 'a1',
    folder: 'INBOX',
    to: [{ email: 'me@example.com' }],
    subject: 'Quote request',
    date: '2026-09-20T12:00:00Z',
    body: {},
    attachments: [],
    flags: { read: true, starred: false, flagged: false, draft: false },
    ...o,
  } as Email;
}

const opts = (over: Partial<DetectOptions> = {}): DetectOptions => ({
  ownAddresses: new Set(['me@example.com']),
  handledTag: 'handled',
  contacts: buildContactIndex({ contacts: [{ id: 'c1', name: 'Acme Corp', domains: ['acme.test'] }] }),
  now: NOW,
  ...over,
});

const counters = () => ({ droppedAutomated: 0, droppedHandled: 0 });

describe('findWaitingThreads', () => {
  it('flags a thread whose newest message is inbound', () => {
    const w = findWaitingThreads('Work', [mail({ threadId: 't1', from: { email: 'buyer@acme.test', name: 'Bea' } })], opts(), counters());
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ contact: 'Acme Corp', senderName: 'Bea', ageDays: 5, threadId: 't1' });
  });

  it('clears a thread once you replied last', () => {
    const w = findWaitingThreads('Work', [
      mail({ threadId: 't1', from: { email: 'buyer@acme.test' }, date: '2026-09-20T12:00:00Z' }),
      mail({ threadId: 't1', from: { email: 'ME@example.com' }, date: '2026-09-21T12:00:00Z' }),
    ], opts(), counters());
    expect(w).toHaveLength(0);
  });

  it('ignores drafts and de-duplicates the same message seen in two folders', () => {
    const m = mail({ id: 'x', threadId: 't1', from: { email: 'buyer@acme.test' } });
    const w = findWaitingThreads('Work', [
      m, { ...m },
      mail({ threadId: 't1', from: { email: 'me@example.com' }, date: '2026-09-22T00:00:00Z', flags: { read: true, starred: false, flagged: false, draft: true } }),
    ], opts(), counters());
    expect(w).toHaveLength(1);
    expect(w[0].messageCount).toBe(1);
  });

  it('drops threads tagged handled, blocked senders and dismissed threads, counting each', () => {
    const c = counters();
    const w = findWaitingThreads('Work', [
      mail({ threadId: 'h', from: { email: 'a@acme.test' }, categories: ['Handled'] }),
      mail({ threadId: 'b', from: { email: 'pest@spam.test' } }),
      mail({ threadId: 'd', from: { email: 'c@acme.test' }, date: '2026-09-20T12:00:00Z' }),
    ], opts({ blockedSenders: new Set(['pest@spam.test']), dismissals: { d: { last_seen_date: '2026-09-20T12:00:00Z' } } }), c);
    expect(w).toHaveLength(0);
    expect(c).toEqual({ droppedAutomated: 1, droppedHandled: 2 });
  });

  it('resurfaces a dismissed thread when a newer message arrives', () => {
    const w = findWaitingThreads('Work', [
      mail({ threadId: 'd', from: { email: 'c@acme.test' }, date: '2026-09-23T12:00:00Z' }),
    ], opts({ dismissals: { d: { last_seen_date: '2026-09-20T12:00:00Z' } } }), counters());
    expect(w).toHaveLength(1);
  });
});

describe('isAutomatedMessage', () => {
  const human = { from: { email: 'pat@acme.test' } };
  it('keeps a normal person', () => expect(isAutomatedMessage(mail(human))).toBe(false));
  it.each([
    ['no-reply local part', { from: { email: 'billing-no-reply@acme.test' } }],
    ['role address', { from: { email: 'newsletter@acme.test' } }],
    ['bulk sender domain', { from: { email: 'x@em.linkedin.com' } }],
    ['Outlook Other inbox', { ...human, inferenceClassification: 'other' }],
    ['Gmail promotions tab', { ...human, labels: ['CATEGORY_PROMOTIONS'] }],
    ['List-Unsubscribe header', { ...human, headers: { 'list-unsubscribe': '<mailto:u@acme.test>' } }],
    ['Precedence: bulk', { ...human, headers: { precedence: 'bulk' } }],
    ['sponsored snippet', { ...human, snippet: 'This is a sponsored message' }],
    ['invisible spacer padding', { ...human, snippet: 'Hi͏͏​ there' }],
  ])('drops %s', (_label, o) => expect(isAutomatedMessage(mail(o as any))).toBe(true));
  it('honors extra configured domains', () => {
    expect(isAutomatedMessage(mail({ from: { email: 'x@vendor.test' } }), ['vendor.test'])).toBe(true);
  });
});

describe('contacts', () => {
  it('accepts the customers/customer_id/display_name shape and skips public domains', () => {
    const idx = buildContactIndex({ customers: [{ customer_id: 'k', display_name: 'Kay', emails: ['kay@gmail.com'], domains: ['gmail.com', 'kayco.test'] }] });
    expect(resolveContact(idx, 'KAY@gmail.com')?.name).toBe('Kay');
    expect(resolveContact(idx, 'someone@gmail.com')).toBeNull();
    expect(resolveContact(idx, 'ops@kayco.test')?.id).toBe('k');
  });
  it('tolerates a missing or malformed contact book', () => {
    expect(buildContactIndex(null).size).toBe(0);
    expect(buildContactIndex({ contacts: [{ name: 'no id' }] }).size).toBe(0);
  });
});

describe('loadConfig', () => {
  it('returns defaults when the file is absent and merges a partial file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'digest-cfg-'));
    try {
      expect(loadConfig(join(dir, 'missing.json'))).toEqual(defaultConfig());
      const p = join(dir, 'c.json');
      writeFileSync(p, JSON.stringify({ digestTo: 'me@example.com', lookbackDays: 30 }));
      const c = loadConfig(p);
      expect(c.digestTo).toBe('me@example.com');
      expect(c.lookbackDays).toBe(30);
      expect(c.handledTag).toBe('handled');
      writeFileSync(p, '[]');
      expect(() => loadConfig(p)).toThrow(/JSON object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('render', () => {
  const health = [{ name: 'Work', email: 'me@example.com', ok: true, scanned: 10, waiting: 1, droppedAutomated: 3, droppedHandled: 0 }];
  const w = findWaitingThreads('Work', [mail({ threadId: 't1', from: { email: 'buyer@acme.test', name: '<Bea>' } })], opts(), counters());
  const o = { now: NOW, lookbackDays: 120, handledTag: 'handled', reportPath: '/tmp/r.json', accentColor: '#123456' };

  it('writes subject and contact section in text', () => {
    const t = renderDigestText(w, health, o);
    expect(t.subject).toBe('Inbound Digest 2026-09-25 - 1 waiting');
    expect(t.text).toContain('CONTACTS WAITING (1');
    expect(renderDigestText([], health, o).subject).toContain('all clear');
  });

  it('escapes sender text in HTML and only adds the done link when configured', () => {
    const html = renderDigestHtml(w, health, o);
    expect(html).toContain('&lt;Bea&gt;');
    expect(html).not.toContain('done</a>');
    expect(renderDigestHtml(w, health, { ...o, dismissUrl: 'http://127.0.0.1:9/dismiss' })).toContain('done</a>');
  });
});
