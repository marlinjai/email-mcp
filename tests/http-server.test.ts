import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, readHttpConfig, MAX_HTTP_BODY_BYTES } from '../src/http-server.js';
import { getTransport } from '../src/config.js';
import { createServer } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { CredentialStore } from '../src/auth/credential-store.js';

const TOKEN = 'test-only-http-auth-token-separate-from-encryption';
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
const listeners: Array<Awaited<ReturnType<typeof startHttpServer>>> = [];
const clients: Client[] = [];

beforeEach(() => {
  vi.stubEnv('EMAIL_MCP_ALLOWED_TOOLS', undefined);
  vi.stubEnv('EMAIL_MCP_ACCOUNT_IDS', undefined);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  vi.unstubAllEnvs();
});

/** Start an authenticated loopback listener on a free port and register it for cleanup. */
async function listen(factory?: typeof createServer) {
  const listener = await startHttpServer(readHttpConfig({ EMAIL_MCP_HTTP_TOKEN: TOKEN, EMAIL_MCP_HTTP_PORT: '0' }), factory);
  listeners.push(listener);
  return listener;
}
/** Connect a test MCP client with the fixture Bearer token and verify stateless transport. */
async function connect(url: string) {
  const client = new Client({ name: 'http-test', version: '1' });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  await client.connect(transport);
  expect(transport.sessionId).toBeUndefined();
  return client;
}
/** Send a JSON-RPC POST using fixture headers, allowing individual tests to override them. */
function post(url: string, body: unknown = initialize, extraHeaders: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
}

const configEnv = { EMAIL_MCP_HTTP_TOKEN: TOKEN };
describe('transport configuration', () => {
  it('keeps stdio as the default and accepts explicit HTTP selection', () => {
    expect(getTransport([], {})).toBe('stdio');
    expect(getTransport(['--transport', 'http'], {})).toBe('http');
    expect(getTransport(['--transport=http'], {})).toBe('http');
    expect(getTransport([], { EMAIL_MCP_TRANSPORT: 'http' })).toBe('http');
    expect(getTransport(['--transport', 'stdio'], { EMAIL_MCP_TRANSPORT: 'http' })).toBe('stdio');
    for (const args of [['--transport'], ['--transport', 'typo'], ['--http']]) expect(() => getTransport(args, {})).toThrow();
  });
  it('defaults to loopback and rejects absent, short or reused auth secrets', () => {
    expect(readHttpConfig(configEnv)).toMatchObject({ host: '127.0.0.1', port: 3000 });
    for (const token of [undefined, '', 'short', ' '.repeat(40)]) {
      expect(() => readHttpConfig({ EMAIL_MCP_HTTP_TOKEN: token })).toThrow('EMAIL_MCP_HTTP_TOKEN');
    }
    expect(() => readHttpConfig({ ...configEnv, EMAIL_MCP_KEY: TOKEN })).toThrow('different');
  });
  it('requires explicit exact allowed hosts when binding externally', () => {
    expect(() => readHttpConfig({ ...configEnv, EMAIL_MCP_HTTP_HOST: '0.0.0.0' })).toThrow('Non-loopback');
    expect(readHttpConfig({ ...configEnv, EMAIL_MCP_HTTP_HOST: '0.0.0.0', EMAIL_MCP_HTTP_ALLOWED_HOSTS: 'mail.example.com,127.0.0.1:3000' }).allowedHosts).toEqual(['mail.example.com', '127.0.0.1:3000']);
    for (const hosts of ['', '*', 'https://mail.example.com', 'mail.example.com/path', 'user@mail.example.com']) {
      expect(() => readHttpConfig({ ...configEnv, EMAIL_MCP_HTTP_ALLOWED_HOSTS: hosts })).toThrow('exact host');
    }
    for (const port of ['-1', '65536', '3.5', '', 'abc']) expect(() => readHttpConfig({ ...configEnv, EMAIL_MCP_HTTP_PORT: port })).toThrow('PORT');
  });
});

