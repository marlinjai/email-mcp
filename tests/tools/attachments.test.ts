import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAttachments, MAX_TOTAL_ATTACHMENT_BYTES } from '../../src/tools/attachments.js';

describe('resolveAttachments', () => {
  let dir: string;
  let pdfPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'email-mcp-att-'));
    pdfPath = join(dir, 'Invoice 59.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4 test'));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined when no attachments are given', () => {
    expect(resolveAttachments(undefined)).toBeUndefined();
    expect(resolveAttachments([])).toBeUndefined();
  });

  it('reads a local file and infers name and MIME type', () => {
    const [att] = resolveAttachments([{ path: pdfPath }])!;
    expect(att.filename).toBe('Invoice 59.pdf');
    expect(att.contentType).toBe('application/pdf');
    expect(att.content.toString()).toBe('%PDF-1.4 test');
  });

  it('lets filename and contentType override the path defaults', () => {
    const [att] = resolveAttachments([{ path: pdfPath, filename: 'renamed.bin', contentType: 'application/x-test' }])!;
    expect(att.filename).toBe('renamed.bin');
    expect(att.contentType).toBe('application/x-test');
  });

  it('decodes base64 content', () => {
    const [att] = resolveAttachments([
      { content: Buffer.from('a,b\n1,2').toString('base64'), filename: 'data.csv' },
    ])!;
    expect(att.content.toString()).toBe('a,b\n1,2');
    expect(att.contentType).toBe('text/csv');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    const [att] = resolveAttachments([{ content: 'AA==', filename: 'blob.xyz' }])!;
    expect(att.contentType).toBe('application/octet-stream');
  });

  it('rejects content without a filename', () => {
    expect(() => resolveAttachments([{ content: 'AA==' }])).toThrow(/requires a filename/);
  });

  it('rejects both path and content', () => {
    expect(() => resolveAttachments([{ path: pdfPath, content: 'AA==' }])).toThrow(/not both/);
  });

  it('rejects an entry with neither path nor content', () => {
    expect(() => resolveAttachments([{ filename: 'x.pdf' }])).toThrow(/needs a path or content/);
  });

  it('rejects relative paths', () => {
    expect(() => resolveAttachments([{ path: 'relative/file.pdf' }])).toThrow(/must be absolute/);
  });

  it('rejects a directory path', () => {
    expect(() => resolveAttachments([{ path: dir }])).toThrow(/not a file/);
  });

  it('enforces the total size cap', () => {
    const big = Buffer.alloc(MAX_TOTAL_ATTACHMENT_BYTES / 2 + 1).toString('base64');
    expect(() =>
      resolveAttachments([
        { content: big, filename: 'a.bin' },
        { content: big, filename: 'b.bin' },
      ]),
    ).toThrow(/over the 25 MB limit/);
  });
});
