import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from '../src/auth/credential-store.js';
import { OutlookAuth } from '../src/providers/outlook/auth.js';
import { resolveAttachments } from '../src/tools/attachments.js';

describe('private deployment data directory', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-isolation-')); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

  it('separates default credential stores and resolves MSAL paths at construction time', async () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    vi.stubEnv('EMAIL_MCP_DATA_DIR', first);
    const store = new CredentialStore();
    await store.save({ id: 'test-account', name: 'Test', provider: 'gmail', email: 'test@example.com' });
    fs.writeFileSync(path.join(first, 'msal-cache.enc'), 'invalid-test-cache');
    vi.stubEnv('EMAIL_MCP_DATA_DIR', second);
    expect(await new CredentialStore().list()).toEqual([]);
    // Real MSAL cache access, entirely offline: no account means no network call.
    await expect(new OutlookAuth('test-client').removeCachedAccount({ homeAccountId: 'missing' })).resolves.toBe(false);
    vi.stubEnv('EMAIL_MCP_DATA_DIR', first);
    expect((await new CredentialStore().list()).map((a) => a.id)).toEqual(['test-account']);
    await expect(new OutlookAuth('test-client').removeCachedAccount({ homeAccountId: 'missing' })).rejects.toThrow('could not be decrypted');
  });

  it('does not allow sending credential files from a custom data directory', async () => {
    const custom = path.join(root, 'private');
    vi.stubEnv('EMAIL_MCP_DATA_DIR', custom);
    const store = new CredentialStore();
    await store.save({ id: 'test', name: 'Test', provider: 'gmail', email: 'test@example.com' });
    expect(() => resolveAttachments([{ path: path.join(custom, 'credentials.enc') }], { EMAIL_MCP_ATTACHMENTS_DIR: root })).toThrow('data folder');
  });
});
