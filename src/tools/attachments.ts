import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
import type { SendEmailParams } from '../providers/provider.js';

type Attachment = NonNullable<SendEmailParams['attachments']>[number];

// Gmail's hard limit is 25 MB per message; Outlook's inline send limit is lower
// (see ROADMAP), so this cap is the ceiling, not a guarantee every provider accepts it.
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ics': 'text/calendar',
};

export const AttachmentInputSchema = z
  .object({
    path: z.string().optional().describe('Absolute path of a local file to attach (read by the server)'),
    content: z.string().optional().describe('Base64-encoded file content, used instead of path'),
    filename: z.string().optional().describe('File name shown to the recipient. Required with content; defaults to the file name of path'),
    contentType: z.string().optional().describe('MIME type. Inferred from the file extension when omitted'),
  })
  .describe('One attachment: give either path or content (base64) plus filename');

export const AttachmentsSchema = z
  .array(AttachmentInputSchema)
  .optional()
  .describe(`Files to attach. Total size is capped at ${MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024)} MB`);

export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

function inferContentType(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function resolveOne(input: AttachmentInput): Attachment {
  if (input.path && input.content) {
    throw new Error('Attachment must have either path or content, not both');
  }
  if (input.path) {
    if (!isAbsolute(input.path)) {
      throw new Error(`Attachment path must be absolute: ${input.path}`);
    }
    if (!statSync(input.path).isFile()) {
      throw new Error(`Attachment path is not a file: ${input.path}`);
    }
    const filename = input.filename ?? basename(input.path);
    return {
      filename,
      content: readFileSync(input.path),
      contentType: input.contentType ?? inferContentType(filename),
    };
  }
  if (input.content !== undefined) {
    if (!input.filename) throw new Error('Attachment with content requires a filename');
    return {
      filename: input.filename,
      content: Buffer.from(input.content, 'base64'),
      contentType: input.contentType ?? inferContentType(input.filename),
    };
  }
  throw new Error('Attachment needs a path or content');
}

/** Resolve tool-level attachment inputs into provider attachments, enforcing the size cap. */
export function resolveAttachments(inputs: AttachmentInput[] | undefined): Attachment[] | undefined {
  if (!inputs?.length) return undefined;
  const attachments = inputs.map(resolveOne);
  const total = attachments.reduce((sum, a) => sum + a.content.length, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments total ${(total / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024)} MB limit`,
    );
  }
  return attachments;
}
