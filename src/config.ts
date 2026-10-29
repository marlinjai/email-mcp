import os from 'node:os';
import path from 'node:path';

/** One private directory per user/process deployment. */
export function getDataDir(): string {
  return path.resolve(process.env.EMAIL_MCP_DATA_DIR || path.join(os.homedir(), '.email-mcp'));
}

/** Select the CLI transport over the environment default, rejecting unsupported modes and arguments. */
export function getTransport(args: string[], env: NodeJS.ProcessEnv = process.env): 'stdio' | 'http' {
  let mode = env.EMAIL_MCP_TRANSPORT ?? 'stdio';
  if (args.length === 2 && args[0] === '--transport') mode = args[1];
  else if (args.length === 1 && args[0].startsWith('--transport=')) mode = args[0].slice('--transport='.length);
  else if (args.length !== 0) throw new Error('Usage: email-mcp [--transport stdio|http] or email-mcp setup');
  if (mode !== 'stdio' && mode !== 'http') throw new Error('Transport must be stdio or http');
  return mode;
}
