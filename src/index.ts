import { CredentialStore, requireEncryptionKey } from './auth/credential-store.js';
import { startServer } from './server.js';
import { startHttpServer } from './http-server.js';
import { getTransport } from './config.js';

/** Require encryption configuration, then start setup or the selected MCP transport. */
async function main(): Promise<void> {
  requireEncryptionKey();
  const args = process.argv.slice(2);

  // `npx email-mcp setup` → launch interactive wizard
  if (args.includes('setup')) {
    await import('./setup/wizard.js');
    return;
  }

  const transport = getTransport(args);
  if (transport === 'http') {
    const listener = await startHttpServer();
    console.error(`Email MCP listening at ${listener.url}`);
    let stopping = false;
    /** Drain HTTP work once on termination and force exit if shutdown exceeds ten seconds. */
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      const timeout = setTimeout(() => {
        listener.server.closeAllConnections();
        process.exit(1);
      }, 10_000);
      timeout.unref();
      void listener.close().then(() => {
        clearTimeout(timeout);
      }).catch(() => {
        console.error('HTTP shutdown failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  // Check if any accounts are configured
  const store = new CredentialStore();
  const accounts = await store.list();

  if (accounts.length === 0) {
    if (process.stdin.isTTY) {
      // User ran directly in terminal — launch wizard automatically
      console.log('No email accounts configured. Starting setup wizard...\n');
      await import('./setup/wizard.js');
      return;
    } else {
      // Launched by an MCP client — warn and start server anyway
      console.error(
        'No email accounts configured. Run `node dist/setup/wizard.js` to add an account.',
      );
    }
  }

  await startServer();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
