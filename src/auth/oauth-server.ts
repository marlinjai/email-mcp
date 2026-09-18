import http from 'node:http';
import type { AddressInfo } from 'node:net';

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Authorization Successful</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
  <h1>Authorization Successful</h1>
  <p>You can close this window and return to the terminal.</p>
</body>
</html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html>
<head><title>Authorization Failed</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
  <h1>Authorization Failed</h1>
  <p>An error occurred during authorization. Please try again.</p>
</body>
</html>`;

/**
 * The loopback callback server that receives the OAuth redirect during
 * `email-mcp-setup`.
 *
 * It listens on the loopback interfaces only (127.0.0.1, plus ::1 when the
 * machine has IPv6), never on every interface, so nothing else on the network
 * can reach it during the up to two minutes it is open. Both providers get the
 * redirect URI `http://localhost:<port>`: Microsoft requires it to match the
 * registered `http://localhost` (any port for public clients), and Google's
 * desktop loopback flow accepts it too. Because `localhost` may resolve to ::1
 * first (macOS does this), the same port is also bound on ::1, so the browser
 * reaches this server whichever loopback address it picks.
 */
export class OAuthCallbackServer {
  private servers: http.Server[] = [];
  private resolveCode: ((code: string) => void) | null = null;
  private rejectCode: ((error: Error) => void) | null = null;
  private timeoutMs: number;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private expectedState: string | null = null;

  static readonly IPV4_LOOPBACK = '127.0.0.1';
  static readonly IPV6_LOOPBACK = '::1';
  /** Attempts at finding a port that is free on both loopback addresses. */
  private static readonly MAX_PORT_ATTEMPTS = 5;

  constructor(timeoutMs: number = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  private handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url || '/', `http://localhost`);

    if (url.pathname === '/callback' || url.pathname === '/') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');

      if (code && this.expectedState !== null && state !== this.expectedState) {
        // A code that arrives with the wrong (or no) state was not produced
        // by the authorization request we opened: drop it, never exchange it.
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML);
        this.rejectCode?.(new Error('OAuth error: state mismatch, callback did not come from the authorization request we started'));
      } else if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        this.resolveCode?.(code);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML);
        this.rejectCode?.(new Error(`OAuth error: ${error || 'no code received'}`));
      }
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  };

  private listenOn(host: string, port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.handleRequest);
      const onError = (err: Error) => {
        server.close();
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        // A server error after listening must fail the sign-in visibly,
        // never go unhandled and crash the wizard.
        server.on('error', (err) => this.rejectCode?.(err));
        resolve(server);
      });
    });
  }

  /**
   * Starts listening on an OS-assigned port on 127.0.0.1 and, when available,
   * the same port on ::1. Resolves with the port.
   */
  async start(): Promise<number> {
    let lastError: unknown;
    for (let attempt = 0; attempt < OAuthCallbackServer.MAX_PORT_ATTEMPTS; attempt++) {
      const v4 = await this.listenOn(OAuthCallbackServer.IPV4_LOOPBACK, 0);
      const addr = v4.address();
      if (!addr || typeof addr !== 'object') {
        v4.close();
        throw new Error('Failed to get server port');
      }
      const port = addr.port;

      try {
        const v6 = await this.listenOn(OAuthCallbackServer.IPV6_LOOPBACK, port);
        this.servers = [v4, v6];
        return port;
      } catch (err: any) {
        if (err?.code === 'EADDRINUSE') {
          // Another process holds this port on ::1, so a browser resolving
          // localhost to ::1 would reach it instead of us. Try another port.
          v4.close();
          lastError = err;
          continue;
        }
        // No IPv6 loopback on this machine (EADDRNOTAVAIL, EAFNOSUPPORT):
        // localhost can only resolve to 127.0.0.1 here, so IPv4 alone is enough.
        this.servers = [v4];
        return port;
      }
    }
    throw new Error(
      `Could not find a port free on both loopback addresses: ${(lastError as Error)?.message ?? 'unknown error'}`,
    );
  }

  /** The addresses the callback server is listening on (for diagnostics and tests). */
  boundAddresses(): string[] {
    return this.servers
      .map((s) => s.address())
      .filter((a): a is AddressInfo => !!a && typeof a === 'object')
      .map((a) => a.address);
  }

  /**
   * Resolve with the authorization code once the browser is redirected back.
   * Pass the `state` that was put into the authorization URL: callbacks whose
   * state does not match are rejected instead of resolved (CSRF protection).
   */
  waitForCode(expectedState?: string): Promise<string> {
    this.expectedState = expectedState ?? null;
    return new Promise<string>((resolve, reject) => {
      this.resolveCode = (code: string) => {
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
        resolve(code);
      };
      this.rejectCode = (error: Error) => {
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
        reject(error);
      };

      this.timeoutHandle = setTimeout(() => {
        this.shutdown();
        reject(new Error('OAuth callback timeout — no response received'));
      }, this.timeoutMs);
    });
  }

  shutdown(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    for (const server of this.servers) {
      server.close();
    }
    this.servers = [];
  }
}
