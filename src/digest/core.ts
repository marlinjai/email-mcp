/**
 * Unanswered-inbound digest: pure logic (config, bulk-mail filter, waiting-
 * thread detection, rendering). The CLI in src/cli/digest.ts does the I/O.
 *
 * A thread is WAITING when its newest message is inbound (not from one of
 * your own addresses), is not bulk or automated mail, and has not been
 * marked handled or dismissed. Detection is deterministic; no model calls.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Email } from '../models/types.js';

// ---------- config ----------

export interface DigestConfig {
  /** Extra addresses that count as "you" (aliases that are not accounts).
   *  Every configured account's own address is always included. */
  ownAddresses: string[];
  /** Account address the digest is sent from. Defaults to the first account. */
  digestFrom?: string;
  /** Where the digest goes. Defaults to digestFrom. */
  digestTo?: string;
  digestToName?: string;
  /** Outlook category / Gmail label that marks a thread handled (case-insensitive). */
  handledTag: string;
  /** Days of mail to scan. */
  lookbackDays: number;
  /** JSON report of every waiting thread, written on each run. */
  reportPath: string;
  /** Optional { "<threadId>": { "last_seen_date": ISO } } written by your own tooling. */
  dismissalsPath?: string;
  /** Optional { "<sender address>": ... } of senders never to surface. */
  blockedSendersPath?: string;
  /** Optional contact book: { contacts: [{ id, name, emails[], domains[] }] }.
   *  Senders that match are listed first under "Contacts waiting". */
  contactsPath?: string;
  /** Extra sender domains to treat as bulk mail. */
  extraAutomatedDomains: string[];
  /** Accent color for the HTML digest. */
  accentColor: string;
  /** Optional link shown at the top of the HTML digest (e.g. your own triage page). */
  boardUrl?: string;
  /** Optional base URL for a per-thread "done" link (?tid=&d=&who= appended). */
  dismissUrl?: string;
  /** Local time the digest is scheduled for, "HH:MM", recorded in the report. */
  scheduleTime?: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.email-mcp', 'inbound-digest.json');

export function defaultConfig(): DigestConfig {
  return {
    ownAddresses: [],
    handledTag: 'handled',
    lookbackDays: 120,
    reportPath: join(homedir(), '.email-mcp', 'inbound-digest', 'report.json'),
    extraAutomatedDomains: [],
    accentColor: '#2F4B7C',
  };
}

/** Load the config file if present; missing file means all defaults. */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH): DigestConfig {
  const base = defaultConfig();
  if (!existsSync(path)) return base;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  return { ...base, ...raw };
}

// ---------- contacts ----------

const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'aol.com', 'yahoo.com', 'outlook.com',
  'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'msn.com', 'proton.me', 'protonmail.com',
]);

export interface ContactIndex {
  byEmail: Map<string, { id: string; name: string }>;
  byDomain: Map<string, { id: string; name: string }>;
  size: number;
}

/** Build a contact index. Accepts { contacts: [{id, name, emails, domains}] }
 *  or { customers: [{customer_id, display_name, emails, domains}] }. Public
 *  mail domains are never matched by domain. */
export function buildContactIndex(doc: unknown): ContactIndex {
  const idx: ContactIndex = { byEmail: new Map(), byDomain: new Map(), size: 0 };
  const d = doc as { contacts?: unknown[]; customers?: unknown[] } | null;
  for (const entry of (d?.contacts ?? d?.customers ?? []) as Array<Record<string, unknown>>) {
    const id = (entry?.id ?? entry?.customer_id) as string | undefined;
    const name = (entry?.name ?? entry?.display_name) as string | undefined;
    if (!id || !name) continue;
    const rec = { id, name };
    for (const e of (entry.emails ?? []) as unknown[]) {
      if (typeof e === 'string' && e.includes('@')) idx.byEmail.set(e.trim().toLowerCase(), rec);
    }
    for (const dom of (entry.domains ?? []) as unknown[]) {
      const v = typeof dom === 'string' ? dom.trim().toLowerCase() : '';
      if (v && !PUBLIC_DOMAINS.has(v)) idx.byDomain.set(v, rec);
    }
    idx.size += 1;
  }
  return idx;
}

export function resolveContact(idx: ContactIndex, addr: string) {
  const a = addr.trim().toLowerCase();
  return idx.byEmail.get(a) ?? idx.byDomain.get(a.split('@').pop() ?? '') ?? null;
}

// ---------- bulk / automated mail ----------

// No-reply variants match anywhere in the local part; role addresses are anchored.
const NOREPLY_ANYWHERE = /no-?_?reply|do-?not-?reply|donotreply/i;
const AUTOMATED_LOCALPART = /^(notifications?|notify|alerts?|mailer-daemon|postmaster|bounce[s]?|auto-?confirm|receipts?|billing|invoice\+|newsletter[s]?|news|marketing|promo(tions)?|offers|hello|digest|updates?|support|help|feedback|success|survey[s]?|webinars?|events?|insider|media|press|training|courses?|academy|community|membership|rewards)($|[@.+_-])/i;

// Gmail's own tab classification.
const GMAIL_BULK_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);

