import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GmailAuth } from '../../src/providers/gmail/auth.js';

let lastGeneratedScopes: string[] = [];

// Mock google-auth-library
vi.mock('google-auth-library', () => {
  class MockOAuth2Client {
    _clientId: string;
    _clientSecret: string;
    _redirectUri?: string;
    credentials: Record<string, any> = {};

    constructor(clientId: string, clientSecret: string, redirectUri?: string) {
      this._clientId = clientId;
      this._clientSecret = clientSecret;
      this._redirectUri = redirectUri;
    }

    generateAuthUrl(opts: { scope: string[] }) {
      lastGeneratedScopes = opts.scope;
      return 'https://accounts.google.com/o/oauth2/v2/auth?mock=true';
    }

    async getToken() {
      return {
        tokens: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
          expiry_date: Date.now() + 3600_000,
        },
      };
    }

    setCredentials(creds: any) {
      this.credentials = creds;
    }

    async getAccessToken() {
      return { token: 'mock-refreshed-token' };
    }
  }

  return { OAuth2Client: MockOAuth2Client };
});

describe('GmailAuth', () => {
  let auth: GmailAuth;

  beforeEach(() => {
    vi.clearAllMocks();
    lastGeneratedScopes = [];
    delete process.env.EMAIL_MCP_GMAIL_SCOPE;
    auth = new GmailAuth('test-client-id', 'test-client-secret');
  });

  afterEach(() => {
    delete process.env.EMAIL_MCP_GMAIL_SCOPE;
  });

  describe('getAuthUrl', () => {
    it('returns a Google OAuth URL', () => {
      const { url, codeVerifier } = auth.getAuthUrl('http://localhost:3000/callback');
      expect(url).toContain('https://accounts.google.com');
      expect(typeof codeVerifier).toBe('string');
      expect(codeVerifier.length).toBeGreaterThan(0);
    });

    it('defaults to the full scope set, including mail.google.com', () => {
      auth.getAuthUrl('http://localhost:3000/callback');
      expect(lastGeneratedScopes).toContain('https://mail.google.com/');
      expect(lastGeneratedScopes).toContain('https://www.googleapis.com/auth/gmail.modify');
      expect(lastGeneratedScopes).toContain('https://www.googleapis.com/auth/gmail.settings.basic');
    });

    it('drops mail.google.com when scopeMode is "restricted"', () => {
      auth.getAuthUrl('http://localhost:3000/callback', 'restricted');
      expect(lastGeneratedScopes).not.toContain('https://mail.google.com/');
      expect(lastGeneratedScopes).toContain('https://www.googleapis.com/auth/gmail.modify');
      expect(lastGeneratedScopes).toContain('https://www.googleapis.com/auth/gmail.settings.basic');
    });

    it('honors EMAIL_MCP_GMAIL_SCOPE=restricted when no explicit mode is passed', () => {
      process.env.EMAIL_MCP_GMAIL_SCOPE = 'restricted';
      auth.getAuthUrl('http://localhost:3000/callback');
      expect(lastGeneratedScopes).not.toContain('https://mail.google.com/');
    });

    it('an explicit scopeMode argument overrides EMAIL_MCP_GMAIL_SCOPE', () => {
      process.env.EMAIL_MCP_GMAIL_SCOPE = 'restricted';
      auth.getAuthUrl('http://localhost:3000/callback', 'full');
      expect(lastGeneratedScopes).toContain('https://mail.google.com/');
    });
  });

  describe('exchangeCode', () => {
    it('exchanges auth code for tokens', async () => {
      const tokens = await auth.exchangeCode('mock-auth-code', 'mock-code-verifier');
      expect(tokens).toHaveProperty('access_token');
      expect(tokens).toHaveProperty('refresh_token');
      expect(tokens).toHaveProperty('expiry');
      expect(tokens.access_token).toBe('mock-access-token');
      expect(tokens.refresh_token).toBe('mock-refresh-token');
    });
  });

  describe('refreshToken', () => {
    it('refreshes an access token', async () => {
      const tokens = await auth.refreshAccessToken('mock-refresh-token');
      expect(tokens).toHaveProperty('access_token');
      expect(tokens.access_token).toBe('mock-refreshed-token');
    });
  });
});

describe('OAuthCallbackServer', () => {
  // Dynamically import to avoid hoisting issues
  let OAuthCallbackServer: typeof import('../../src/auth/oauth-server.js').OAuthCallbackServer;

  beforeEach(async () => {
    const mod = await import('../../src/auth/oauth-server.js');
    OAuthCallbackServer = mod.OAuthCallbackServer;
  });

  it('starts on a random port', async () => {
    const server = new OAuthCallbackServer();
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    server.shutdown();
  });

  it('receives callback and extracts auth code', async () => {
    const server = new OAuthCallbackServer();
    const port = await server.start();

    // Simulate the OAuth callback in parallel
    const codePromise = server.waitForCode();

    const response = await fetch(`http://localhost:${port}/callback?code=test-auth-code`);
    expect(response.ok).toBe(true);

    const code = await codePromise;
    expect(code).toBe('test-auth-code');

    server.shutdown();
  });

  it('returns error page when no code in callback', async () => {
    const server = new OAuthCallbackServer();
    const port = await server.start();

    const response = await fetch(`http://localhost:${port}/callback?error=access_denied`);
    const text = await response.text();
    expect(text).toContain('error');

    server.shutdown();
  });

  it('auto-shuts down after timeout', async () => {
    const server = new OAuthCallbackServer(500); // 500ms timeout
    await server.start();

    const codePromise = server.waitForCode();
    await expect(codePromise).rejects.toThrow(/timeout/i);
  });
});
