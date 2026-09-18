import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { OAuthCallbackServer } from '../../src/auth/oauth-server.js';

function get(host: string, port: number, pathAndQuery: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: pathAndQuery }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
}

describe('OAuthCallbackServer', () => {
  let server: OAuthCallbackServer | null = null;

  afterEach(() => {
    server?.shutdown();
    server = null;
  });

  it('listens on loopback addresses only, never on every interface', async () => {
    server = new OAuthCallbackServer();
    await server.start();

    const addresses = server.boundAddresses();
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses).toContain('127.0.0.1');
    for (const address of addresses) {
      expect(['127.0.0.1', '::1']).toContain(address);
    }
    expect(addresses).not.toContain('0.0.0.0');
    expect(addresses).not.toContain('::');
  });

  it('delivers the code through 127.0.0.1', async () => {
    server = new OAuthCallbackServer();
    const port = await server.start();
    const code = server.waitForCode('s1');

    const status = await get('127.0.0.1', port, '/callback?code=abc&state=s1');
    expect(status).toBe(200);
    await expect(code).resolves.toBe('abc');
  });

  it('delivers the code through ::1 when the machine has IPv6 loopback, so localhost works either way', async () => {
    server = new OAuthCallbackServer();
    const port = await server.start();
    if (!server.boundAddresses().includes('::1')) return; // IPv4-only host
    const code = server.waitForCode('s2');

    const status = await get('::1', port, '/?code=xyz&state=s2');
    expect(status).toBe(200);
    await expect(code).resolves.toBe('xyz');
  });

  it('is not reachable on a non-loopback interface address', async () => {
    const os = await import('node:os');
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    server = new OAuthCallbackServer();
    const port = await server.start();
    if (!external) return; // no external interface on this host (sandboxed CI)

    await expect(get(external.address, port, '/callback?code=abc')).rejects.toThrow();
  });

  it('still rejects a callback with the wrong state', async () => {
    server = new OAuthCallbackServer();
    const port = await server.start();
    const code = server.waitForCode('expected');
    const rejection = expect(code).rejects.toThrow('state mismatch');

    const status = await get('127.0.0.1', port, '/callback?code=abc&state=forged');
    expect(status).toBe(400);
    await rejection;
  });

  it('turns a server error after listening into a rejected sign-in, not a crash', async () => {
    server = new OAuthCallbackServer();
    await server.start();
    const code = server.waitForCode('s');
    const rejection = expect(code).rejects.toThrow('boom');

    (server as any).servers[0].emit('error', new Error('boom'));
    await rejection;
  });

  it('closes every listener on shutdown', async () => {
    server = new OAuthCallbackServer();
    const port = await server.start();
    server.shutdown();
    expect(server.boundAddresses()).toEqual([]);
    await expect(get('127.0.0.1', port, '/callback?code=abc')).rejects.toThrow();
  });
});
