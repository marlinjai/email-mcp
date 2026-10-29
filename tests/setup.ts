import { afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never use a developer's credentials or live configuration in offline tests.
process.env.EMAIL_MCP_KEY = 'test-only-independent-key-not-for-production';
delete process.env.EMAIL_MCP_MIGRATE_LEGACY;
delete process.env.EMAIL_MCP_ACCOUNT_IDS;
delete process.env.EMAIL_MCP_GMAIL_SCOPE;
delete process.env.EMAIL_MCP_OUTLOOK_SCOPE;
// Existing tool suites exercise explicitly enabled capabilities. The protocol
// security suite removes this allowlist to test the production defaults.
process.env.EMAIL_MCP_ALLOWED_TOOLS = 'email_list_accounts,email_add_account,email_remove_account,email_test_account,email_list_folders,email_search,email_get,email_get_thread,email_get_attachment,email_save_attachment,email_send,email_reply,email_forward,email_draft_create,email_draft_update,email_draft_list,email_move,email_delete,email_mark,email_batch_delete,email_batch_move,email_batch_mark,email_batch_label,email_transfer,email_label,email_folder_create,email_get_labels,email_get_categories,email_report_spam,email_batch_report_spam,email_create_block_rule,email_list_block_rules,email_delete_block_rule,email_create_forward_rule,email_list_forward_rules,email_delete_forward_rule';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-suite-'));
process.env.EMAIL_MCP_DATA_DIR = dataDir;
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
