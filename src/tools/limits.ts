import { z } from 'zod';

/**
 * Upper bounds for list inputs on the MCP tools. Tool arguments come from the
 * AI client, which can be steered by the content of the emails it reads, so
 * every list a tool accepts is bounded before any provider call runs.
 */

/** Gmail and Outlook both cap a message at 500 recipients. */
export const MAX_RECIPIENTS = 500;

/** Gmail's batchModify and batchDelete accept at most 1000 ids per call. */
export const MAX_BATCH_EMAIL_IDS = 1000;

/** Labels or categories added or removed in one call. */
export const MAX_LABELS = 100;

/** Attachments on one message (their total size is capped separately). */
export const MAX_ATTACHMENTS = 100;

/** A list of email ids for a batch tool: at least one, at most MAX_BATCH_EMAIL_IDS. */
export function emailIdList() {
  return z.array(z.string()).min(1).max(MAX_BATCH_EMAIL_IDS);
}

/** A list of label names or ids, at most MAX_LABELS. */
export function labelList() {
  return z.array(z.string()).max(MAX_LABELS);
}
