import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'EMAIL_MCP_GMAIL_CLIENT_ID',
  'EMAIL_MCP_GMAIL_CLIENT_SECRET',
  'EMAIL_MCP_OUTLOOK_CLIENT_ID',
] as const;

describe('oauth-config', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('falls back to the shipped shared credentials when no env vars are set', async () => {
    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, OUTLOOK_CLIENT_ID } = await import(
      '../src/oauth-config.js'
    );
    expect(GMAIL_CLIENT_ID).toContain('.apps.googleusercontent.com');
    expect(GMAIL_CLIENT_SECRET).toContain('GOCSPX-');
    expect(OUTLOOK_CLIENT_ID).toBe('76d32225-ef10-4b49-951c-c80ae906595d');
  });

  it('uses EMAIL_MCP_GMAIL_CLIENT_ID / EMAIL_MCP_GMAIL_CLIENT_SECRET when set', async () => {
    process.env.EMAIL_MCP_GMAIL_CLIENT_ID = 'byo-client-id';
    process.env.EMAIL_MCP_GMAIL_CLIENT_SECRET = 'byo-client-secret';
    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = await import('../src/oauth-config.js');
    expect(GMAIL_CLIENT_ID).toBe('byo-client-id');
    expect(GMAIL_CLIENT_SECRET).toBe('byo-client-secret');
  });

  it('uses EMAIL_MCP_OUTLOOK_CLIENT_ID when set', async () => {
    process.env.EMAIL_MCP_OUTLOOK_CLIENT_ID = 'byo-outlook-id';
    const { OUTLOOK_CLIENT_ID } = await import('../src/oauth-config.js');
    expect(OUTLOOK_CLIENT_ID).toBe('byo-outlook-id');
  });
});
