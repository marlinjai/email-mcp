import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GmailAdapter } from '../../src/providers/gmail/adapter.js';
import { GmailAuth } from '../../src/providers/gmail/auth.js';
import { ProviderType } from '../../src/models/types.js';

/**
 * Runs the real googleapis, google-auth-library and gaxios stack (no mocks)
 * against a local HTTP server standing in for the Gmail API, so an upgrade of
 * those libraries is proven on the adapter's actual request path: the bearer
 * token from the stored credentials, GET and POST requests, JSON responses.
 */
interface Seen {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

describe('Gmail through the real Google client libraries', () => {
  const seen: Seen[] = [];
  let server: http.Server;
  let rootUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url?.startsWith('/gmail/v1/users/me/labels')) {
          res.end(
            JSON.stringify({
              labels: [
                { id: 'INBOX', name: 'INBOX', type: 'system' },
                { id: 'Label_1', name: 'Work', type: 'user' },
              ],
            }),
          );
        } else if (req.method === 'POST' && req.url === '/token') {
          res.end(JSON.stringify({ access_token: 'fresh-access-token', expires_in: 3599, token_type: 'Bearer' }));
        } else if (req.method === 'POST' && req.url?.startsWith('/gmail/v1/users/me/labels')) {
          const { name } = JSON.parse(body) as { name: string };
          res.end(JSON.stringify({ id: 'Label_2', name, type: 'user' }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connectedAdapter(): Promise<GmailAdapter> {
    const adapter = new GmailAdapter();
    await adapter.connect({
      id: 'gmail-1',
      name: 'Test',
      email: 'me@example.test',
      provider: ProviderType.Gmail,
      oauth: {
        access_token: 'live-access-token',
        refresh_token: 'refresh-token',
        expiry: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    // The adapter built its Gmail client with google.gmail({ version, auth });
    // point that same client at the local server. googleapis rewrites every
    // request URL onto the client's rootUrl option, so nothing reaches Google.
    const gmail = (adapter as unknown as { gmail: { context: { _options: { rootUrl?: string } } } }).gmail;
    gmail.context._options.rootUrl = rootUrl;
    return adapter;
  }

  it('lists labels as folders with the stored access token', async () => {
    const adapter = await connectedAdapter();
    const folders = await adapter.listFolders();

    expect(folders.map((f) => f.name)).toEqual(['INBOX', 'Work']);
    const request = seen.find((s) => s.method === 'GET');
    expect(request?.url).toBe('/gmail/v1/users/me/labels');
    expect(request?.authorization).toBe('Bearer live-access-token');
  });

  it('creates a nested label with a JSON body', async () => {
    const adapter = await connectedAdapter();
    const folder = await adapter.createFolder('Child', 'Parent');

    expect(folder.name).toBe('Parent/Child');
    const request = seen.find((s) => s.method === 'POST');
    expect(JSON.parse(request!.body)).toEqual({ name: 'Parent/Child' });
    expect(request?.authorization).toBe('Bearer live-access-token');
  });

  it('builds the PKCE consent URL with the real OAuth2Client', () => {
    const auth = new GmailAuth('client-id.apps.googleusercontent.com', 'client-secret');
    const { url, codeVerifier, state } = auth.getAuthUrl('http://127.0.0.1:4100/callback');
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.searchParams.get('client_id')).toBe('client-id.apps.googleusercontent.com');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4100/callback');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refreshes an access token through the real OAuth2Client and gaxios', async () => {
    const auth = new GmailAuth('client-id.apps.googleusercontent.com', 'client-secret');
    // The token endpoint is a field of the real client; point it at the local server.
    (auth.getOAuth2Client() as unknown as { endpoints: { oauth2TokenUrl: string } }).endpoints.oauth2TokenUrl =
      `${rootUrl}token`;

    const tokens = await auth.refreshAccessToken('stored-refresh-token');

    expect(tokens.access_token).toBe('fresh-access-token');
    expect(tokens.refresh_token).toBe('stored-refresh-token');
    expect(new Date(tokens.expiry).getTime()).toBeGreaterThan(Date.now());
    const request = seen.find((s) => s.url === '/token');
    const form = new URLSearchParams(request!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('stored-refresh-token');
    expect(form.get('client_id')).toBe('client-id.apps.googleusercontent.com');
  });
});
