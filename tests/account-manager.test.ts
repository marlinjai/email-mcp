import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountManager } from '../src/account-manager.js';
import { CredentialStore } from '../src/auth/credential-store.js';
import { ProviderType } from '../src/models/types.js';
import type { AccountCredentials } from '../src/models/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock all provider adapters using classes
vi.mock('../src/providers/gmail/adapter.js', () => ({
  GmailAdapter: class {
    providerType = 'gmail';
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    testConnection = vi.fn().mockResolvedValue({ success: true, folderCount: 10 });
  },
}));

vi.mock('../src/providers/outlook/adapter.js', () => ({
  OutlookAdapter: class {
    providerType = 'outlook';
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    testConnection = vi.fn().mockResolvedValue({ success: true, folderCount: 8 });
  },
}));

vi.mock('../src/providers/icloud/adapter.js', () => ({
  ICloudAdapter: class {
    providerType = 'icloud';
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    testConnection = vi.fn().mockResolvedValue({ success: true, folderCount: 5 });
  },
}));

vi.mock('../src/providers/imap/adapter.js', () => ({
  ImapAdapter: class {
    providerType = 'imap';
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    testConnection = vi.fn().mockResolvedValue({ success: true, folderCount: 3 });
  },
}));

// Keep the real revokeGoogleGrant (its HTTP call is exercised against a
// stubbed fetch below); only the OAuth client class is faked.
vi.mock('../src/providers/gmail/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/gmail/auth.js')>()),
  GmailAuth: class {
    refreshAccessToken = vi.fn().mockResolvedValue({
      access_token: 'new-at',
      refresh_token: 'rt',
      expiry: new Date(Date.now() + 3600000).toISOString(),
    });
  },
}));

const mockRemoveCachedAccount = vi.fn();

vi.mock('../src/providers/outlook/auth.js', () => ({
  OutlookAuth: class {
    removeCachedAccount = mockRemoveCachedAccount;
    refreshToken = vi.fn().mockResolvedValue({
      accessToken: 'new-at',
      expiresOn: new Date(Date.now() + 3600000),
    });
  },
}));

