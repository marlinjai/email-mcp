import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PublicClientApplication,
  CryptoProvider,
  type AuthenticationResult,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';

export interface OutlookAuthResult {
  accessToken: string;
  expiresOn: Date | null;
  idToken?: string;
  account?: unknown;
  /** MSAL home account ID for subsequent silent token acquisition */
  homeAccountId?: string;
}

/** Default directory for MSAL cache file */
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.email-mcp');
const DEFAULT_CACHE_FILE = path.join(DEFAULT_CACHE_DIR, 'msal-cache.json');

/**
 * Creates a file-based ICachePlugin for persisting MSAL's token cache.
 * This ensures refresh tokens survive process restarts.
 */
function createFileCachePlugin(cacheFilePath: string): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      if (fs.existsSync(cacheFilePath)) {
        const data = fs.readFileSync(cacheFilePath, 'utf-8');
        context.tokenCache.deserialize(data);
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (context.cacheHasChanged) {
        const dir = path.dirname(cacheFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        fs.writeFileSync(cacheFilePath, context.tokenCache.serialize(), { mode: 0o600 });
      }
    },
  };
}

export class OutlookAuth {
  static readonly AUTHORITY = 'https://login.microsoftonline.com/consumers';
  // MailboxSettings.ReadWrite is required for the messageRules API (block
  // rules) — confirmed by Microsoft's own docs to be supported for personal
  // Microsoft accounts (not just work/school), not just Mail.ReadWrite/Send.
  static readonly SCOPES = ['Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite', 'offline_access'];

  private pca: InstanceType<typeof PublicClientApplication>;
  private cryptoProvider: InstanceType<typeof CryptoProvider>;

  constructor(clientId: string, cacheFilePath?: string) {
    this.pca = new PublicClientApplication({
      auth: {
        clientId,
        authority: OutlookAuth.AUTHORITY,
      },
      cache: {
        cachePlugin: createFileCachePlugin(cacheFilePath ?? DEFAULT_CACHE_FILE),
      },
    });
    this.cryptoProvider = new CryptoProvider();
  }

  async getAuthUrl(redirectUri: string): Promise<{ url: string; codeVerifier: string; state: string }> {
    const { verifier, challenge } = await this.cryptoProvider.generatePkceCodes();
    // CSRF binding, verified by OAuthCallbackServer.waitForCode(state).
    const state = crypto.randomBytes(16).toString('base64url');

    const url = await this.pca.getAuthCodeUrl({
      scopes: OutlookAuth.SCOPES,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state,
    });

    return { url, codeVerifier: verifier, state };
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<OutlookAuthResult> {
    const result: AuthenticationResult = await this.pca.acquireTokenByCode({
      code,
      codeVerifier,
      scopes: OutlookAuth.SCOPES,
      redirectUri,
    });

    return {
      accessToken: result.accessToken,
      expiresOn: result.expiresOn,
      idToken: result.idToken,
      account: result.account,
      homeAccountId: result.account?.homeAccountId,
    };
  }

  /**
   * Silently refresh the access token using MSAL's persisted cache.
   * This is the preferred refresh method — it uses the cached refresh token
   * automatically via acquireTokenSilent().
   */
  async refreshTokenSilent(homeAccountId: string): Promise<OutlookAuthResult> {
    const account = await this.pca.getTokenCache().getAccountByHomeId(homeAccountId);

    if (!account) {
      throw new Error(
        'No cached MSAL account found — re-authenticate via setup wizard'
      );
    }

    const result = await this.pca.acquireTokenSilent({
      account,
      scopes: OutlookAuth.SCOPES,
    });

    return {
      accessToken: result.accessToken,
      expiresOn: result.expiresOn,
      homeAccountId: result.account?.homeAccountId ?? homeAccountId,
    };
  }

  /**
   * @deprecated Use refreshTokenSilent() instead.
   * Kept for backward compatibility with credentials that have a stored refresh token.
   */
  async refreshToken(refreshToken: string): Promise<OutlookAuthResult> {
    const result = await this.pca.acquireTokenByRefreshToken({
      refreshToken,
      scopes: OutlookAuth.SCOPES,
    });

    if (!result) {
      throw new Error('Failed to refresh Outlook token');
    }

    return {
      accessToken: result.accessToken,
      expiresOn: result.expiresOn,
    };
  }
}