export const AUTOMATED_DOMAINS = [
  'amazonses.com', 'sendgrid.net', 'mailchimp.com', 'mailchimpapp.net', 'mandrillapp.com',
  'sparkpostmail.com', 'substack.com', 'shopifyemail.com', 'shopify.com', 'stripe.com',
  'intuit.com', 'quickbooks.com', 'ups.com', 'fedex.com', 'usps.com', 'paypal.com',
  'google.com', 'accounts.google.com', 'youtube.com', 'microsoft.com', 'microsoftonline.com',
  'github.com', 'facebookmail.com', 'linkedin.com', 'x.com', 'twitter.com', 'ebay.com',
  'amazon.com', 'chase.com', 'wellsfargo.com', 'docusign.net', 'adobe.com', 'zoom.us',
  'calendly.com', 'godaddy.com', 'squarespace.com', 'wix.com', 'nextdoor.com',
];

// Bulk senders pad snippets with invisible spacer characters; people do not.
const INVISIBLE_MARKERS = /[͏​‌‍]{2,}|(?:[͏​‌‍]\s*){3,}/;
const SPONSORED_SNIPPET = /sponsored message|view (this email )?(online|as a web ?page)|email preferences|to unsubscribe/i;

export function isAutomatedMessage(e: Email, extraDomains: string[] = []): boolean {
  const a = (e.from?.email ?? '').trim().toLowerCase();
  const local = a.split('@')[0] ?? '';
  const domain = a.split('@').pop() ?? '';
  if (!domain.includes('.')) return true;
  if (local === 'email' || local === 'root') return true;
  if (NOREPLY_ANYWHERE.test(local) || AUTOMATED_LOCALPART.test(local)) return true;
  if (SPONSORED_SNIPPET.test(e.snippet ?? '') || INVISIBLE_MARKERS.test(e.snippet ?? '')) return true;
  if ([...AUTOMATED_DOMAINS, ...extraDomains].some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  if (e.inferenceClassification === 'other') return true;
  if ((e.labels ?? []).some((l) => GMAIL_BULK_LABELS.has(l))) return true;
  const h = e.headers;
  if (h) {
    if (h['list-unsubscribe'] || h['list-id'] || h['x-campaign'] || h['x-mailchimp-id']) return true;
    const prec = (h['precedence'] ?? '').toLowerCase();
    if (prec === 'bulk' || prec === 'list' || prec === 'junk') return true;
    if ((h['auto-submitted'] ?? '').toLowerCase().startsWith('auto')) return true;
  }
  return false;
}

// ---------- waiting-thread detection ----------

export interface WaitingThread {
  accountName: string;
  threadId: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  contact: string | null;
  contactId: string | null;
  ageDays: number;
  newestInboundDate: string;
  snippet: string;
  messageCount: number;
  link: string | null;
}

export interface AccountHealth {
  name: string;
  email: string;
  ok: boolean;
  error?: string;
  scanned: number;
  waiting: number;
  droppedAutomated: number;
  droppedHandled: number;
}

export interface DetectOptions {
  ownAddresses: Set<string>;
  handledTag: string;
  contacts: ContactIndex;
  now: Date;
  dismissals?: Record<string, { last_seen_date?: string }>;
  blockedSenders?: Set<string>;
  extraAutomatedDomains?: string[];
}

export interface ScanCounters { droppedAutomated: number; droppedHandled: number }

export function findWaitingThreads(accountName: string, messages: Email[], opts: DetectOptions,
                                   counters: ScanCounters): WaitingThread[] {
  const threads = new Map<string, Email[]>();
  for (const m of messages) {
    if (m.flags?.draft) continue;
    const key = m.threadId || `solo:${m.id}`;
    const list = threads.get(key);
    if (!list) threads.set(key, [m]);
    else if (!list.some((x) => x.id === m.id)) list.push(m);   // inbox + sent overlap
  }

  const handled = opts.handledTag.trim().toLowerCase();
  const waiting: WaitingThread[] = [];
  for (const [threadId, msgs] of threads) {
    msgs.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const newest = msgs[msgs.length - 1];
    const sender = (newest.from?.email ?? '').trim().toLowerCase();
    if (!sender || opts.ownAddresses.has(sender)) continue;            // you spoke last
    if (isAutomatedMessage(newest, opts.extraAutomatedDomains)) { counters.droppedAutomated += 1; continue; }
    if (opts.blockedSenders?.has(sender)) { counters.droppedAutomated += 1; continue; }
    const tags = [...(newest.categories ?? []), ...(newest.labels ?? [])];
    if (tags.some((t) => String(t).trim().toLowerCase() === handled)) { counters.droppedHandled += 1; continue; }
    // A dismissal covers the thread as of the message that was newest then; newer mail resurfaces it.
    const dis = opts.dismissals?.[threadId];
    if (dis?.last_seen_date && new Date(newest.date).getTime() <= Date.parse(dis.last_seen_date)) {
      counters.droppedHandled += 1;
      continue;
    }
    const contact = resolveContact(opts.contacts, sender);
    const msgId = newest.headers?.['message-id']?.replace(/^<|>$/g, '');
    waiting.push({
      accountName,
      threadId,
      subject: newest.subject || '(no subject)',
      senderName: newest.from?.name || sender,
      senderEmail: sender,
      contact: contact?.name ?? null,
      contactId: contact?.id ?? null,
      ageDays: Math.max(0, Math.floor((opts.now.getTime() - new Date(newest.date).getTime()) / 86_400_000)),
      newestInboundDate: newest.date,
      snippet: (newest.snippet ?? '').replace(/\s+/g, ' ').slice(0, 160),
      messageCount: msgs.length,
      link: newest.webLink ?? (msgId ? `https://mail.google.com/mail/#search/rfc822msgid:${encodeURIComponent(msgId)}` : null),
    });
  }
  return waiting;
}
