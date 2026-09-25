/**
 * email-mcp-fetch: headless mail fetch for scripts and schedulers.
 *
 * Runs without the MCP server: it loads the same credential store the server
 * uses (so run it as the user who set the accounts up; the store's key is
 * derived per user and host unless EMAIL_MCP_KEY is set), refreshes OAuth
 * silently, and prints JSON on stdout. Errors go to stderr; exit code 0 means
 * stdout holds valid JSON.
 *
 * Usage:
 *   email-mcp-fetch --account <id> --since <iso8601> [--folder inbox] [--limit 25] [--with-attachments]
 *   email-mcp-fetch --account <id> --download <emailId> <attachmentId> <outPath>
 *
 * List mode prints an array of
 *   { id, threadId, from: {name, email}, subject, date, preview, attachments: [{id, filename, contentType, size}] }
 * where attachments are filled only with --with-attachments (one extra fetch per message).
 * Download mode writes the attachment to <outPath> and prints { saved, filename, contentType, size }.
 */
import { writeFileSync } from 'node:fs';
import { AccountManager } from '../account-manager.js';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  process.stderr.write(`email-mcp-fetch: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const account = argValue('--account') ?? fail('--account <id> is required');
  const provider = await new AccountManager().getProvider(account);

  const dlIdx = process.argv.indexOf('--download');
  if (dlIdx >= 0) {
    const [emailId, attachmentId, outPath] = process.argv.slice(dlIdx + 1, dlIdx + 4);
    if (!emailId || !attachmentId || !outPath) fail('--download requires <emailId> <attachmentId> <outPath>');
    const { data, meta } = await provider.getAttachment(emailId, attachmentId);
    writeFileSync(outPath, data, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ saved: outPath, filename: meta.filename, contentType: meta.contentType, size: meta.size }));
    return;
  }

  const since = argValue('--since') ?? fail('--since <iso8601> is required in list mode');
  const limit = Number.parseInt(argValue('--limit') ?? '25', 10);
  if (!Number.isFinite(limit) || limit < 1) fail('--limit must be a positive number');
  const emails = await provider.search({ folder: argValue('--folder') ?? 'inbox', since, limit, returnBody: false });
  const withAttachments = process.argv.includes('--with-attachments');

  const out: Array<Record<string, unknown>> = [];
  for (const e of emails) {
    // Search results do not reliably carry attachment metadata; fetch it on request.
    const attachments = withAttachments ? (await provider.getEmail(e.id)).attachments : e.attachments;
    out.push({
      id: e.id,
      threadId: e.threadId,
      from: e.from,
      subject: e.subject,
      date: e.date,
      preview: e.snippet ?? '',
      attachments: (attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })),
    });
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => fail(err?.stack ?? String(err)));
