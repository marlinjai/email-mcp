import http from 'node:http';

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

export class OAuthCallbackServer {
  private server: http.Server | null = null;
  private resolveCode: ((code: string) => void) | null = null;
  private rejectCode: ((error: Error) => void) | null = null;
  private timeoutMs: number;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private expectedState: string | null = null;

  constructor(timeoutMs: number = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
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
      });

      this.server.listen(0, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get server port'));
        }
      });

      this.server.on('error', reject);
    });
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
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
