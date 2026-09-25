import { build, context } from 'esbuild';
import { chmod } from 'node:fs/promises';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  outbase: 'src',
  sourcemap: true,
  external: [
    'google-auth-library',
    'googleapis',
    '@azure/msal-node',
    '@microsoft/microsoft-graph-client',
    'imapflow',
    'mailparser',
    'nodemailer',
  ],
};

if (process.argv.includes('--watch')) {
  const ctx = await context({
    ...shared,
    entryPoints: ['src/index.ts', 'src/setup/wizard.ts'],
  });
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  // Build wizard with shebang (registered as bin: email-mcp-setup)
  await build({
    ...shared,
    entryPoints: ['src/setup/wizard.ts'],
    banner: { js: '#!/usr/bin/env node\n' },
  });

  // Build CLI entry with shebang
  await build({
    ...shared,
    entryPoints: ['src/index.ts'],
    banner: { js: '#!/usr/bin/env node\n' },
  });

  // Headless fetch CLI (registered as bin: email-mcp-fetch)
  await build({
    ...shared,
    entryPoints: ['src/cli/fetch.ts'],
    banner: { js: '#!/usr/bin/env node\n' },
  });

  // Ensure the CLI entries are executable
  await chmod('dist/index.js', 0o755);
  await chmod('dist/setup/wizard.js', 0o755);
  await chmod('dist/cli/fetch.js', 0o755);

  console.log('Build complete.');
}
