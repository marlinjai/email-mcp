import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialStore } from '../../src/auth/credential-store.js';
import { ProviderType } from '../../src/models/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('CredentialStore', () => {
  let store: CredentialStore;
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-test-'));
    store = new CredentialStore(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('saves and loads an account', async () => {
    const creds = {
      id: 'test-1',
      name: 'Test Gmail',
      provider: ProviderType.Gmail as const,
      email: 'test@gmail.com',
      oauth: {
        access_token: 'at-123',
        refresh_token: 'rt-456',
        expiry: '2026-12-31T00:00:00Z',
      },
    };

    await store.save(creds);
    const loaded = await store.get('test-1');
    expect(loaded).toEqual(creds);
  });

  it('lists all accounts', async () => {
    await store.save({
      id: 'a1',
      name: 'Gmail',
      provider: ProviderType.Gmail as const,
      email: 'a@gmail.com',
      oauth: { access_token: 'x', refresh_token: 'y', expiry: '' },
    });
    await store.save({
      id: 'a2',
      name: 'iCloud',
      provider: ProviderType.ICloud as const,
      email: 'b@icloud.com',
      password: { password: 'p', host: 'imap.mail.me.com', port: 993, tls: true },
    });

    const accounts = await store.list();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('removes an account', async () => {
    await store.save({
      id: 'del-1',
      name: 'ToDelete',
      provider: ProviderType.IMAP as const,
      email: 'x@test.com',
      password: { password: 'p', host: 'imap.test.com', port: 993, tls: true },
    });

    await store.remove('del-1');
    const loaded = await store.get('del-1');
    expect(loaded).toBeNull();
  });

  it('returns null for nonexistent account', async () => {
    const loaded = await store.get('nope');
    expect(loaded).toBeNull();
  });

  it('persists across instances', async () => {
    await store.save({
      id: 'persist-1',
      name: 'Persist',
      provider: ProviderType.Gmail as const,
      email: 'p@gmail.com',
      oauth: { access_token: 'a', refresh_token: 'r', expiry: '' },
    });

    const store2 = new CredentialStore(testDir);
    const loaded = await store2.get('persist-1');
    expect(loaded?.email).toBe('p@gmail.com');
  });

  it('encrypts the file on disk', async () => {
    await store.save({
      id: 'enc-1',
      name: 'Encrypted',
      provider: ProviderType.Gmail as const,
      email: 'enc@gmail.com',
      oauth: { access_token: 'secret-token', refresh_token: 'secret-refresh', expiry: '' },
    });

    const filePath = path.join(testDir, 'credentials.enc');
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('secret-refresh');
  });

  it('updates an existing account', async () => {
    const creds = {
      id: 'upd-1',
      name: 'Original',
      provider: ProviderType.Gmail as const,
      email: 'u@gmail.com',
      oauth: { access_token: 'old', refresh_token: 'r', expiry: '' },
    };
    await store.save(creds);
    await store.save({ ...creds, name: 'Updated', oauth: { access_token: 'new', refresh_token: 'r', expiry: '' } });

    const loaded = await store.get('upd-1');
    expect(loaded?.name).toBe('Updated');
    expect(loaded?.oauth?.access_token).toBe('new');

    const all = await store.list();
    expect(all).toHaveLength(1);
  });

  describe('encryption key stability (issue #4)', () => {
    let savedEnvKey: string | undefined;

    beforeEach(() => {
      savedEnvKey = process.env.EMAIL_MCP_KEY;
      delete process.env.EMAIL_MCP_KEY;
    });

    afterEach(() => {
      if (savedEnvKey === undefined) {
        delete process.env.EMAIL_MCP_KEY;
      } else {
        process.env.EMAIL_MCP_KEY = savedEnvKey;
      }
    });

    const sampleCreds = (id: string) => ({
      id,
      name: 'Sample',
      provider: ProviderType.Gmail as const,
      email: `${id}@gmail.com`,
      oauth: { access_token: 'a', refresh_token: 'r', expiry: '' },
    });

    it('encrypts and decrypts using EMAIL_MCP_KEY when provided', async () => {
      process.env.EMAIL_MCP_KEY = 'a-portable-passphrase';
      const s = new CredentialStore(testDir);
      await s.save(sampleCreds('env-1'));

      const s2 = new CredentialStore(testDir);
      const loaded = await s2.get('env-1');
      expect(loaded?.email).toBe('env-1@gmail.com');
    });

    it('migrates a legacy-seeded file to EMAIL_MCP_KEY on read', async () => {
      // Written without an explicit key (machine/hostname-derived seed).
      const legacyStore = new CredentialStore(testDir);
      await legacyStore.save(sampleCreds('mig-1'));

      // Now an explicit key is configured: the existing file must still be
      // readable and should be transparently re-encrypted with the new key.
      process.env.EMAIL_MCP_KEY = 'new-passphrase';
      const upgraded = new CredentialStore(testDir);
      expect((await upgraded.get('mig-1'))?.email).toBe('mig-1@gmail.com');

      // After migration the on-disk file decrypts with the new key, even from a
      // fresh instance, confirming the rewrite happened.
      const afterMigration = new CredentialStore(testDir);
      expect((await afterMigration.get('mig-1'))?.email).toBe('mig-1@gmail.com');

      // ...and it can no longer be decrypted without the key.
      delete process.env.EMAIL_MCP_KEY;
      const withoutKey = new CredentialStore(testDir);
      await expect(withoutKey.get('mig-1')).rejects.toThrow();
    });

    it('fails to decrypt with the wrong EMAIL_MCP_KEY', async () => {
      process.env.EMAIL_MCP_KEY = 'correct-key';
      const s = new CredentialStore(testDir);
      await s.save(sampleCreds('wrong-1'));

      process.env.EMAIL_MCP_KEY = 'a-different-key';
      const s2 = new CredentialStore(testDir);
      await expect(s2.get('wrong-1')).rejects.toThrow();
    });
  });
});
