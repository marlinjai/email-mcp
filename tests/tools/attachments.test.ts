import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import {
  resolveAttachments,
  attachmentsDir,
  ATTACHMENTS_DIR_ENV,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '../../src/tools/attachments.js';

describe('attachmentsDir', () => {
  it('is null when the variable is unset or blank', () => {
    expect(attachmentsDir({})).toBeNull();
    expect(attachmentsDir({ [ATTACHMENTS_DIR_ENV]: '   ' })).toBeNull();
  });

  it('resolves the folder and expands a leading ~', () => {
    expect(attachmentsDir({ [ATTACHMENTS_DIR_ENV]: '/tmp/out/../outbox' })).toBe(path.resolve('/tmp/outbox'));
    expect(attachmentsDir({ [ATTACHMENTS_DIR_ENV]: '~/Outbox' })).toBe(path.join(os.homedir(), 'Outbox'));
    expect(attachmentsDir({ [ATTACHMENTS_DIR_ENV]: '~' })).toBe(os.homedir());
  });
});

describe('resolveAttachments', () => {
  let root: string;
  let dir: string;
  let outside: string;
  let env: NodeJS.ProcessEnv;
  let pdfPath: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'email-mcp-att-')));
    dir = join(root, 'outbox');
    outside = join(root, 'elsewhere');
    mkdirSync(dir);
    mkdirSync(join(dir, 'sub'));
    mkdirSync(outside);
    pdfPath = join(dir, 'Invoice 59.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4 test'));
    writeFileSync(join(dir, 'sub', 'notes.txt'), 'notes');
    writeFileSync(join(outside, 'id_ed25519'), 'PRIVATE KEY');
    symlinkSync(join(outside, 'id_ed25519'), join(dir, 'looks-harmless.txt'));
    symlinkSync(pdfPath, join(dir, 'alias.pdf'));
    env = { [ATTACHMENTS_DIR_ENV]: dir };
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describe('nothing or an empty list', () => {
    it('keeps undefined as undefined: the caller said nothing about attachments', () => {
      expect(resolveAttachments(undefined, env)).toBeUndefined();
    });

    it('keeps an empty list as an empty list: the caller wants none', () => {
      expect(resolveAttachments([], env)).toEqual([]);
    });
  });

  describe('files from the attachments folder', () => {
    it('reads a file by absolute path and infers name and MIME type', () => {
      const [att] = resolveAttachments([{ path: pdfPath }], env)!;
      expect(att.filename).toBe('Invoice 59.pdf');
      expect(att.contentType).toBe('application/pdf');
      expect(att.content.toString()).toBe('%PDF-1.4 test');
    });

    it('reads a file by its name or by a path relative to the folder', () => {
      expect(resolveAttachments([{ path: 'Invoice 59.pdf' }], env)![0].content.toString()).toBe('%PDF-1.4 test');
      expect(resolveAttachments([{ path: 'sub/notes.txt' }], env)![0].content.toString()).toBe('notes');
    });

    it('lets filename and contentType override the path defaults', () => {
      const [att] = resolveAttachments([{ path: pdfPath, filename: 'renamed.bin', contentType: 'application/x-test' }], env)!;
      expect(att.filename).toBe('renamed.bin');
      expect(att.contentType).toBe('application/x-test');
    });

    it('follows a symbolic link that stays inside the folder', () => {
      expect(resolveAttachments([{ path: 'alias.pdf' }], env)![0].content.toString()).toBe('%PDF-1.4 test');
    });

    it('accepts the folder given through a symbolic link', () => {
      const linked = join(root, 'outbox-link');
      symlinkSync(dir, linked);
      const viaLink = { [ATTACHMENTS_DIR_ENV]: linked };
      expect(resolveAttachments([{ path: join(linked, 'Invoice 59.pdf') }], viaLink)![0].filename).toBe('Invoice 59.pdf');
      expect(resolveAttachments([{ path: pdfPath }], viaLink)![0].filename).toBe('Invoice 59.pdf');
    });
  });

  describe('what it refuses', () => {
    it('refuses every path when no folder is set, and says how to set one', () => {
      expect(() => resolveAttachments([{ path: pdfPath }], {})).toThrow(/switched off/);
      expect(() => resolveAttachments([{ path: pdfPath }], {})).toThrow(new RegExp(ATTACHMENTS_DIR_ENV));
    });

    it('refuses a file outside the folder, by absolute path', () => {
      expect(() => resolveAttachments([{ path: join(outside, 'id_ed25519') }], env)).toThrow(/Only files inside/);
    });

    it('refuses a path that climbs out of the folder', () => {
      expect(() => resolveAttachments([{ path: '../elsewhere/id_ed25519' }], env)).toThrow(/Only files inside/);
      expect(() => resolveAttachments([{ path: join(dir, '..', 'elsewhere', 'id_ed25519') }], env)).toThrow(/Only files inside/);
    });

    it('refuses a sibling folder whose name only starts like the folder', () => {
      mkdirSync(join(root, 'outbox-private'));
      writeFileSync(join(root, 'outbox-private', 'secret.txt'), 'x');
      expect(() => resolveAttachments([{ path: join(root, 'outbox-private', 'secret.txt') }], env)).toThrow(/Only files inside/);
    });

    it('gives the same answer for a file outside the folder whether it exists or not', () => {
      const existing = () => resolveAttachments([{ path: join(outside, 'id_ed25519') }], env);
      const missing = () => resolveAttachments([{ path: join(outside, 'no-such-file') }], env);
      expect(existing).toThrow(/Only files inside/);
      expect(missing).toThrow(/Only files inside/);
    });

    it('refuses a symbolic link inside the folder that points outside it', () => {
      expect(() => resolveAttachments([{ path: 'looks-harmless.txt' }], env)).toThrow(/points outside/);
    });

    it('refuses the folder itself and a subfolder', () => {
      expect(() => resolveAttachments([{ path: dir }], env)).toThrow(/Only files inside/);
      expect(() => resolveAttachments([{ path: 'sub' }], env)).toThrow(/Not a file/);
    });

    it('says so when the file is not in the folder', () => {
      expect(() => resolveAttachments([{ path: 'missing.pdf' }], env)).toThrow(/No such file in the attachments folder: missing\.pdf/);
    });

    it('says so when the folder does not exist', () => {
      expect(() => resolveAttachments([{ path: 'a.pdf' }], { [ATTACHMENTS_DIR_ENV]: join(root, 'nope') })).toThrow(/does not exist/);
    });

    it('refuses an empty path', () => {
      expect(() => resolveAttachments([{ path: '' }], env)).toThrow(/path is empty/);
      expect(() => resolveAttachments([{ path: '   ' }], env)).toThrow(/path is empty/);
    });

    it('never attaches a file from the email-mcp data folder itself, even when the folder is set to it', () => {
      const dataDir = join(root, 'data');
      mkdirSync(join(dataDir, 'downloads'), { recursive: true });
      writeFileSync(join(dataDir, 'credentials.enc'), 'encrypted');
      writeFileSync(join(dataDir, 'downloads', 'saved.pdf'), 'saved');
      const ownEnv = { [ATTACHMENTS_DIR_ENV]: dataDir };

      expect(() => resolveAttachments([{ path: 'credentials.enc' }], ownEnv, dataDir)).toThrow(/data folder itself cannot be attached/);
      // A subfolder of it, for example the downloads folder, is a normal folder.
      expect(resolveAttachments([{ path: 'downloads/saved.pdf' }], ownEnv, dataDir)![0].content.toString()).toBe('saved');
      const downloadsEnv = { [ATTACHMENTS_DIR_ENV]: join(dataDir, 'downloads') };
      expect(resolveAttachments([{ path: 'saved.pdf' }], downloadsEnv, dataDir)![0].content.toString()).toBe('saved');
    });
  });

  describe('content passed directly', () => {
    it('decodes base64 content without any folder being set', () => {
      const [att] = resolveAttachments([{ content: Buffer.from('a,b\n1,2').toString('base64'), filename: 'data.csv' }], {})!;
      expect(att.content.toString()).toBe('a,b\n1,2');
      expect(att.contentType).toBe('text/csv');
    });

    it('accepts base64 with line breaks', () => {
      const encoded = Buffer.from('hello world, this is a test').toString('base64');
      const wrapped = `${encoded.slice(0, 10)}\n${encoded.slice(10)}`;
      expect(resolveAttachments([{ content: wrapped, filename: 'a.txt' }], {})![0].content.toString()).toBe('hello world, this is a test');
    });

    it('falls back to application/octet-stream for unknown extensions', () => {
      expect(resolveAttachments([{ content: 'AA==', filename: 'blob.xyz' }], {})![0].contentType).toBe('application/octet-stream');
    });

    it('rejects content without a filename', () => {
      expect(() => resolveAttachments([{ content: 'AA==' }], {})).toThrow(/requires a filename/);
    });

    it('rejects empty content and content that is not base64', () => {
      expect(() => resolveAttachments([{ content: '', filename: 'a.txt' }], {})).toThrow(/empty content/);
      expect(() => resolveAttachments([{ content: 'not base64!', filename: 'a.txt' }], {})).toThrow(/not valid base64/);
      expect(() => resolveAttachments([{ content: 'AAAAA', filename: 'a.txt' }], {})).toThrow(/not valid base64/);
    });
  });

  describe('either path or content', () => {
    it('rejects both, also when one of them is an empty string', () => {
      expect(() => resolveAttachments([{ path: pdfPath, content: 'AA==' }], env)).toThrow(/not both/);
      expect(() => resolveAttachments([{ path: pdfPath, content: '' }], env)).toThrow(/not both/);
      expect(() => resolveAttachments([{ path: '', content: 'AA==', filename: 'a.bin' }], env)).toThrow(/not both/);
    });

    it('rejects an entry with neither', () => {
      expect(() => resolveAttachments([{ filename: 'x.pdf' }], env)).toThrow(/needs a path or content/);
    });
  });

  describe('size cap', () => {
    it('enforces the total across entries', () => {
      const big = Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES / 2 + 1).toString('base64');
      expect(() =>
        resolveAttachments([{ content: big, filename: 'a.bin' }, { content: big, filename: 'b.bin' }], {}),
      ).toThrow(/over the 25\.0 MB limit/);
    });

    it('counts files by their size on disk, before reading them', () => {
      const half = Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES / 2 + 1);
      writeFileSync(join(dir, 'half-a.bin'), half);
      writeFileSync(join(dir, 'half-b.bin'), half);
      expect(() => resolveAttachments([{ path: 'half-a.bin' }, { path: 'half-b.bin' }], env)).toThrow(/over the 25\.0 MB limit/);
      expect(resolveAttachments([{ path: 'half-a.bin' }], env)![0].content.length).toBe(half.length);
    });

    it('accepts exactly the limit', () => {
      const exact = Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES).toString('base64');
      expect(resolveAttachments([{ content: exact, filename: 'max.bin' }], {})![0].content.length).toBe(MAX_TOTAL_ATTACHMENT_BYTES);
    });
  });
});
