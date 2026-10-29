import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Serialize complete cache transactions across processes, including path aliases. */
export async function acquireCacheLock(cacheFilePath: string, timeoutMs = 10_000): Promise<() => void> {
  const directory = path.dirname(path.resolve(cacheFilePath));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(fs.realpathSync(directory), `${path.basename(cacheFilePath)}.lock`);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) {
        throw new Error(
          'Timed out waiting for the Outlook cache lock. Retry after other operations finish. ' +
          'If a process crashed, stop all email-mcp and setup processes before removing the cache .lock directory.',
        );
      }
      await delay(25);
    }
  }
  // Never steal an old lock: a live process may be paused for an arbitrary time.
  let released = false;
  return () => {
    if (released) return;
    fs.rmdirSync(lockPath);
    released = true;
  };
}
