import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutlookAuth } from '../../src/providers/outlook/auth.js';

// Mock @azure/msal-node
const mockGetAuthCodeUrl = vi.fn();
const mockAcquireTokenByCode = vi.fn();
const mockAcquireTokenByRefreshToken = vi.fn();
const mockGeneratePkceCodes = vi.fn().mockResolvedValue({
  verifier: 'test-verifier-12345',
  challenge: 'test-challenge-67890',
});

vi.mock('@azure/msal-node', () => {
  return {
    PublicClientApplication: class MockPCA {
      constructor(_config: unknown) {}
      getAuthCodeUrl = mockGetAuthCodeUrl;
      acquireTokenByCode = mockAcquireTokenByCode;
      acquireTokenByRefreshToken = mockAcquireTokenByRefreshToken;
    },
    CryptoProvider: class MockCrypto {
      generatePkceCodes = mockGeneratePkceCodes;
    },
  };
});

describe('OutlookAuth', () => {
  let auth: OutlookAuth;

  beforeEach(() => {
    vi.clearAllMocks();
    auth = new OutlookAuth('test-client-id');
  });

  describe('getAuthUrl', () => {
    it('generates Microsoft auth URL with correct parameters', async () => {
      mockGetAuthCodeUrl.mockResolvedValue(
        'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=test-client-id&scope=Mail.ReadWrite+Mail.Send+offline_access&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&code_challenge=test-challenge-67890&code_challenge_method=S256&response_type=code'
      );

      const result = await auth.getAuthUrl('http://localhost:3000/callback');

      expect(result.url).toContain('login.microsoftonline.com');
      expect(result.codeVerifier).toBe('test-verifier-12345');
      expect(result.state).toMatch(/^[A-Za-z0-9_-]{16,}$/);

      expect(mockGetAuthCodeUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: ['Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite', 'offline_access'],
          redirectUri: 'http://localhost:3000/callback',
          codeChallenge: 'test-challenge-67890',
          codeChallengeMethod: 'S256',
          state: result.state,
        })
      );
    });

    it('uses a fresh state for every authorization request', async () => {
      mockGetAuthCodeUrl.mockResolvedValue('https://login.microsoftonline.com/x');
      const a = await auth.getAuthUrl('http://localhost:3000/callback');
      const b = await auth.getAuthUrl('http://localhost:3000/callback');
      expect(a.state).not.toBe(b.state);
    });
  });

  describe('exchangeCode', () => {
    it('exchanges authorization code for tokens', async () => {
      mockAcquireTokenByCode.mockResolvedValue({
        accessToken: 'access-token-123',
        expiresOn: new Date('2026-12-31T00:00:00Z'),
        idToken: 'id-token-456',
        account: { homeAccountId: 'user-1' },
      });

      const result = await auth.exchangeCode(
        'auth-code-789',
        'test-verifier-12345',
        'http://localhost:3000/callback'
      );

      expect(result.accessToken).toBe('access-token-123');
      expect(result.expiresOn).toEqual(new Date('2026-12-31T00:00:00Z'));

      expect(mockAcquireTokenByCode).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'auth-code-789',
          codeVerifier: 'test-verifier-12345',
          scopes: ['Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite', 'offline_access'],
          redirectUri: 'http://localhost:3000/callback',
        })
      );
    });
  });

  describe('refreshToken', () => {
    it('refreshes access token using refresh token', async () => {
      mockAcquireTokenByRefreshToken.mockResolvedValue({
        accessToken: 'new-access-token-456',
        expiresOn: new Date('2027-01-15T00:00:00Z'),
      });

      const result = await auth.refreshToken('refresh-token-abc');

      expect(result.accessToken).toBe('new-access-token-456');
      expect(result.expiresOn).toEqual(new Date('2027-01-15T00:00:00Z'));

      expect(mockAcquireTokenByRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: 'refresh-token-abc',
          scopes: ['Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite', 'offline_access'],
        })
      );
    });

    it('throws when refresh fails', async () => {
      mockAcquireTokenByRefreshToken.mockResolvedValue(null);

      await expect(auth.refreshToken('bad-token')).rejects.toThrow(
        'Failed to refresh Outlook token'
      );
    });
  });

  describe('scopes', () => {
    it('uses the correct Microsoft Graph scopes', () => {
      // MailboxSettings.ReadWrite is required for the messageRules API
      // (block rules) — see docs/plans/2026-08-27-spam-report-and-block-rules.md.
      expect(OutlookAuth.SCOPES).toEqual([
        'Mail.ReadWrite',
        'Mail.Send',
        'MailboxSettings.ReadWrite',
        'offline_access',
      ]);
    });
  });

  describe('authority', () => {
    it('uses consumers authority for personal accounts', () => {
      expect(OutlookAuth.AUTHORITY).toBe(
        'https://login.microsoftonline.com/consumers'
      );
    });
  });
});
