// Publisher-provided OAuth credentials (PKCE public clients).
// These are intentionally shipped in source — safe for desktop/CLI apps.
// Same pattern as GitHub CLI, VS Code, Firebase CLI, etc.
//
// Set EMAIL_MCP_GMAIL_CLIENT_ID / EMAIL_MCP_GMAIL_CLIENT_SECRET (and, for
// Outlook, EMAIL_MCP_OUTLOOK_CLIENT_ID) to bring your own Google Cloud /
// Azure AD app instead of the shared one below — see README.md. This keeps
// your token lifecycle independent of the publisher's Cloud project.

export const GMAIL_CLIENT_ID =
  process.env.EMAIL_MCP_GMAIL_CLIENT_ID ||
  '1062266096576-lu2ukplhc3lcm0bvheml5i18urptdp4t.apps.googleusercontent.com';
export const GMAIL_CLIENT_SECRET =
  process.env.EMAIL_MCP_GMAIL_CLIENT_SECRET || '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';
export const OUTLOOK_CLIENT_ID =
  process.env.EMAIL_MCP_OUTLOOK_CLIENT_ID || '76d32225-ef10-4b49-951c-c80ae906595d';