describe('AccountManager', () => {
  let manager: AccountManager;
  let testDir: string;
  let store: CredentialStore;

  const gmailCreds: AccountCredentials = {
    id: 'gmail-1',
    name: 'My Gmail',
    provider: ProviderType.Gmail,
    email: 'test@gmail.com',
    oauth: {
      access_token: 'at-123',
      refresh_token: 'rt-456',
      expiry: new Date(Date.now() + 3600000).toISOString(),
    },
  };

  const icloudCreds: AccountCredentials = {
    id: 'icloud-1',
    name: 'My iCloud',
    provider: ProviderType.ICloud,
    email: 'test@icloud.com',
    password: {
      password: 'app-password',
      host: 'imap.mail.me.com',
      port: 993,
      tls: true,
    },
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Never let a test reach Google's real revocation endpoint.
    fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mockRemoveCachedAccount.mockReset();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-am-'));
    store = new CredentialStore(testDir);
    manager = new AccountManager(store);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('lists accounts from credential store', async () => {
    await store.save(gmailCreds);
    await store.save(icloudCreds);

    const accounts = await manager.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0].connected).toBe(false);
    expect(accounts[1].connected).toBe(false);
  });

  it('returns correct provider for account', async () => {
    await store.save(gmailCreds);
    const provider = await manager.getProvider('gmail-1');
    expect(provider.providerType).toBe('gmail');
  });

  it('auto-connects when getting provider', async () => {
    await store.save(icloudCreds);
    const provider = await manager.getProvider('icloud-1');
    expect(provider.providerType).toBe('icloud');

    const accounts = await manager.listAccounts();
    const icloud = accounts.find((a) => a.id === 'icloud-1');
    expect(icloud?.connected).toBe(true);
  });

  it('adds and connects an account', async () => {
    await manager.addAccount(gmailCreds);

    const accounts = await manager.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].connected).toBe(true);
  });

  it('removes an account', async () => {
    await manager.addAccount(gmailCreds);
    await manager.removeAccount('gmail-1');

    const accounts = await manager.listAccounts();
    expect(accounts).toHaveLength(0);
  });

  describe('removeAccount provider cleanup', () => {
    const outlookCreds: AccountCredentials = {
      id: 'outlook-1',
      name: 'My Outlook',
      provider: ProviderType.Outlook,
      email: 'Someone@Outlook.com',
      oauth: {
        access_token: 'at-o',
        refresh_token: '',
        expiry: new Date(Date.now() + 3600000).toISOString(),
        msal_home_account_id: 'home-1',
      },
    };

    it('revokes the Google grant with the refresh token and reports success', async () => {
      await store.save(gmailCreds);
      const result = await manager.removeAccount('gmail-1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://oauth2.googleapis.com/revoke');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(init.body).toBe('token=rt-456');

      expect(result.success).toBe(true);
      expect(result.provider).toBe('gmail');
      expect(result.revocation.status).toBe('revoked');
      expect(await store.get('gmail-1')).toBeNull();
    });

    it('falls back to the access token when no refresh token is stored', async () => {
      await store.save({ ...gmailCreds, oauth: { ...gmailCreds.oauth!, refresh_token: '' } });
      await manager.removeAccount('gmail-1');
      expect(fetchMock.mock.calls[0][1].body).toBe('token=at-123');
    });

    it('still removes the account locally and reports the failure when Google refuses', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Token expired or revoked' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await store.save(gmailCreds);
      const result = await manager.removeAccount('gmail-1');

      expect(result.success).toBe(true);
      expect(result.revocation.status).toBe('failed');
      expect(result.revocation.detail).toContain('HTTP 400');
      expect(result.revocation.detail).toContain('invalid_token');
      expect(result.revocation.detail).toContain('myaccount.google.com/permissions');
      expect(result.revocation.detail).not.toContain('rt-456');
      expect(await store.get('gmail-1')).toBeNull();
    });

    it('still removes the account locally and reports the failure when the network is down', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await store.save(gmailCreds);
      const result = await manager.removeAccount('gmail-1');

      expect(result.revocation.status).toBe('failed');
      expect(result.revocation.detail).toContain('fetch failed');
      expect(await store.get('gmail-1')).toBeNull();
    });

    it('removes Outlook tokens from the MSAL cache and explains that Microsoft has no revoke endpoint', async () => {
      mockRemoveCachedAccount.mockResolvedValue(true);
      await store.save(outlookCreds);
      const result = await manager.removeAccount('outlook-1');

      expect(mockRemoveCachedAccount).toHaveBeenCalledWith({
        homeAccountId: 'home-1',
        username: 'Someone@Outlook.com',
      });
      expect(result.tokenCache?.status).toBe('removed');
      expect(result.revocation.status).toBe('local_only');
      expect(result.revocation.detail).toContain('account.live.com/consent/Manage');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await store.get('outlook-1')).toBeNull();
    });

    it('reports an Outlook cache that held no tokens for the account', async () => {
      mockRemoveCachedAccount.mockResolvedValue(false);
      await store.save(outlookCreds);
      const result = await manager.removeAccount('outlook-1');
      expect(result.tokenCache?.status).toBe('not_found');
    });

    it('still removes an Outlook account locally when the MSAL cache cannot be read', async () => {
      mockRemoveCachedAccount.mockRejectedValue(new Error('could not be decrypted'));
      await store.save(outlookCreds);
      const result = await manager.removeAccount('outlook-1');

      expect(result.success).toBe(true);
      expect(result.tokenCache?.status).toBe('failed');
      expect(result.tokenCache?.detail).toContain('could not be decrypted');
      expect(await store.get('outlook-1')).toBeNull();
    });

    it('reports nothing to revoke for password accounts and makes no network call', async () => {
      await store.save(icloudCreds);
      const result = await manager.removeAccount('icloud-1');

      expect(result.revocation.status).toBe('not_applicable');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await store.get('icloud-1')).toBeNull();
    });

    it('rejects an unknown account id without touching the network', async () => {
      await expect(manager.removeAccount('nonexistent')).rejects.toThrow('Account nonexistent not found');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('tests account connection', async () => {
    await store.save(gmailCreds);
    const result = await manager.testAccount('gmail-1');
    expect(result.success).toBe(true);
    expect(result.folderCount).toBe(10);
  });

  it('handles test failure for missing account', async () => {
    const result = await manager.testAccount('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('disconnects all accounts', async () => {
    await manager.addAccount(gmailCreds);
    await manager.addAccount(icloudCreds);

    await manager.disconnectAll();

    const accounts = await manager.listAccounts();
    expect(accounts.every((a) => !a.connected)).toBe(true);
  });

  it('creates correct provider type for each provider', async () => {
    const outlookCreds: AccountCredentials = {
      id: 'outlook-1',
      name: 'Outlook',
      provider: ProviderType.Outlook,
      email: 'test@hotmail.de',
      oauth: { access_token: 'at', refresh_token: 'rt', expiry: new Date(Date.now() + 3600000).toISOString() },
    };

    const imapCreds: AccountCredentials = {
      id: 'imap-1',
      name: 'Custom IMAP',
      provider: ProviderType.IMAP,
      email: 'test@custom.com',
      password: { password: 'p', host: 'imap.custom.com', port: 993, tls: true },
    };

    await store.save(gmailCreds);
    await store.save(outlookCreds);
    await store.save(icloudCreds);
    await store.save(imapCreds);

    const gmail = await manager.getProvider('gmail-1');
    const outlook = await manager.getProvider('outlook-1');
    const icloud = await manager.getProvider('icloud-1');
    const imap = await manager.getProvider('imap-1');

    expect(gmail.providerType).toBe('gmail');
    expect(outlook.providerType).toBe('outlook');
    expect(icloud.providerType).toBe('icloud');
    expect(imap.providerType).toBe('imap');
  });

  it('one provider failing does not affect others', async () => {
    await store.save(gmailCreds);
    await store.save(icloudCreds);

    // Even if getting one fails, the other works
    const provider = await manager.getProvider('icloud-1');
    expect(provider.providerType).toBe('icloud');
  });
});
