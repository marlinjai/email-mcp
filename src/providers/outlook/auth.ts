import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { acquireCacheLock } from '../../auth/cache-lock.js';
import { getDataDir } from '../../config.js';
import {
  PublicClientApplication,
  CryptoProvider,
} from '@azure/msal-node';
import type { AccountInfo, AuthenticationResult, ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { decryptWithMachineKey, encryptWithMachineKey, writePrivateFile } from '../../auth/credential-store.js';

export interface OutlookAuthResult {
  accessToken: string;
  expiresOn: Date | null;
  idToken?: string;
  account?: unknown;
  /** MSAL home account ID for subsequent silent token acquisition */
  homeAccountId?: string;
}

/** Default directory for the MSAL token cache */
const DEFAULT_CACHE_DIR = getDataDir();
/**
 * The MSAL token cache (it holds the Outlook refresh token), encrypted with the
 * same AES-256-GCM scheme and independent secret as credentials.enc.
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
  /** Describe an unreadable cache without including its contents or the encryption secret. */
  constructor(cacheFilePath: string) {
    super(
      `The Outlook token cache ${cacheFilePath} could not be decrypted: it was modified, ` +
        'is corrupt, or was written with a different key (EMAIL_MCP_KEY or another machine). ' +
        'Check EMAIL_MCP_KEY and preserve a private backup; if necessary re-run email-mcp-setup in a fresh EMAIL_MCP_DATA_DIR.',
    );
    this.name = 'MsalCacheDecryptError';
  }
}

/** Encrypt serialized MSAL state and atomically replace the private cache file. */
function writeEncryptedCache(cacheFilePath: string, serialized: string): void {
  const dir = path.dirname(cacheFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writePrivateFile(cacheFilePath, encryptWithMachineKey(serialized));
}

/** Import legacy plaintext only with explicit operator consent and no encrypted cache. */
function loadSerializedCache(cacheFilePath: string, legacyPlaintextPath: string): {
  serialized: string;
  finishMigration?: () => void;
} | null {
  const hasEncrypted = fs.existsSync(cacheFilePath);
  if (!hasEncrypted && fs.existsSync(legacyPlaintextPath)) {
    if (process.env.EMAIL_MCP_MIGRATE_LEGACY !== 'true') {
      throw new Error('Legacy Outlook plaintext cache found. Set EMAIL_MCP_MIGRATE_LEGACY=true for a one-time trusted migration.');
    }
    const serialized = fs.readFileSync(legacyPlaintextPath, 'utf-8');
    JSON.parse(serialized);
    return { serialized, finishMigration: () => {
      writeEncryptedCache(cacheFilePath, serialized);
      fs.unlinkSync(legacyPlaintextPath);
    } };
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
  const removePlaintext = process.env.EMAIL_MCP_MIGRATE_LEGACY === 'true' && fs.existsSync(legacyPlaintextPath);
  if (removePlaintext) {
    const legacy = fs.readFileSync(legacyPlaintextPath, 'utf-8');
    if (!isDeepStrictEqual(JSON.parse(plaintext), JSON.parse(legacy))) {
      throw new Error(
        'Outlook cache migration conflict: encrypted and plaintext caches differ. Both files were preserved. ' +
        'Stop all email-mcp and setup processes and back up both files privately before choosing a cache or reauthenticating. ' +
        'Do not merge caches automatically: this can restore removed accounts.',
      );
    }
  }
  return { serialized: plaintext, finishMigration: () => {
    if (usedLegacyKey) writeEncryptedCache(cacheFilePath, plaintext);
    if (removePlaintext) fs.unlinkSync(legacyPlaintextPath);
  } };
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
  const transactions = new WeakMap<TokenCacheContext, () => void>();

  return {
    /** Acquire the transaction lock, load authenticated state, and complete migration only after deserialization. */
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      const release = await acquireCacheLock(cacheFilePath);
      try {
        const loaded = loadSerializedCache(cacheFilePath, legacyPlaintextPath);
        if (loaded !== null) {
          context.tokenCache.deserialize(loaded.serialized);
          loaded.finishMigration?.();
        }
        transactions.set(context, release);
      } catch (err) {
        release();
        throw err;
      }
    },
    /** Persist changed state only for a successfully loaded transaction, releasing its lock even when writing fails. */
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      const release = transactions.get(context);
      if (!release) return;
      transactions.delete(context);
      try {
        if (context.cacheHasChanged) writeEncryptedCache(cacheFilePath, context.tokenCache.serialize());
      } finally {
        release();
      }
    },
  };
}

export class OutlookAuth {
  static readonly AUTHORITY = 'https://login.microsoftonline.com/consumers';
  /** Return the configured Graph permissions with offline access, rejecting unknown scope modes. */
  static get SCOPES(): string[] {
    switch (process.env.EMAIL_MCP_OUTLOOK_SCOPE ?? 'readonly') {
      case 'readonly': return ['Mail.Read', 'offline_access'];
      case 'read-send': return ['Mail.Read', 'Mail.Send', 'offline_access'];
      case 'read-write': return ['Mail.ReadWrite', 'Mail.Send', 'offline_access'];
      case 'full': return ['Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite', 'offline_access'];
      default: throw new Error('EMAIL_MCP_OUTLOOK_SCOPE must be readonly, read-send, read-write, or full');
    }
  }

  private readonly scopes: string[];
  private pca: InstanceType<typeof PublicClientApplication>;
  private cryptoProvider: InstanceType<typeof CryptoProvider>;

  /** Capture OAuth scopes and configure MSAL with the encrypted cache for the selected data directory. */
  constructor(clientId: string, cacheFilePath?: string) {
    this.scopes = OutlookAuth.SCOPES;
    this.pca = new PublicClientApplication({
      auth: {
        clientId,
        authority: OutlookAuth.AUTHORITY,
      },
      cache: {
        cachePlugin: createEncryptedFileCachePlugin(cacheFilePath ?? path.join(getDataDir(), 'msal-cache.enc')),
      },
    });
    this.cryptoProvider = new CryptoProvider();
  }

  /** Create the authorization URL with PKCE and a random state that the callback must verify. */
  async getAuthUrl(redirectUri: string): Promise<{ url: string; codeVerifier: string; state: string }> {
    const { verifier, challenge } = await this.cryptoProvider.generatePkceCodes();
    // CSRF binding, verified by OAuthCallbackServer.waitForCode(state).
    const state = crypto.randomBytes(16).toString('base64url');

    const url = await this.pca.getAuthCodeUrl({
      scopes: this.scopes,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state,
    });

    return { url, codeVerifier: verifier, state };
  }

  /** Exchange an authorization code with its PKCE verifier and return tokens plus the cached account identity. */
  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<OutlookAuthResult> {
    const result: AuthenticationResult = await this.pca.acquireTokenByCode({
      code,
      codeVerifier,
      scopes: this.scopes,
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
      scopes: this.scopes,
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
      scopes: this.scopes,
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
