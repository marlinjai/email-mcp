import { CredentialStore } from './auth/credential-store.js';
import { GmailAdapter } from './providers/gmail/adapter.js';
import { GmailAuth, revokeGoogleGrant } from './providers/gmail/auth.js';
import { OutlookAdapter } from './providers/outlook/adapter.js';
import { OutlookAuth } from './providers/outlook/auth.js';
import { ICloudAdapter } from './providers/icloud/adapter.js';
import { ImapAdapter } from './providers/imap/adapter.js';
import type { EmailProvider } from './providers/provider.js';
import type { Account, AccountCredentials, ProviderTypeValue } from './models/types.js';
import { ProviderType } from './models/types.js';
import { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, OUTLOOK_CLIENT_ID } from './oauth-config.js';

function createProvider(provider: ProviderTypeValue): EmailProvider {
  switch (provider) {
    case ProviderType.Gmail:
      return new GmailAdapter();
    case ProviderType.Outlook:
      return new OutlookAdapter();
    case ProviderType.ICloud:
      return new ICloudAdapter();
    case ProviderType.IMAP:
      return new ImapAdapter();
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * What happened at the provider when an account was removed:
 * - revoked: the provider confirmed the grant is cancelled (Gmail)
 * - failed: revocation was attempted and did not succeed (see detail)
 * - local_only: the provider offers no revocation API for this grant (Outlook)
 * - not_applicable: password accounts, nothing was granted via OAuth
 */
export type RevocationStatus = 'revoked' | 'failed' | 'local_only' | 'not_applicable';

export interface AccountRemovalResult {
  success: true;
  accountId: string;
  provider: ProviderTypeValue;
  email: string;
  revocation: { status: RevocationStatus; detail: string };
  /** Outlook only: removal of the account's tokens from the local MSAL cache. */
  tokenCache?: { status: 'removed' | 'not_found' | 'failed'; detail: string };
}

const MICROSOFT_CONSENT_URL = 'https://account.live.com/consent/Manage';

export class AccountManager {
  private store: CredentialStore;
  private providers: Map<string, EmailProvider> = new Map();
  private credentials: Map<string, AccountCredentials> = new Map();

  constructor(store?: CredentialStore) {
    this.store = store ?? new CredentialStore();
  }

  async listAccounts(): Promise<Account[]> {
    const creds = await this.store.list();
    return creds.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      email: c.email,
      connected: this.providers.has(c.id),
    }));
  }

  async getProvider(accountId: string): Promise<EmailProvider> {
    const existing = this.providers.get(accountId);
    if (existing) {
      // Check if OAuth token has expired mid-session — reconnect if so
      const creds = this.credentials.get(accountId);
      if (creds?.oauth?.expiry) {
        const expiryDate = new Date(creds.oauth.expiry);
        const now = new Date();
        if (!isNaN(expiryDate.getTime()) && expiryDate <= now) {
          await this.disconnectAccount(accountId);
          await this.connectAccount(accountId);
          const refreshed = this.providers.get(accountId);
          if (!refreshed) throw new Error(`Failed to reconnect account ${accountId} after token expiry`);
          return refreshed;
        }
      }
      return existing;
    }

    // Auto-connect if not connected
    await this.connectAccount(accountId);
    const provider = this.providers.get(accountId);
    if (!provider) throw new Error(`Failed to connect account ${accountId}`);
    return provider;
  }

  async connectAccount(accountId: string): Promise<void> {
    const creds = await this.store.get(accountId);
    if (!creds) throw new Error(`Account ${accountId} not found`);

    // Check if OAuth token needs refresh
    if (creds.oauth) {
      await this.refreshTokenIfNeeded(creds);
    }

    const provider = createProvider(creds.provider);
    await provider.connect(creds);
    this.providers.set(accountId, provider);
    this.credentials.set(accountId, creds);
  }

  async addAccount(creds: AccountCredentials): Promise<void> {
    await this.store.save(creds);
    await this.connectAccount(creds.id);
  }

  /**
   * Removes an account locally, then cleans up at the provider as far as the
   * provider allows. Local removal always happens first and never depends on
   * the network; a failed provider step is reported in the result, not thrown.
   */
  async removeAccount(accountId: string): Promise<AccountRemovalResult> {
    const creds = await this.store.get(accountId);
    if (!creds) throw new Error(`Account ${accountId} not found`);

    await this.disconnectAccount(accountId);
    await this.store.remove(accountId);

    const result: AccountRemovalResult = {
      success: true,
      accountId,
      provider: creds.provider,
      email: creds.email,
      revocation: { status: 'not_applicable', detail: '' },
    };

    if (creds.provider === ProviderType.Gmail) {
      const token = creds.oauth?.refresh_token || creds.oauth?.access_token || '';
      const { ok, detail } = await revokeGoogleGrant(token);
      result.revocation = { status: ok ? 'revoked' : 'failed', detail };
    } else if (creds.provider === ProviderType.Outlook) {
      result.tokenCache = await this.removeFromMsalCache(creds);
      result.revocation = {
        status: 'local_only',
        detail:
          'Microsoft offers no endpoint to revoke a refresh token for a personal Microsoft account, ' +
          'so the grant still exists at Microsoft until it expires. To cancel it now, remove email-mcp at ' +
          `${MICROSOFT_CONSENT_URL}.`,
      };
    } else {
      result.revocation = {
        status: 'not_applicable',
        detail:
          'This account used a password, not an OAuth grant, so there is nothing to revoke. ' +
          'The password itself stays valid at your provider; if it was an app-specific password ' +
          '(for example from Apple), delete it there if you no longer need it.',
      };
    }

    return result;
  }

  private async removeFromMsalCache(
    creds: AccountCredentials,
  ): Promise<NonNullable<AccountRemovalResult['tokenCache']>> {
    try {
      const outlookAuth = new OutlookAuth(OUTLOOK_CLIENT_ID);
      const removed = await outlookAuth.removeCachedAccount({
        homeAccountId: creds.oauth?.msal_home_account_id,
        username: creds.email,
      });
      return removed
        ? { status: 'removed', detail: "The account's refresh and access tokens were removed from the local Outlook token cache." }
        : { status: 'not_found', detail: 'The local Outlook token cache held no tokens for this account.' };
    } catch (err: any) {
      return {
        status: 'failed',
        detail: `The account's tokens could not be removed from the local Outlook token cache: ${err?.message ?? String(err)}`,
      };
    }
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const provider = this.providers.get(accountId);
    if (provider) {
      try {
        await provider.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.providers.delete(accountId);
      this.credentials.delete(accountId);
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.providers.keys());
    await Promise.allSettled(ids.map((id) => this.disconnectAccount(id)));
  }

  async testAccount(accountId: string): Promise<{ success: boolean; folderCount: number; error?: string }> {
    try {
      const provider = await this.getProvider(accountId);
      return await provider.testConnection();
    } catch (error: any) {
      return { success: false, folderCount: 0, error: error.message };
    }
  }

  private async refreshTokenIfNeeded(creds: AccountCredentials): Promise<void> {
    if (!creds.oauth?.expiry) return;

    const expiryDate = new Date(creds.oauth.expiry);
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

    // Skip refresh if token is still valid (and expiry is a valid date)
    if (!isNaN(expiryDate.getTime()) && expiryDate > fiveMinutesFromNow) return;

    if (creds.provider === ProviderType.Gmail) {
      const auth = new GmailAuth(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
      const newTokens = await auth.refreshAccessToken(creds.oauth.refresh_token);
      if (!newTokens.access_token) {
        throw new Error('Gmail token refresh returned empty access token — re-authenticate via setup wizard');
      }
      creds.oauth = newTokens;
      await this.store.save(creds);
    } else if (creds.provider === ProviderType.Outlook) {
      const outlookAuth = new OutlookAuth(OUTLOOK_CLIENT_ID);
      const homeAccountId = creds.oauth.msal_home_account_id;

      if (homeAccountId) {
        // Preferred: use MSAL's persisted cache for silent token refresh
        const result = await outlookAuth.refreshTokenSilent(homeAccountId);
        if (!result.accessToken) {
          throw new Error('Outlook token refresh returned empty access token — re-authenticate via setup wizard');
        }
        creds.oauth = {
          access_token: result.accessToken,
          refresh_token: creds.oauth.refresh_token,
          expiry: result.expiresOn?.toISOString() ?? '',
          msal_home_account_id: result.homeAccountId ?? homeAccountId,
        };
      } else if (creds.oauth.refresh_token) {
        // Fallback: use stored refresh token directly (legacy credentials)
        const result = await outlookAuth.refreshToken(creds.oauth.refresh_token);
        if (!result.accessToken) {
          throw new Error('Outlook token refresh returned empty access token — re-authenticate via setup wizard');
        }
        creds.oauth = {
          access_token: result.accessToken,
          refresh_token: creds.oauth.refresh_token,
          expiry: result.expiresOn?.toISOString() ?? '',
        };
      } else {
        throw new Error('No MSAL account ID or refresh token — re-authenticate via setup wizard');
      }

      await this.store.save(creds);
    }
  }
}
