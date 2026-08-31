import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';
import type { OAuthTokens } from '../../models/types.js';

export type GmailScopeMode = 'full' | 'restricted';

const GMAIL_SCOPES: Record<GmailScopeMode, string[]> = {
  full: [
    // Gmail's maximum-permission scope. Superset of gmail.modify below;
    // the only capability it adds is immediate, trash-bypassing permanent
    // deletion (messages.delete / batchDelete with permanent: true).
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/gmail.modify',
    // Mailbox content access (above) does NOT cover the Settings API —
    // Google treats them as separate permission domains. Needed for
    // users.settings.filters.* (email_create_block_rule/list/delete).
    'https://www.googleapis.com/auth/gmail.settings.basic',
  ],
  // Drops https://mail.google.com/ so an AI-triggered permanent delete
  // can't happen: gmail.modify already covers every other read/write
  // operation this server performs (read, send, label, archive, trash,
  // drafts, filters). Choosing this mode means deleteEmail(..., permanent:
  // true) and batchDelete(..., permanent: true) will fail with a Gmail API
  // 403 instead of succeeding — everything else behaves identically.
  restricted: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.settings.basic',
  ],
};

function resolveScopeMode(explicit?: GmailScopeMode): GmailScopeMode {
  if (explicit) return explicit;
  return process.env.EMAIL_MCP_GMAIL_SCOPE?.toLowerCase() === 'restricted'
    ? 'restricted'
    : 'full';
}

export class GmailAuth {
  private clientId: string;
  private clientSecret: string;
  private oauth2Client: OAuth2Client;

  constructor(clientId: string, clientSecret: string, redirectUri?: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);
  }

  getAuthUrl(
    redirectUri: string,
    scopeMode?: GmailScopeMode,
  ): { url: string; codeVerifier: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // Recreate client with the callback redirect URI
    this.oauth2Client = new OAuth2Client(this.clientId, this.clientSecret, redirectUri);

    const url = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: GMAIL_SCOPES[resolveScopeMode(scopeMode)],
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return { url, codeVerifier };
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
    const { tokens } = await this.oauth2Client.getToken({ code, codeVerifier });
    return {
      access_token: tokens.access_token || '',
      refresh_token: tokens.refresh_token || '',
      expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : '',
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { token } = await this.oauth2Client.getAccessToken();
    return {
      access_token: token || '',
      refresh_token: refreshToken,
      expiry: this.oauth2Client.credentials.expiry_date
        ? new Date(this.oauth2Client.credentials.expiry_date).toISOString()
        : '',
    };
  }

  getOAuth2Client(): OAuth2Client {
    return this.oauth2Client;
  }

  setCredentials(tokens: OAuthTokens): void {
    this.oauth2Client.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry ? new Date(tokens.expiry).getTime() : undefined,
    });
  }
}
