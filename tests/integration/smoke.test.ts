import { describe, it, expect } from 'vitest';
import { createServer } from '../../src/server.js';

describe('Smoke test', () => {
  it('creates the server successfully', async () => {
    const result = await createServer();
    expect(result.server).toBeDefined();
    expect(result.accountManager).toBeDefined();
  });

  it('registers all expected account tools', async () => {
    const { server } = await createServer();
    const tools = (server as any)._registeredTools;

    const accountTools = [
      'email_list_accounts',
      'email_add_account',
      'email_remove_account',
      'email_test_account',
    ];

    for (const name of accountTools) {
      expect(tools).toHaveProperty(name);
    }
  });

  it('registers all expected reading tools', async () => {
    const { server } = await createServer();
    const tools = (server as any)._registeredTools;

    const readingTools = [
      'email_list_folders',
      'email_search',
      'email_get',
      'email_get_thread',
      'email_get_attachment',
    ];

    for (const name of readingTools) {
      expect(tools).toHaveProperty(name);
    }
  });

  it('registers all expected sending tools', async () => {
    const { server } = await createServer();
    const tools = (server as any)._registeredTools;

    const sendingTools = [
      'email_send',
      'email_reply',
      'email_forward',
      'email_draft_create',
      'email_draft_list',
    ];

    for (const name of sendingTools) {
      expect(tools).toHaveProperty(name);
    }
  });

  it('registers all expected organizing tools', async () => {
    const { server } = await createServer();
    const tools = (server as any)._registeredTools;

    const organizingTools = [
      'email_move',
      'email_delete',
      'email_mark',
      'email_batch_delete',
      'email_batch_move',
      'email_batch_mark',
      'email_batch_label',
      'email_transfer',
      'email_label',
      'email_folder_create',
      'email_get_labels',
      'email_get_categories',
    ];

    for (const name of organizingTools) {
      expect(tools).toHaveProperty(name);
    }
  });

  it('registers the correct total number of tools (~33)', async () => {
    const { server } = await createServer();
    const tools = (server as any)._registeredTools;
    const toolNames = Object.keys(tools);

    // 4 account + 6 reading (5 original + email_save_attachment)
    // + 6 sending (5 original + email_draft_update)
    // + 12 organizing (7 original + 4 batch [move/delete/mark/label] + email_transfer)
    // + 5 moderation (report_spam, batch_report_spam, create/list/delete_block_rule) = 33
    expect(toolNames.length).toBe(33);
  });

  it('all registered tool names start with email_ prefix', async () => {
    const { server } = await createServer();
    const tools = (server as any)._registeredTools;
    const toolNames = Object.keys(tools);

    for (const name of toolNames) {
      expect(name).toMatch(/^email_/);
    }
  });
});
