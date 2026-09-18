import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PublicClientApplication,
  CryptoProvider,
  type AccountInfo,
  type AuthenticationResult,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';
import { decryptWithMachineKey, encryptWithMachineKey } from '../../auth/credential-store.js';

export interface OutlookAuthResult {
  accessToken: string;
  expiresOn: Date | null;
  idToken?: string;
  account?: unknown;
  /** MSAL home account ID for subsequent silent token acquisition */
  homeAccountId?: string;
}

/** Default directory for the MSAL token cache */
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.email-mcp');
/**
 * The MSAL token cache (it holds the Outlook refresh token), encrypted with the
 * same AES-256-GCM scheme and machine-derived key as credentials.enc.
 */
export const DEFAULT_CACHE_FILE = path.join(DEFAULT_CACHE_DIR, 'msal-cache.enc');
/** Where versions before the encrypted cache kept it, as plain JSON. */
const LEGACY_PLAINTEXT_CACHE_NAME = 'msal-cache.json';

/**
 * Thrown when the encrypted MSAL cache exists but cannot be decrypted: it was
 * modified, is corrupt, or was written under a different key (another
 * EMAIL_MCP_KEY, another machine). Surfaces as a normal tool error, never a
 * crash, and the unreadable file is left untouched for the user to inspect.
 */
export class MsalCacheDecryptError extends Error {
  constructor(cacheFilePath: string) {
    super(
      `The Outlook token cache ${cacheFilePath} could not be decrypted: it was modified, ` +
        'is corrupt, or was written with a different key (EMAIL_MCP_KEY or another machine). ' +
        'Delete that file and re-run email-mcp-setup to sign in to Outlook again.',
    );
    this.name = 'MsalCacheDecryptError';
  }
}

function writeEncryptedCache(cacheFilePath: string, serialized: string): void {
  const dir = path.dirname(cacheFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Write to a sibling temp file and rename, so a crash mid-write can never
  // leave a truncated cache behind (which would read as tampered).
  const tmpPath = `${cacheFilePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, encryptWithMachineKey(serialized), { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, cacheFilePath);
}

/**
 * Returns the serialized MSAL cache, or null when there is none yet.
 *
 * Migrates a plaintext cache written by an older version: its content is
 * written back encrypted and the plaintext file is removed, so the user stays
 * signed in across the upgrade. A plaintext file older than the encrypted one
 * is a stale leftover and is removed without being read.
 */
function loadSerializedCache(cacheFilePath: string, legacyPlaintextPath: string): string | null {
  const hasEncrypted = fs.existsSync(cacheFilePath);

  if (fs.existsSync(legacyPlaintextPath)) {
    const plaintextIsNewer =
      !hasEncrypted ||
      fs.statSync(legacyPlaintextPath).mtimeMs > fs.statSync(cacheFilePath).mtimeMs;
    if (plaintextIsNewer) {
      const serialized = fs.readFileSync(legacyPlaintextPath, 'utf-8');
      writeEncryptedCache(cacheFilePath, serialized);
      fs.unlinkSync(legacyPlaintextPath);
      return serialized;
    }
    fs.unlinkSync(legacyPlaintextPath);
  }

  if (!hasEncrypted) return null;

  const raw = fs.readFileSync(cacheFilePath, 'utf-8');
  let plaintext: string;
  let usedLegacyKey: boolean;
  try {
    ({ plaintext, usedLegacyKey } = decryptWithMachineKey(raw));
  } catch {
    throw new MsalCacheDecryptError(cacheFilePath);
  }
  if (usedLegacyKey) {
    try {
      writeEncryptedCache(cacheFilePath, plaintext);
    } catch {
      // Re-keying is best-effort; the read itself already succeeded.
    }
  }
  return plaintext;
}

/**
 * Creates an ICachePlugin that persists MSAL's token cache (and with it the
 * Outlook refresh token) encrypted at rest, so refresh tokens survive process
 * restarts without sitting on disk in plain text.
 */
export function createEncryptedFileCachePlugin(
  cacheFilePath: string,
  legacyPlaintextPath: string = path.join(path.dirname(cacheFilePath), LEGACY_PLAINTEXT_CACHE_NAME),
): ICachePlugin {
  // MSAL calls afterCacheAccess from a finally block even when
  // beforeCacheAccess threw. If the cache could not be read, the in-memory
  // cache is empty, and writing it would silently replace the user's cache.
  let loadFailed = false;

  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      loadFailed = false;
      try {
        const serialized = loadSerializedCache(cacheFilePath, legacyPlaintextPath);
        if (serialized !== null) {
          context.tokenCache.deserialize(serialized);
        }
      } catch (err) {
        loadFailed = true;
        throw err;
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (loadFailed || !context.cacheHasChanged) return;
      writeEncryptedCache(cacheFilePath, context.tokenCache.serialize());
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
        cachePlugin: createEncryptedFileCachePlugin(cacheFilePath ?? DEFAULT_CACHE_FILE),
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
   * Removes one account (its refresh, access and ID tokens) from the MSAL
   * cache. Matches by home account id, or by username for credentials saved
   * before the home account id was recorded. Returns whether an entry was
   * found and removed.
   */
  async removeCachedAccount(match: { homeAccountId?: string; username?: string }): Promise<boolean> {
    const cache = this.pca.getTokenCache();
    let account: AccountInfo | null = null;
    if (match.homeAccountId) {
      account = await cache.getAccountByHomeId(match.homeAccountId);
    }
    if (!account && match.username) {
      const wanted = match.username.trim().toLowerCase();
      const all = await cache.getAllAccounts();
      account = all.find((a) => (a.username ?? '').trim().toLowerCase() === wanted) ?? null;
    }
    if (!account) return false;
    await cache.removeAccount(account);
    return true;
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
