import fs from 'node:fs';
import path from 'node:path';
import { writePrivateFile } from '../auth/credential-store.js';

/** Create or validate a real download directory, rejecting links and unsafe POSIX ownership or permissions. */
function ensureDirectory(dir: string): void {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Attachment download directories must not be symbolic links');
  }
  if (process.platform !== 'win32' &&
      ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.())) {
    throw new Error('Attachment download directories must be owned by the current user and not writable by other users');
  }
}

/** The configured base and its ancestors must be controlled by the operator. */
export function saveDownload(baseDir: string, filePath: string, data: Uint8Array): void {
  const relative = path.relative(baseDir, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Attachment outputPath must be a file inside the downloads directory');
  }
  fs.mkdirSync(path.dirname(baseDir), { recursive: true, mode: 0o700 });
  ensureDirectory(baseDir);
  // Canonicalize trusted ancestors (e.g. /tmp on macOS), but reject links in
  // every caller-selected component. All checks and writes happen after fetch.
  const canonicalBase = fs.realpathSync(baseDir);
  const parts = relative.split(path.sep);
  let dir = canonicalBase;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    ensureDirectory(dir);
  }
  const destination = path.join(dir, parts[parts.length - 1]);
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('Attachment outputPath must not be a link or a special file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Replace, never truncate: even a replaced destination link cannot cause
  // writes to its target. A private temp file also restores mode 0600.
  writePrivateFile(destination, data);
}
