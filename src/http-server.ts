import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireEncryptionKey } from './auth/credential-store.js';
import { createServer } from './server.js';

export const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 16;
const BODY_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface HttpConfig {
  host: string;
  port: number;
  token: string;
  allowedHosts?: string[];
}

/** Validate HTTP configuration, requiring a separate Bearer secret and explicit hosts for non-loopback binding. */
export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const token = env.EMAIL_MCP_HTTP_TOKEN ?? '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || token === env.EMAIL_MCP_KEY) {
    throw new Error('EMAIL_MCP_HTTP_TOKEN must be a separate random secret of 32–256 URL-safe characters, different from EMAIL_MCP_KEY');
  }
  const host = env.EMAIL_MCP_HTTP_HOST ?? '127.0.0.1';
  if (!isIP(host) && host !== 'localhost') throw new Error('EMAIL_MCP_HTTP_HOST must be an IP address or localhost');
  const rawPort = env.EMAIL_MCP_HTTP_PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('EMAIL_MCP_HTTP_PORT must be an integer between 0 and 65535');
  }
  const allowedHosts = env.EMAIL_MCP_HTTP_ALLOWED_HOSTS?.split(',').map((value) => value.trim().toLowerCase());
  if (allowedHosts?.some((value) => {
    if (!value || /[\s/*\\@?#]/.test(value)) return true;
    try { return !new URL(`http://${value}`).hostname; } catch { return true; }
  })) throw new Error('EMAIL_MCP_HTTP_ALLOWED_HOSTS must contain exact host[:port] values, without wildcards or URLs');
  if (!LOOPBACK_HOSTS.has(host) && !allowedHosts?.length) {
    throw new Error('Non-loopback HTTP binding requires EMAIL_MCP_HTTP_ALLOWED_HOSTS and a trusted TLS proxy or encrypted tunnel');
  }
  return { host, port, token, allowedHosts };
}

class RequestError extends Error {
  /** Carry a safe HTTP status and JSON-RPC error code for request failures returned to the client. */
  constructor(readonly status: number, message: string, readonly rpcCode = -32000) { super(message); }
}

/** Send a JSON-RPC error only while the response is writable and headers have not been sent. */
function reply(res: ServerResponse, status: number, message: string, code = -32000): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Read only after authentication; bound both bytes and time, including chunked bodies. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new RequestError(408, 'Request body timed out')), BODY_TIMEOUT_MS);
    /** Settle body parsing once, clear the timeout and listeners, and drain rejected input. */
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      if (error) { chunks.length = 0; req.resume(); reject(error); }
      else {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new RequestError(400, 'Invalid JSON', -32700)); }
      }
    };
    /** Accumulate request bytes until the body limit is reached, then reject and drain the upload. */
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) finish(new RequestError(413, 'Request body exceeds 1 MiB'));
      else chunks.push(chunk);
    };
    /** Complete JSON parsing after the request body ends. */
    const onEnd = () => finish();
    /** Reject an upload that the client aborted. */
    const onAborted = () => finish(new RequestError(400, 'Request aborted'));
    /** Convert a request stream error to a safe client-facing error. */
    const onError = () => finish(new RequestError(400, 'Request failed'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
}

/** One operator identity per deployment; never share transports or account connections between requests. */
export async function startHttpServer(
  config: HttpConfig = readHttpConfig(),
  makeServer: typeof createServer = createServer,
) {
  requireEncryptionKey();
  const expectedTokenHash = createHash('sha256').update(config.token).digest();
  let allowedHosts = new Set(config.allowedHosts);
  const pending = new Set<Promise<void>>();
  let closing = false;

  /** Authenticate and bound each POST before creating isolated MCP connections and cleaning them up. */
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // No browser clients/CORS: these requests must come from a trusted MCP host.
    if (req.headers.origin !== undefined || !allowedHosts.has(req.headers.host?.toLowerCase() ?? '')) {
      reply(res, 403, 'Host or Origin not allowed');
      return;
    }
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(req.headers.authorization ?? '');
    if (!bearer || !timingSafeEqual(expectedTokenHash, createHash('sha256').update(bearer[1]).digest())) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="email-mcp"');
      reply(res, 401, 'Unauthorized');
      return;
    }
    if (req.url !== '/mcp') { reply(res, 404, 'Not found'); return; }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      reply(res, 405, 'This endpoint accepts stateless MCP POST requests');
      return;
    }
    if (closing || pending.size >= MAX_CONCURRENT_REQUESTS) {
      res.setHeader('Retry-After', '1');
      reply(res, 503, 'Server busy');
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') ||
        (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
      reply(res, 415, 'Use uncompressed application/json');
      return;
    }
    if (Number(req.headers['content-length']) > MAX_HTTP_BODY_BYTES) {
      reply(res, 413, 'Request body exceeds 1 MiB');
      return;
    }

    const body = await readJson(req);
    const { server, accountManager } = await makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      // JSON responses keep this promise pending until the tool finishes, even
      // if the client disconnects. Do not retry a send on behalf of the caller.
      await transport.handleRequest(req, res, body);
    } finally {
      try { await server.close(); }
      finally { await accountManager.disconnectAll(); }
    }
  };

  const listener = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: BODY_TIMEOUT_MS }, (req, res) => {
    const task = handle(req, res).catch((error: unknown) => {
      // Never return/log provider objects, headers, bodies, tokens or stack traces.
      if (error instanceof RequestError) reply(res, error.status, error.message, error.rpcCode);
      else reply(res, 500, 'Internal server error', -32603);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(config.port, config.host, () => {
      listener.off('error', reject);
      const address = listener.address();
      if (!address || typeof address === 'string') { reject(new Error('HTTP listener has no address')); return; }
      if (!config.allowedHosts) {
        allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`]);
      }
      resolve();
    });
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener has no address');
  const host = isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  let shutdown: Promise<void> | undefined;
  return {
    url: `http://${host}:${address.port}/mcp`,
    server: listener,
    /** Stop accepting connections and await pending work, returning the same promise on repeated calls. */
    close(): Promise<void> {
      if (!shutdown) {
        closing = true;
        shutdown = (async () => {
          await new Promise<void>((resolve, reject) => {
            listener.close((error) => error ? reject(error) : resolve());
            listener.closeIdleConnections();
          });
          await Promise.allSettled([...pending]);
        })();
      }
      return shutdown;
    },
  };
}
