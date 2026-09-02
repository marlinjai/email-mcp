---
title: Batch Label Tool + Gmail Nested Folder Fix
summary: >
  Adds an email_batch_label tool (native Gmail batchModify, sequential
  fallback elsewhere) and fixes Gmail's createFolder silently dropping
  parentPath, which was creating flat labels instead of nested ones.
type: plan
status: completed
tags: [email-mcp, gmail, labels, batch, bugfix]
projects: [email-mcp]
date: 2026-09-02
---

# Batch Label Tool + Gmail Nested Folder Fix

## Why

While sorting Anthropic emails into a "Tech/Anthropic" Gmail label, two gaps surfaced:

1. **No batch label tool.** `email_label` only takes one `emailId` at a time. Labeling
   42 emails took 42 individual tool calls, unlike move/mark/delete which all have
   `email_batch_*` equivalents. This should be closed, matching the existing pattern.
2. **Nested label creation is broken.** `email_folder_create` was called with
   `name: "Anthropic", parentPath: "Tech"` and reported success, but the label was
   created flat as `"Anthropic"`, not nested as `"Tech/Anthropic"`. Root cause: Gmail's
   `createFolder(name)` in `src/providers/gmail/adapter.ts` never reads its own
   `parentPath` parameter (the interface declares `parentPath?: string` and Outlook/IMAP
   both honor it — Gmail is the only provider silently dropping it). Gmail has no real
   folder hierarchy; nesting is just a `/`-delimited label name, so the fix is to build
   `parentPath ? \`${parentPath}/${name}\` : name` before calling `labels.create`,
   exactly like the IMAP adapter already does for its own nested mailbox paths.

Per project convention (fix the class not the instance, no open follow-ups), both go
in this one change rather than filing the bug for later.

## Scope

1. `src/providers/gmail/adapter.ts`
   - Fix `createFolder(name, parentPath?)` to build the full `parentPath/name` label name.
   - Add `batchLabel(emailIds, addLabels?, removeLabels?): Promise<BatchResult>` using a
     single `gmail.users.messages.batchModify` call (native batch, not a sequential loop),
     falling back to per-id `addLabels`/`removeLabels` calls only if the batch call throws.
2. `src/providers/provider.ts`
   - Add optional `batchLabel?(emailIds, addLabels?, removeLabels?): Promise<BatchResult>`
     to `EmailProvider`, mirroring `batchMove`/`batchMark`.
3. `src/tools/organizing.ts`
   - Add `email_batch_label` tool: same shape as `email_label` but `emailIds: string[]`.
     Rejects with the existing "Gmail only" error when the provider lacks
     `addLabels`/`removeLabels`. Uses `provider.batchLabel` when present, else falls back
     to the same sequential per-id loop pattern used by `email_batch_mark`/`email_batch_move`.
4. Tests
   - `tests/providers/gmail.test.ts`: `createFolder` nests when `parentPath` given, stays
     flat without it; `batchLabel` calls `batchModify` once with correct add/remove ids and
     falls back to per-id calls on batch failure.
   - `tests/tools/organizing.test.ts`: `email_batch_label` happy path (Gmail provider,
     native batch), fallback path (no native `batchLabel` on provider), and the
     non-Gmail rejection path.
5. No MCP client-facing docs to update beyond the tool's own description (self-documenting
   like the other batch tools).

## Out of scope

- No change to `email_label` (single-email tool stays as is).
- No change to Outlook/IMAP/iCloud label or folder behavior — they already handle
  `parentPath` correctly and have no label concept to batch.
