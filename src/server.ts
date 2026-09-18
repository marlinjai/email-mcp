import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AccountManager } from './account-manager.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerReadingTools } from './tools/reading.js';
import { registerSendingTools } from './tools/sending.js';
import { registerOrganizingTools } from './tools/organizing.js';
import { registerModerationTools } from './tools/moderation.js';

/**
 * The version reported to MCP clients in the initialize handshake. Kept equal
 * to package.json's version by tests/integration/smoke.test.ts; bump both
 * together. (A runtime read of package.json is not used because esbuild
 * bundles entry points at different depths under dist/.)
 */
export const SERVER_VERSION = '1.8.0';

export interface ServerResult {
  server: McpServer;
  accountManager: AccountManager;
}

export async function createServer(accountManager?: AccountManager): Promise<ServerResult> {
  const mgr = accountManager ?? new AccountManager();

  const server = new McpServer({
    name: 'email-mcp',
    version: SERVER_VERSION,
  });

  // Register all tool groups
  registerAccountTools(server, mgr);
  registerReadingTools(server, mgr);
  registerSendingTools(server, mgr);
  registerOrganizingTools(server, mgr);
  registerModerationTools(server, mgr);

  return { server, accountManager: mgr };
}

export async function startServer(): Promise<void> {
  const { server } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
