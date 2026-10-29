import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TokenCacheContext } from '@azure/msal-node';
import {
  createEncryptedFileCachePlugin,
  MsalCacheDecryptError,
  OutlookAuth,
} from '../../src/providers/outlook/auth.js';
import { decryptWithMachineKey, encryptWithMachineKey } from '../../src/auth/credential-store.js';

const CLIENT_ID = 'test-client-id';
const SECRET_REFRESH_TOKEN = 'refresh-token-secret-value';

/** An unsigned JWT: MSAL reads claims such as preferred_username from the cached ID token. */
function fakeIdToken(claims: Record<string, string>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
}

/** A minimal, valid MSAL token cache holding one consumer account and its refresh token. */
function msalCacheJson(homeAccountId = 'uid-1.9188040d-6c67-4c5b-b112-36a304b66dad', username = 'Someone@Outlook.com') {
  const env = 'login.windows.net';
  const realm = '9188040d-6c67-4c5b-b112-36a304b66dad';
  return JSON.stringify({
    Account: {
      [`${homeAccountId}-${env}-${realm}`]: {
        home_account_id: homeAccountId,
        environment: env,
        realm,
        local_account_id: 'uid-1',
        username,
        authority_type: 'MSSTS',
        name: 'Someone',
      },
    },
    IdToken: {
      [`${homeAccountId}-${env}-idtoken-${CLIENT_ID}-${realm}---`]: {
        home_account_id: homeAccountId,
        environment: env,
        credential_type: 'IdToken',
        client_id: CLIENT_ID,
        realm,
        secret: fakeIdToken({ preferred_username: username, oid: 'uid-1', tid: realm, name: 'Someone' }),
      },
    },
    AccessToken: {},
    RefreshToken: {
      [`${homeAccountId}-${env}-refreshtoken-${CLIENT_ID}--`]: {
        home_account_id: homeAccountId,
        environment: env,
        credential_type: 'RefreshToken',
        client_id: CLIENT_ID,
        secret: SECRET_REFRESH_TOKEN,
      },
    },
    AppMetadata: {},
  });
}

/** A stand-in for MSAL's TokenCacheContext, enough for the plugin contract. */
function fakeContext(initial = '', cacheHasChanged = false) {
  let stored = initial;
  const context = {
    cacheHasChanged,
    tokenCache: {
      serialize: () => stored,
      deserialize: (s: string) => {
        stored = s;
      },
    },
  };
  return { context: context as unknown as TokenCacheContext, current: () => stored };
}

