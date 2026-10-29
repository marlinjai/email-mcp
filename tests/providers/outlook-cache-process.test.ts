import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import { acquireCacheLock } from '../../src/auth/cache-lock.js';
import { decryptWithMachineKey, encryptWithMachineKey } from '../../src/auth/credential-store.js';

describe('Outlook cache process coordination', () => {
  let workerDir: string;
  let dir: string;
  let cachePath: string;
  let children: ChildProcess[];

  beforeAll(async () => {
    workerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-worker-'));
    // Bundle the actual plugin, so child processes use the production locking code.
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
          const { createEncryptedFileCachePlugin } = require('./src/providers/outlook/auth.ts');
          const { once } = require('node:events');
          (async () => {
            const plugin = createEncryptedFileCachePlugin(process.argv[2]);
            let serialized = '{}';
            const context = { cacheHasChanged: true, tokenCache: {
              deserialize(value) { serialized = value; },
              serialize() { return serialized; }
            }};
            process.send({ phase: 'attempting' });
            await plugin.beforeCacheAccess(context);
            const command = once(process, 'message');
            process.send({ phase: 'loaded', value: serialized });
            const [message] = await command;
            serialized = JSON.stringify({ ...JSON.parse(serialized), [message.key]: true });
            await plugin.afterCacheAccess(context);
            process.disconnect();
          })().catch(error => { console.error(error.message); process.exit(1); });
        `,
      },
      outfile: path.join(workerDir, 'worker.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
  });
  afterAll(() => fs.rmSync(workerDir, { recursive: true, force: true }));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-process-'));
    cachePath = path.join(dir, 'msal-cache.enc');
    children = [];
  });
  afterEach(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Fork the bundled cache worker with IPC and track it for termination during test cleanup. */
  function worker(file = cachePath) {
    const child = fork(path.join(workerDir, 'worker.cjs'), [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    return child;
  }

  it('holds the lock until writeback and lets the next process read the committed cache through a directory alias', async () => {
    fs.writeFileSync(cachePath, encryptWithMachineKey('{}'));
    const first = worker();
    await once(first, 'message'); // attempting
    const [loaded] = await once(first, 'message');
    expect(loaded.phase).toBe('loaded');
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(dir, alias, 'dir');
    const second = worker(path.join(alias, 'msal-cache.enc'));
    await once(second, 'message'); // attempting while first owns the transaction
    const secondLoaded = once(second, 'message');
    const firstExit = once(first, 'exit');
    first.send({ key: 'first' });
    const [next] = await secondLoaded;
    expect(JSON.parse(next.value)).toEqual({ first: true });
    const secondExit = once(second, 'exit');
    second.send({ key: 'second' });
    expect((await firstExit)[0]).toBe(0);
    expect((await secondExit)[0]).toBe(0);
    expect(JSON.parse(decryptWithMachineKey(fs.readFileSync(cachePath, 'utf8')).plaintext))
      .toEqual({ first: true, second: true });
    expect(fs.existsSync(`${cachePath}.lock`)).toBe(false);
  });

  it('fails closed after a lock owner crashes instead of stealing its transaction', async () => {
    const first = worker();
    await once(first, 'message');
    await once(first, 'message');
    const exited = once(first, 'exit');
    first.kill('SIGKILL');
    await exited;
    await expect(acquireCacheLock(cachePath, 30)).rejects.toThrow('stop all email-mcp');
    expect(fs.existsSync(`${cachePath}.lock`)).toBe(true);
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});
