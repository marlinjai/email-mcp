/**
 * email-mcp-digest: scan every configured account for threads still waiting
 * on your reply and email yourself one digest.
 *
 * Read-only against every mailbox except the single digest send. Runs without
 * the MCP server, using the same credential store (run it as the user who set
 * the accounts up, or set EMAIL_MCP_KEY). Settings live in
 * ~/.email-mcp/inbound-digest.json (see README); every field is optional.
 *
 * Usage:
 *   email-mcp-digest [--dry-run] [--render-only] [--days N] [--config path]
 *     --dry-run      scan and print the digest instead of sending it
 *     --render-only  re-send the digest from the last report, no scan
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AccountManager } from '../account-manager.js';
import type { EmailProvider } from '../providers/provider.js';
import type { Email } from '../models/types.js';
import {
  loadConfig, buildContactIndex, findWaitingThreads, DEFAULT_CONFIG_PATH,
  type AccountHealth, type WaitingThread, type ScanCounters, type DigestConfig,
} from '../digest/core.js';
import { renderDigestText, renderDigestHtml, type RenderOptions } from '../digest/render.js';

const argValue = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const log = (msg: string) => process.stdout.write(`${new Date().toISOString()} email-mcp-digest: ${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = (path: string | undefined, fallback: unknown) => {
  if (!path) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
};

// ---------- enumeration ----------

const PAGE = 100;

/** Outlook: server-side since filter with top/skip paging. */
async function enumerateOutlook(provider: EmailProvider, folder: string, since: string): Promise<Email[]> {
  const out: Email[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const batch = await provider.search({ folder, since, limit: PAGE, offset, returnBody: false });
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

/** One Gmail search, paced to the per-minute quota, with one retry on quota or transient errors. */
async function gmailSearchPaced(provider: EmailProvider, query: Parameters<EmailProvider['search']>[0]): Promise<Email[]> {
  try {
    const batch = await provider.search(query);
    await sleep(batch.length * 40);
    return batch;
  } catch (err) {
    if (!/quota|precondition|rate ?limit|backend error|internal error/i.test(String(err))) throw err;
    await sleep(65_000);
    return provider.search(query);
  }
}

/** Gmail search has no offset paging, so page by date window and split any window that hits the cap. */
async function enumerateGmail(provider: EmailProvider, label: string, since: Date, before: Date): Promise<Email[]> {
  const CAP = 200;
  const batch = await gmailSearchPaced(provider, {
    folder: label, since: since.toISOString(), before: before.toISOString(), limit: CAP, returnBody: false,
  });
  if (batch.length < CAP) return batch;
  const span = before.getTime() - since.getTime();
  if (span <= 2 * 86_400_000) {
    log(`WARNING: ${label} ${since.toISOString()}..${before.toISOString()} hit the ${CAP} cap at minimum span, results truncated`);
    return batch;
  }
  const mid = new Date(since.getTime() + span / 2);
  return [...await enumerateGmail(provider, label, since, mid), ...await enumerateGmail(provider, label, mid, before)];
}

async function enumerateAccount(provider: EmailProvider, providerType: string, lookbackDays: number): Promise<Email[]> {
  const now = new Date();
  const since = new Date(now.getTime() - lookbackDays * 86_400_000);
  if (providerType === 'outlook') {
    return [
      ...await enumerateOutlook(provider, 'inbox', since.toISOString()),
      ...await enumerateOutlook(provider, 'sentitems', since.toISOString()),
    ];
  }
  if (providerType === 'gmail') {
    const out: Email[] = [];
    for (const label of ['INBOX', 'SENT']) {
      for (let start = since; start < now;) {
        const end = new Date(Math.min(start.getTime() + 15 * 86_400_000, now.getTime() + 3_600_000));
        out.push(...await enumerateGmail(provider, label, start, end));
        start = end;
      }
    }
    return out;
  }
  // IMAP / iCloud: one pass per folder.
  // ponytail: single capped search, add date-window paging if large IMAP mailboxes truncate.
  return [
    ...await provider.search({ folder: 'INBOX', since: since.toISOString(), limit: 1000, returnBody: false }),
    ...await provider.search({ folder: 'Sent', since: since.toISOString(), limit: 1000, returnBody: false }),
  ];
}

// ---------- main ----------

function nextExpectedRun(now: Date, hhmm?: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  if (!m) return null;
  const next = new Date(now);
  next.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

async function digestSender(mgr: AccountManager, cfg: DigestConfig) {
  const all = await mgr.listAccounts();
  if (!all.length) throw new Error('no accounts configured; run email-mcp-setup first');
  const from = (cfg.digestFrom ?? all[0].email).toLowerCase();
  const hit = all.find((a) => a.email.toLowerCase() === from);
  if (!hit) throw new Error(`digest sender ${from} is not a configured account (have: ${all.map((a) => a.email).join(', ')})`);
  return { provider: await mgr.getProvider(hit.id), from: hit.email };
}

async function send(mgr: AccountManager, cfg: DigestConfig, subject: string, text: string, html: string) {
  const { provider, from } = await digestSender(mgr, cfg);
  const to = cfg.digestTo ?? from;
  const sent = await provider.sendEmail({ to: [{ email: to, name: cfg.digestToName }], subject, body: { text, html } });
  log(`digest sent to ${to}: ${subject} (id ${sent.id})`);
}

async function main(): Promise<void> {
  const cfg = loadConfig(argValue('--config') ?? DEFAULT_CONFIG_PATH);
  const lookbackDays = Number.parseInt(argValue('--days') ?? String(cfg.lookbackDays), 10);
  if (!Number.isFinite(lookbackDays) || lookbackDays < 1) throw new Error('--days must be a positive number');
  const dryRun = process.argv.includes('--dry-run');
  const now = new Date();
  const render = (days: number): RenderOptions => ({
    now, lookbackDays: days, handledTag: cfg.handledTag, reportPath: cfg.reportPath,
    accentColor: cfg.accentColor, boardUrl: cfg.boardUrl, dismissUrl: cfg.dismissUrl,
  });
  const mgr = new AccountManager();

  if (process.argv.includes('--render-only')) {
    const doc = JSON.parse(readFileSync(cfg.reportPath, 'utf-8'));
    const o = render(doc.lookback_days ?? lookbackDays);
    const t = renderDigestText(doc.waiting ?? [], doc.health ?? [], o);
    await send(mgr, cfg, `${t.subject} - preview`, t.text, renderDigestHtml(doc.waiting ?? [], doc.health ?? [], o));
    await mgr.disconnectAll();
    return;
  }

  const accounts = await mgr.listAccounts();
  const ownAddresses = new Set([...accounts.map((a) => a.email), ...cfg.ownAddresses].map((a) => a.trim().toLowerCase()));
  const contacts = buildContactIndex(readJson(cfg.contactsPath, null));
  const dismissals = readJson(cfg.dismissalsPath, {}) as Record<string, { last_seen_date?: string }>;
  const blockedSenders = new Set(Object.keys(readJson(cfg.blockedSendersPath, {}) as object).map((s) => s.toLowerCase()));
  log(`start dry-run=${dryRun} lookback=${lookbackDays}d accounts=${accounts.length} contacts=${contacts.size} `
    + `dismissals=${Object.keys(dismissals).length} blocked=${blockedSenders.size}`);

  const health: AccountHealth[] = [];
  const allWaiting: WaitingThread[] = [];
  for (const acct of accounts) {
    const h: AccountHealth = { name: acct.name, email: acct.email, ok: false, scanned: 0, waiting: 0, droppedAutomated: 0, droppedHandled: 0 };
    health.push(h);
    // One retry after a cool-down: transient Gmail API errors usually clear on the next attempt.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const provider = await mgr.getProvider(acct.id);
        const messages = await enumerateAccount(provider, acct.provider, lookbackDays);
        const counters: ScanCounters = { droppedAutomated: 0, droppedHandled: 0 };
        const waiting = findWaitingThreads(acct.name, messages, {
          ownAddresses, handledTag: cfg.handledTag, contacts, now, dismissals, blockedSenders,
          extraAutomatedDomains: cfg.extraAutomatedDomains,
        }, counters);
        Object.assign(h, { ok: true, error: undefined, scanned: messages.length, waiting: waiting.length, ...counters });
        allWaiting.push(...waiting);
        log(`${acct.name}: ${messages.length} msgs, ${waiting.length} waiting, ${counters.droppedAutomated} bulk, ${counters.droppedHandled} handled`);
        break;
      } catch (err) {
        h.error = err instanceof Error ? err.message : String(err);
        if (attempt === 1 && !/invalid_grant/i.test(h.error)) {
          log(`${acct.name}: attempt 1 failed (${h.error}), retrying in 70s`);
          await sleep(70_000);
        } else {
          log(`${acct.name}: RED - ${h.error}`);
          break;
        }
      }
    }
  }
  allWaiting.sort((a, b) => b.ageDays - a.ageDays);

  try {
    mkdirSync(dirname(cfg.reportPath), { recursive: true, mode: 0o700 });
    writeFileSync(cfg.reportPath, JSON.stringify({
      generated_at: now.toISOString(),
      next_expected_at: nextExpectedRun(now, cfg.scheduleTime),
      lookback_days: lookbackDays,
      contacts: contacts.size,
      health,
      waiting: allWaiting,
    }, null, 2), { mode: 0o600 });
    log(`report written: ${cfg.reportPath}`);
  } catch (err) {
    log(`WARNING: report write failed (${String(err)}), digest continues`);
  }

  const o = render(lookbackDays);
  const t = renderDigestText(allWaiting, health, o);
  if (dryRun) {
    process.stdout.write(`\n----- DIGEST PREVIEW (not sent) -----\nSubject: ${t.subject}\n\n${t.text}\n----- END PREVIEW -----\n`);
  } else {
    await send(mgr, cfg, t.subject, t.text, renderDigestHtml(allWaiting, health, o));
  }
  await mgr.disconnectAll();
  log(`done: ${allWaiting.length} waiting across ${health.filter((x) => x.ok).length}/${health.length} accounts`);
}

main().catch((err) => {
  process.stderr.write(`email-mcp-digest: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