describe('authenticated Streamable HTTP', () => {
  it('supports the real SDK client with read-only tools and rejects disabled calls', async () => {
    const { url } = await listen();
    const client = await connect(url);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('email_get');
    expect(names).not.toContain('email_send');
    expect((await client.callTool({ name: 'email_list_accounts', arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'email_send', arguments: {} })).isError).toBe(true);
  });

  it('authenticates every request before creating an MCP server, including GET/DELETE', async () => {
    const factory = vi.fn(createServer);
    const { url } = await listen(factory);
    for (const method of ['POST', 'GET', 'DELETE', 'OPTIONS']) {
      for (const auth of ['', `Bearer ${TOKEN}-wrong`]) {
        const response = await fetch(url, { method, headers: { Authorization: auth } });
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('Bearer');
        expect(await response.text()).not.toContain(TOKEN);
      }
    }
    expect(factory).not.toHaveBeenCalled();
    expect((await post(url)).status).toBe(200);
    // A successful initialize does not authorize a later request without the token.
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
  });

  it('rejects browser Origins, untrusted Hosts, query tokens, and legacy endpoints', async () => {
    const factory = vi.fn(createServer);
    const { url } = await listen(factory);
    for (const origin of ['https://attacker.example', 'null', new URL(url).origin]) {
      expect((await post(url, initialize, { Origin: origin })).status).toBe(403);
    }
    // Node fetch rewrites Host; use the raw HTTP client for the wire-level check.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { ...headers, Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
      req.end(JSON.stringify(initialize));
    });
    expect(hostStatus).toBe(403);
    expect((await post(`${url}?token=${TOKEN}`)).status).toBe(404);
    expect((await post(url.replace('/mcp', '/sse'))).status).toBe(404);
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not offer SSE streams or server-managed sessions', async () => {
    const { url } = await listen();
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(url, { method, headers });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    const response = await post(url);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('enforces the existing account boundary over HTTP', async () => {
    const store = new CredentialStore();
    await store.save({ id: 'allowed-http', name: 'Allowed', provider: 'gmail', email: 'allowed@example.com' });
    await store.save({ id: 'blocked-http', name: 'Blocked', provider: 'gmail', email: 'blocked@example.com' });
    vi.stubEnv('EMAIL_MCP_ACCOUNT_IDS', 'allowed-http');
    const { url } = await listen(() => createServer(new AccountManager(store)));
    const client = await connect(url);
    const listed = await client.callTool({ name: 'email_list_accounts', arguments: {} });
    expect(JSON.stringify(listed)).toContain('allowed-http');
    expect(JSON.stringify(listed)).not.toContain('blocked-http');
    const denied = await client.callTool({ name: 'email_test_account', arguments: { accountId: 'blocked-http' } });
    expect(JSON.stringify(denied)).toContain('Account access denied');
  });

  it('bounds JSON bodies and rejects invalid input before account access', async () => {
    const factory = vi.fn(createServer);
    const { url } = await listen(factory);
    const invalid = await fetch(url, { method: 'POST', headers, body: '{invalid' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe(-32700);
    expect((await post(url, initialize, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(url, initialize, { 'Content-Encoding': 'gzip' })).status).toBe(415);
    expect((await post(url, 'x'.repeat(MAX_HTTP_BODY_BYTES))).status).toBe(413);
    // No Content-Length: the streaming byte counter must enforce the same cap.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
      req.write('x'.repeat(MAX_HTTP_BODY_BYTES));
      req.end('x');
    });
    expect(status).toBe(413);
    expect(factory).not.toHaveBeenCalled();
    expect((await post(url)).status).toBe(200);
  });

  it('uses separate transports/connections for concurrent requests with identical JSON-RPC IDs', async () => {
    const releases = new Map<string, () => void>();
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const disconnects: Array<ReturnType<typeof vi.fn>> = [];
    /** Create an isolated fake account manager whose requests can be released independently. */
    const factory = async () => {
      const disconnectAll = vi.fn().mockResolvedValue(undefined);
      disconnects.push(disconnectAll);
      const manager = {
        disconnectAll,
        testAccount: async (accountId: string) => {
          await new Promise<void>((resolve) => {
            releases.set(accountId, resolve);
            if (releases.size === 2) bothStarted();
          });
          return { success: true, folderCount: accountId === 'first' ? 1 : 2 };
        },
      } as unknown as AccountManager;
      return createServer(manager);
    };
    const { url } = await listen(factory);
    /** Issue account tests with the same JSON-RPC ID to exercise request isolation. */
    const request = (accountId: string) => post(url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'email_test_account', arguments: { accountId } } });
    const first = request('first');
    const second = request('second');
    let secondResult;
    let firstResult;
    try {
      await started;
      releases.get('second')!();
      secondResult = await (await second).json();
      releases.get('first')!();
      firstResult = await (await first).json();
    } finally {
      for (const release of releases.values()) release();
    }
    expect(JSON.parse(secondResult.result.content[0].text).folderCount).toBe(2);
    expect(JSON.parse(firstResult.result.content[0].text).folderCount).toBe(1);
    await listeners[0].close();
    expect(disconnects).toHaveLength(2);
    for (const disconnect of disconnects) expect(disconnect).toHaveBeenCalledOnce();
  });

  it('rejects excess concurrent work before starting another tool and recovers after draining', async () => {
    let release!: () => void;
    let atCapacity!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const capacity = new Promise<void>((resolve) => { atCapacity = resolve; });
    let active = 0;
    /** Create a fake manager that holds work until the concurrency-limit assertion finishes. */
    const factory = async () => createServer({
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      testAccount: async () => {
        if (++active === 16) atCapacity();
        await gate;
        return { success: true, folderCount: 1 };
      },
    } as unknown as AccountManager);
    const { url } = await listen(factory);
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'email_test_account', arguments: { accountId: 'test' } } };
    const requests = Array.from({ length: 16 }, () => post(url, body));
    try {
      await capacity;
      expect((await post(url, body)).status).toBe(503);
      expect(active).toBe(16);
    } finally { release(); }
    expect((await Promise.all(requests)).every((response) => response.status === 200)).toBe(true);
    expect((await post(url)).status).toBe(200);
  });

  it('consumes aborted upload errors and remains available', async () => {
    const { url } = await listen();
    await new Promise<void>((resolve) => {
      const req = http.request(url, { method: 'POST', headers });
      req.on('error', () => {});
      req.once('close', resolve);
      req.write('{', () => req.destroy());
    });
    expect((await post(url)).status).toBe(200);
  });

  it('returns sanitized server errors and shuts down without leaking the listener', async () => {
    const { url, close, server } = await listen(async () => { throw new Error(`private-provider-error-${TOKEN}`); });
    const response = await post(url);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(TOKEN);
    await close();
    await close();
    expect(server.listening).toBe(false);
  });
});
