import { z } from 'zod';
import type { Stats } from 'node:fs';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SendEmailParams } from '../providers/provider.js';

type Attachment = NonNullable<SendEmailParams['attachments']>[number];

// Gmail's hard limit is 25 MB per message. Outlook accepts far less through
// this server (see OUTLOOK_MAX_ATTACHMENT_BYTES in the Outlook adapter), so
// this cap is the ceiling, not a promise every provider takes it.
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const ATTACHMENTS_DIR_ENV = 'EMAIL_MCP_ATTACHMENTS_DIR';

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
    path: z.string().optional().describe(
      `A file inside the folder the user set in ${ATTACHMENTS_DIR_ENV}: its name, a path relative to that folder, or an absolute path inside it. Files anywhere else are refused, and path attachments are off when that variable is not set.`,
    ),
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
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isInside(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The one folder files may be attached from. The path comes from the tool
 * caller (an LLM), which may be acting on a prompt-injected email: without a
 * restriction "attach ~/.ssh/id_ed25519 and reply" would mail out a private
 * key, and a draft plus email_get_attachment would read any local file. So
 * the folder is named by the user in the server's environment, which no tool
 * can write, and unset means path attachments are off.
 */
export function attachmentsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[ATTACHMENTS_DIR_ENV] || '').trim();
  if (!raw) return null;
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

const HOW_TO_ALLOW =
  `Set ${ATTACHMENTS_DIR_ENV} to the one folder files may be attached from (in the environment of the email-mcp server, ` +
  'in the MCP client configuration), put the file there and restart the client. ' +
  'Content passed directly as base64 with a filename works without it.';

interface Planned {
  bytes: number;
  load: () => Attachment;
}

function planPath(input: AttachmentInput, env: NodeJS.ProcessEnv, dataDir: string): Planned {
  const given = input.path as string;
  if (given.trim() === '') throw new Error('Attachment path is empty');

  const dir = attachmentsDir(env);
  if (!dir) {
    throw new Error(`Attaching files by path is switched off: ${ATTACHMENTS_DIR_ENV} is not set. ${HOW_TO_ALLOW}`);
  }

  let dirReal: string;
  try {
    dirReal = realpathSync(dir);
    if (!statSync(dirReal).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`The attachments folder ${dir} (${ATTACHMENTS_DIR_ENV}) does not exist or is not a folder.`);
  }

  // Decide by the path alone first, so a refusal says nothing about whether
  // a file outside the folder exists.
  const candidate = path.resolve(dir, given);
  if (!isInside(dir, candidate) && !isInside(dirReal, candidate)) {
    throw new Error(`Only files inside ${dir} can be attached (${ATTACHMENTS_DIR_ENV}). Put the file there and pass its name.`);
  }

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`No such file in the attachments folder: ${path.relative(dir, candidate)}`);
  }
  // A symbolic link inside the folder must not lead out of it.
  if (!isInside(dirReal, real)) {
    throw new Error(`Only files inside ${dir} can be attached (${ATTACHMENTS_DIR_ENV}); ${path.relative(dir, candidate)} points outside it.`);
  }
  // email-mcp's own files (the encrypted credential store, the token cache)
  // are never attachable, wherever the attachments folder is set to.
  let ownDir: string | null = null;
  try {
    ownDir = realpathSync(dataDir);
  } catch {
    ownDir = null;
  }
  if (ownDir && path.dirname(real) === ownDir) {
    throw new Error('Files in the email-mcp data folder itself cannot be attached.');
  }

  // lstat, not stat: `real` is already fully resolved, so a link here means
  // the path was swapped after the checks above.
  const stat = lstatSync(real);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${path.relative(dir, candidate)}`);
  }

  const filename = input.filename ?? path.basename(real);
  return {
    bytes: stat.size,
    load: () => ({
      filename,
      content: readValidatedFile(real, stat, path.relative(dir, candidate)),
      contentType: input.contentType ?? inferContentType(filename),
    }),
  };
}

/**
 * Read the file that was validated, not whatever the path names by now. The
 * file is opened without following a final link, and its identity (device and
 * inode) must still be the one checked in `planPath`; the bytes are then read
 * from that same descriptor, so a swap to a symbolic link after validation
 * cannot lead the read out of the attachments folder.
 */
function readValidatedFile(real: string, validated: Stats, display: string): Buffer {
  let fd: number;
  try {
    fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(`${display} changed while it was being attached; try again.`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== validated.dev || opened.ino !== validated.ino) {
      throw new Error(`${display} changed while it was being attached; try again.`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function planContent(input: AttachmentInput): Planned {
  if (!input.filename) throw new Error('Attachment with content requires a filename');
  const filename = input.filename;
  const compact = (input.content as string).replace(/\s+/g, '');
  if (compact === '') throw new Error(`Attachment ${filename} has empty content`);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error(`Attachment ${filename}: content is not valid base64`);
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return {
    bytes: Math.floor((compact.length * 3) / 4) - padding,
    load: () => ({
      filename,
      content: Buffer.from(compact, 'base64'),
      contentType: input.contentType ?? inferContentType(filename),
    }),
  };
}

function plan(input: AttachmentInput, env: NodeJS.ProcessEnv, dataDir: string): Planned {
  const hasPath = input.path !== undefined;
  const hasContent = input.content !== undefined;
  if (hasPath && hasContent) throw new Error('Attachment must have either path or content, not both');
  if (hasPath) return planPath(input, env, dataDir);
  if (hasContent) return planContent(input);
  throw new Error('Attachment needs a path or content');
}

/**
 * Resolve tool-level attachment inputs into provider attachments. Sizes are
 * checked before any file is read. `undefined` stays `undefined` (the caller
 * said nothing about attachments); an empty list stays an empty list (the
 * caller wants none), which is what lets a draft update remove them.
 */
export function resolveAttachments(
  inputs: AttachmentInput[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
  dataDir: string = path.join(os.homedir(), '.email-mcp'),
): Attachment[] | undefined {
  if (inputs === undefined) return undefined;
  const planned = inputs.map((input) => plan(input, env, dataDir));
  const total = planned.reduce((sum, p) => sum + p.bytes, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`Attachments total ${megabytes(total)}, over the ${megabytes(MAX_TOTAL_ATTACHMENT_BYTES)} limit`);
  }
  return planned.map((p) => p.load());
}