describe('encrypted MSAL token cache', () => {
  let dir: string;
  let encPath: string;
  let plainPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-msal-'));
    encPath = path.join(dir, 'msal-cache.enc');
    plainPath = path.join(dir, 'msal-cache.json');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round trips: writes the cache encrypted and reads it back', async () => {
    const plugin = createEncryptedFileCachePlugin(encPath);
    const cache = msalCacheJson();

    const writer = fakeContext(cache, true);
    await plugin.beforeCacheAccess(writer.context);
    await plugin.afterCacheAccess(writer.context);

    const raw = fs.readFileSync(encPath, 'utf-8');
    expect(raw).not.toContain(SECRET_REFRESH_TOKEN);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['authTag', 'data', 'iv', 'salt']);
    expect(decryptWithMachineKey(raw).plaintext).toBe(cache);
    if (process.platform !== 'win32') {
      expect(fs.statSync(encPath).mode & 0o777).toBe(0o600);
    }

    const reader = fakeContext();
    const readerPlugin = createEncryptedFileCachePlugin(encPath);
    await readerPlugin.beforeCacheAccess(reader.context);
    await readerPlugin.afterCacheAccess(reader.context);
    expect(reader.current()).toBe(cache);
  });

  it('does not write when the cache has not changed', async () => {
    const plugin = createEncryptedFileCachePlugin(encPath);
    const ctx = fakeContext(msalCacheJson(), false);
    await plugin.beforeCacheAccess(ctx.context);
    await plugin.afterCacheAccess(ctx.context);
    expect(fs.existsSync(encPath)).toBe(false);
  });

  it('migrates a plaintext cache from an older version without logging the user out', async () => {
    vi.stubEnv('EMAIL_MCP_MIGRATE_LEGACY', 'true');
    const cache = msalCacheJson();
    fs.writeFileSync(plainPath, cache, { mode: 0o600 });

    const ctx = fakeContext();
    const readerPlugin = createEncryptedFileCachePlugin(encPath);
    await readerPlugin.beforeCacheAccess(ctx.context);
    await readerPlugin.afterCacheAccess(ctx.context);

    expect(ctx.current()).toBe(cache);
    expect(fs.existsSync(plainPath)).toBe(false);
    const raw = fs.readFileSync(encPath, 'utf-8');
    expect(raw).not.toContain(SECRET_REFRESH_TOKEN);
    expect(decryptWithMachineKey(raw).plaintext).toBe(cache);
  });

  it('migrates end to end through real MSAL: the migrated account is still usable', async () => {
    vi.stubEnv('EMAIL_MCP_MIGRATE_LEGACY', 'true');
    fs.writeFileSync(plainPath, msalCacheJson('home-1', 'Someone@Outlook.com'), { mode: 0o600 });
    const auth = new OutlookAuth(CLIENT_ID, encPath);

    const accounts = await (auth as any).pca.getTokenCache().getAllAccounts();
    expect(accounts.map((a: { homeAccountId: string }) => a.homeAccountId)).toEqual(['home-1']);
    expect(fs.existsSync(plainPath)).toBe(false);
    expect(fs.existsSync(encPath)).toBe(true);
  });

  it('removes only a semantically identical plaintext cache during migration', async () => {
    vi.stubEnv('EMAIL_MCP_MIGRATE_LEGACY', 'true');
    const plugin = createEncryptedFileCachePlugin(encPath);
    const current = msalCacheJson('home-new');
    const writer = fakeContext(current, true);
    await plugin.beforeCacheAccess(writer.context);
    await plugin.afterCacheAccess(writer.context);

    fs.writeFileSync(plainPath, JSON.stringify(JSON.parse(current), null, 2));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(plainPath, past, past);

    const reader = fakeContext();
    const readerPlugin = createEncryptedFileCachePlugin(encPath);
    await readerPlugin.beforeCacheAccess(reader.context);
    await readerPlugin.afterCacheAccess(reader.context);
    expect(reader.current()).toBe(current);
    expect(fs.existsSync(plainPath)).toBe(false);
  });

  it('requires explicit consent to import plaintext and does not overwrite it on failure', async () => {
    const original = msalCacheJson();
    fs.writeFileSync(plainPath, original);
    const plugin = createEncryptedFileCachePlugin(encPath);
    const ctx = fakeContext('', true);
    await expect(plugin.beforeCacheAccess(ctx.context)).rejects.toThrow('EMAIL_MCP_MIGRATE_LEGACY');
    await plugin.afterCacheAccess(ctx.context);
    expect(fs.existsSync(encPath)).toBe(false);
    expect(fs.readFileSync(plainPath, 'utf-8')).toBe(original);
  });

  it('never lets newer plaintext override the authenticated cache', async () => {
    const original = msalCacheJson('trusted');
    const plugin = createEncryptedFileCachePlugin(encPath);
    fs.writeFileSync(encPath, encryptWithMachineKey(original));
    fs.writeFileSync(plainPath, msalCacheJson('replacement'));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(plainPath, future, future);
    const ctx = fakeContext();
    await plugin.beforeCacheAccess(ctx.context);
    await plugin.afterCacheAccess(ctx.context);
    expect(ctx.current()).toBe(original);
    expect(fs.existsSync(plainPath)).toBe(true);
  });

  it.each([-60_000, 60_000])('preserves conflicting migration inputs regardless of plaintext age (%i)', async (offset) => {
    vi.stubEnv('EMAIL_MCP_MIGRATE_LEGACY', 'true');
    const encrypted = encryptWithMachineKey(msalCacheJson('trusted'));
    const plaintext = msalCacheJson('legacy-only-account');
    fs.writeFileSync(encPath, encrypted);
    fs.writeFileSync(plainPath, plaintext);
    const timestamp = new Date(Date.now() + offset);
    fs.utimesSync(plainPath, timestamp, timestamp);
    const plugin = createEncryptedFileCachePlugin(encPath);
    const ctx = fakeContext('', true);
    await expect(plugin.beforeCacheAccess(ctx.context)).rejects.toThrow('migration conflict');
    await plugin.afterCacheAccess(ctx.context);
    expect(fs.readFileSync(encPath, 'utf8')).toBe(encrypted);
    expect(fs.readFileSync(plainPath, 'utf8')).toBe(plaintext);
    expect(fs.existsSync(`${encPath}.lock`)).toBe(false);
  });

  it('preserves invalid plaintext instead of encrypting and deleting it', async () => {
    vi.stubEnv('EMAIL_MCP_MIGRATE_LEGACY', 'true');
    fs.writeFileSync(plainPath, 'invalid-json');
    const auth = new OutlookAuth(CLIENT_ID, encPath);
    await expect(auth.removeCachedAccount({ homeAccountId: 'home-1' })).rejects.toThrow();
    expect(fs.readFileSync(plainPath, 'utf8')).toBe('invalid-json');
    expect(fs.existsSync(encPath)).toBe(false);
    expect(fs.existsSync(`${encPath}.lock`)).toBe(false);
  });

  it('releases the transaction lock when serialization fails', async () => {
    const plugin = createEncryptedFileCachePlugin(encPath);
    const ctx = fakeContext('', true);
    await plugin.beforeCacheAccess(ctx.context);
    vi.spyOn(ctx.context.tokenCache, 'serialize').mockImplementation(() => { throw new Error('serialize failed'); });
    await expect(plugin.afterCacheAccess(ctx.context)).rejects.toThrow('serialize failed');
    expect(fs.existsSync(`${encPath}.lock`)).toBe(false);
    const next = fakeContext();
    await plugin.beforeCacheAccess(next.context);
    await plugin.afterCacheAccess(next.context);
  });

  it('a failed transaction finalizer cannot write or release another transaction', async () => {
    const plugin = createEncryptedFileCachePlugin(encPath);
    fs.writeFileSync(encPath, 'corrupted');
    const failed = fakeContext('wrong', true);
    await expect(plugin.beforeCacheAccess(failed.context)).rejects.toThrow();
    fs.unlinkSync(encPath);
    const active = fakeContext(msalCacheJson(), true);
    await plugin.beforeCacheAccess(active.context);
    await plugin.afterCacheAccess(failed.context);
    expect(fs.existsSync(`${encPath}.lock`)).toBe(true);
    expect(fs.existsSync(encPath)).toBe(false);
    await plugin.afterCacheAccess(active.context);
    expect(decryptWithMachineKey(fs.readFileSync(encPath, 'utf8')).plaintext).toBe(msalCacheJson());
  });

  it('detects tampering with a clear error and never overwrites the tampered file', async () => {
    const plugin = createEncryptedFileCachePlugin(encPath);
    const writer = fakeContext(msalCacheJson(), true);
    await plugin.beforeCacheAccess(writer.context);
    await plugin.afterCacheAccess(writer.context);

    const envelope = JSON.parse(fs.readFileSync(encPath, 'utf-8'));
    const first = envelope.data[0];
    envelope.data = (first === '0' ? '1' : '0') + envelope.data.slice(1);
    const tampered = JSON.stringify(envelope);
    fs.writeFileSync(encPath, tampered);
    fs.writeFileSync(plainPath, msalCacheJson('untrusted-replacement'));
    vi.stubEnv('EMAIL_MCP_MIGRATE_LEGACY', 'true');

    const reader = createEncryptedFileCachePlugin(encPath);
    // MSAL marks removeAccount contexts as changed and calls afterCacheAccess
    // from a finally block even when beforeCacheAccess threw.
    const ctx = fakeContext('', true);
    await expect(reader.beforeCacheAccess(ctx.context)).rejects.toBeInstanceOf(MsalCacheDecryptError);
    await expect(reader.beforeCacheAccess(ctx.context)).rejects.toThrow(/could not be decrypted.*re-run email-mcp-setup/s);
    await reader.afterCacheAccess(ctx.context);

    expect(fs.readFileSync(encPath, 'utf-8')).toBe(tampered);
    expect(fs.existsSync(plainPath)).toBe(true);
  });

  it('reports a garbage (non-JSON) cache file the same clean way', async () => {
    fs.writeFileSync(encPath, 'not an encrypted envelope');
    const ctx = fakeContext();
    await expect(createEncryptedFileCachePlugin(encPath).beforeCacheAccess(ctx.context)).rejects.toBeInstanceOf(
      MsalCacheDecryptError,
    );
  });

  it('surfaces a tampered cache through OutlookAuth as a rejected promise, not a crash', async () => {
    fs.writeFileSync(encPath, JSON.stringify({ salt: '00', iv: '00', authTag: '00', data: '00' }));
    const auth = new OutlookAuth(CLIENT_ID, encPath);
    await expect(auth.refreshTokenSilent('home-1')).rejects.toBeInstanceOf(MsalCacheDecryptError);
  });

  describe('removeCachedAccount (real MSAL cache)', () => {
    async function seed(json: string) {
      const plugin = createEncryptedFileCachePlugin(encPath);
      const ctx = fakeContext(json, true);
      await plugin.beforeCacheAccess(ctx.context);
      await plugin.afterCacheAccess(ctx.context);
    }

    it('removes the account and its refresh token by home account id, and keeps the file encrypted', async () => {
      await seed(msalCacheJson('home-1'));
      const auth = new OutlookAuth(CLIENT_ID, encPath);

      await expect(auth.removeCachedAccount({ homeAccountId: 'home-1' })).resolves.toBe(true);

      const raw = fs.readFileSync(encPath, 'utf-8');
      const cache = JSON.parse(decryptWithMachineKey(raw).plaintext);
      expect(Object.keys(cache.Account ?? {})).toHaveLength(0);
      expect(Object.keys(cache.RefreshToken ?? {})).toHaveLength(0);
      expect(decryptWithMachineKey(raw).plaintext).not.toContain(SECRET_REFRESH_TOKEN);
    });

    it.each([false, true])('does not resurrect accounts or refresh tokens on concurrent removal (shared instance: %s)', async (shared) => {
      const a = JSON.parse(msalCacheJson('home-a', 'a@example.test'));
      const b = JSON.parse(msalCacheJson('home-b', 'b@example.test'));
      const combined = Object.fromEntries(Object.keys(a).map(key => [key, { ...a[key], ...b[key] }]));
      await seed(JSON.stringify(combined));
      const first = new OutlookAuth(CLIENT_ID, encPath);
      const second = shared ? first : new OutlookAuth(CLIENT_ID, encPath);
      expect(await Promise.all([
        first.removeCachedAccount({ homeAccountId: 'home-a' }),
        second.removeCachedAccount({ homeAccountId: 'home-b' }),
      ])).toEqual([true, true]);
      const cache = JSON.parse(decryptWithMachineKey(fs.readFileSync(encPath, 'utf8')).plaintext);
      expect(cache.Account).toEqual({});
      expect(cache.RefreshToken).toEqual({});
      expect(cache.IdToken).toEqual({});
      expect(fs.existsSync(`${encPath}.lock`)).toBe(false);
    });

    it('falls back to matching the username case-insensitively', async () => {
      await seed(msalCacheJson('home-1', 'Someone@Outlook.com'));
      const auth = new OutlookAuth(CLIENT_ID, encPath);
      await expect(auth.removeCachedAccount({ username: 'someone@outlook.com' })).resolves.toBe(true);
    });

    it('returns false when the cache holds no such account', async () => {
      await seed(msalCacheJson('home-1'));
      const auth = new OutlookAuth(CLIENT_ID, encPath);
      await expect(auth.removeCachedAccount({ homeAccountId: 'other', username: 'x@y.z' })).resolves.toBe(false);
    });
  });
});
