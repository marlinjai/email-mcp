# Security configuration

This is a single-user MCP server with stdio and opt-in authenticated Streamable HTTP transports. The following defaults apply to this hardened checkout, not to an unmodified npm installation.

## Encryption and upgrades

`EMAIL_MCP_KEY` is required for CLI startup and secret reads/writes. Generate at least 32 random bytes (for example with `openssl rand -hex 32`) once, retain them securely, and supply the resulting key to both setup and the MCP host. The 32-character input check is not an entropy guarantee: do not use a predictable passphrase. Keep the key separate from the encrypted files and source repository. Losing it requires reauthentication. Encryption does not protect against code running as the same OS user or an MCP host that can read the process environment.

For existing installations:

1. Back up the credential/cache files privately before upgrading. Do not print their contents or put them in Git.
2. If the files were encrypted with an existing `EMAIL_MCP_KEY`, keep that key. If it is shorter than the new minimum, keep the private backup and reauthenticate with a new random key in a fresh `EMAIL_MCP_DATA_DIR`; this checkout does not guess old passphrases.
3. For machine/hostname-derived credentials or the old plaintext Outlook cache, explicitly set `EMAIL_MCP_MIGRATE_LEGACY=true` together with a new key. Only migrate files you trust from your own installation.
4. Run `node dist/setup/wizard.js --list` to migrate credentials. If using Outlook, run `email_test_account` for each configured Outlook account with the migration flag present so MSAL loads and migrates its cache too. Then remove the migration flag and restart. Migrated files must decrypt without it. If the old machine identity changed, migrate on the original machine or reauthenticate.

New writes always use the independent secret, even during migration. Decryption failure does not overwrite the existing file. An encrypted MSAL cache always takes precedence over plaintext, even if the plaintext is newer. Without explicit migration, a legacy plaintext-only cache is refused and preserved. Migration validates the legacy cache before replacing it. If both files exist during migration, plaintext is removed only when its parsed content equals the decrypted cache. Different content stops migration and preserves both files, regardless of modification times. Stop all server/setup processes and back up both files privately before choosing which cache to retain or reauthenticating in a fresh data directory. Do not automatically merge them: this could restore removed accounts. Writes use private temporary files and atomic replacement.

Outlook cache reads and writes hold a filesystem lock for the complete MSAL transaction, shared by HTTP, stdio and setup processes using this version and the same cache. Use local storage with atomic directory creation and upgrade every process accessing the cache; older versions do not honor this lock. Lock acquisition times out after 10 seconds rather than overwriting another transaction. A crash or forced termination may leave an empty `msal-cache.enc.lock` directory beside the cache. After stopping **all** server and setup processes sharing that cache, remove only that lock directory and restart. Locks are never stolen based on their age, because a paused live process might still own them.

## Tools and OAuth permissions

Without `EMAIL_MCP_ALLOWED_TOOLS`, only these tools are registered:

- Account list and connection test.
- Folder list, search, message/thread/attachment reads.
- Draft list, label/category list, block/forward rule lists.

Sending, replying, forwarding, drafting, account changes, deletion, mailbox mutation, rule creation/removal and attachment downloads to disk are disabled. A disabled tool cannot be called by guessing its name. The allowlist, if set, **replaces** the defaults and accepts exact comma-separated tool names; an empty list grants no tools. There is no wildcard. A misspelled name grants nothing.

For a read-and-reply deployment, for example:

```text
EMAIL_MCP_ALLOWED_TOOLS=email_list_accounts,email_test_account,email_list_folders,email_search,email_get,email_get_thread,email_reply
EMAIL_MCP_GMAIL_SCOPE=read-send
EMAIL_MCP_OUTLOOK_SCOPE=read-write
EMAIL_MCP_ACCOUNT_IDS=<one-account-id>
```

These are operator settings, not tool arguments. Restart after changing them. Set scopes during setup and also in the runtime environment. Gmail defaults to `readonly`; opt-in modes are `read-send`, `restricted`, and `full`. Outlook defaults to `readonly`; opt-in modes are `read-send`, `read-write`, and `full`. The existing Outlook reply implementation creates and edits a draft, which [requires `Mail.ReadWrite`](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0); therefore the example uses `read-write` (`Mail.ReadWrite` + `Mail.Send`, without mailbox settings). Outlook `read-send` supports reading and sending new messages, but not this reply/draft flow. Listing settings-backed rules/categories may fail if the read-only grant lacks the relevant provider permission; it never silently upgrades the grant. Enabling a tool does not widen OAuth scopes. Changing configuration does not revoke older broad grants: revoke them at the provider and reauthorize to reduce permissions. IMAP/app passwords usually cannot enforce provider-side read-only access; the tool allowlist still applies.

**When enabling writes, require human approval in the MCP host for each action**, showing the final recipients, body and attachments. The server does not have a trusted human approval UI, and an enabled tool executes immediately. A model-provided `confirmed=true` is not human authorization. Prefer local setup over enabling `email_add_account`, since that tool takes a password through the model/client conversation.

Mail bodies, attachments, verification codes and reset links can reach the MCP client and its model when requested. Read-only does not mean nonsensitive. Treat mail content as untrusted data, never instructions. Keyword redaction cannot guarantee protection against prompt injection or data exfiltration through other enabled tools or model logging.

## Account and deployment boundary

`EMAIL_MCP_ACCOUNT_IDS` is an optional exact comma-separated process allowlist. It filters account discovery and rejects access before connection, refresh, mutation or cached provider reuse. An explicitly empty value denies every account; an unset value exposes all accounts in that private data directory, as appropriate for a single user.

`EMAIL_MCP_DATA_DIR` selects the directory for credentials, MSAL tokens and default downloads. Use a separate process, private data directory, OS/container boundary and encryption key per user. An account allowlist does not turn a shared credential file/process into a tenant isolation boundary. The built-in HTTP transport authenticates one operator identity with `EMAIL_MCP_HTTP_TOKEN`; it does not implement per-request user ownership or multi-tenant OAuth. All holders of that token share the configured account/tool permissions. Run a separate private deployment and HTTP token for each user; do not turn one deployment into a shared multi-user endpoint.

## HTTP boundary

HTTP is opt-in (`--transport http` or `EMAIL_MCP_TRANSPORT=http`) and defaults to `127.0.0.1:3000/mcp`. A distinct HTTP Bearer token is mandatory on every request, including initialization and subsequent calls. Query parameters and cookies are not authentication mechanisms. Tokens are compared through constant-time SHA-256 digest comparison and are not logged or included in error responses. Restart the server and update clients to rotate a token; there are no persistent HTTP sessions to revoke.

Host headers must match the configured exact allowlist. Forwarded headers are not trusted. Requests carrying Origin headers are rejected; no browser/CORS access is enabled. Non-loopback binding requires an explicit Host allowlist, and deployment must provide HTTPS or an encrypted tunnel: the Node listener itself does not terminate TLS. Host checks are not a replacement for authentication or network access controls. Reverse proxies must forward the Authorization and MCP headers and avoid logging credentials, request bodies or mail responses.

The implementation uses a fresh stateless MCP transport and account manager per request, avoiding shared request-ID state between clients. It returns JSON responses and does not offer a persistent SSE channel, resumability, or per-session cancellation. Malformed/oversized bodies are rejected before creating account connections. Bodies are bounded to 1 MiB with a 30-second receipt limit; headers are bounded to 8 KiB and there are at most 16 in-flight requests. Connections are cleaned up after a request completes. Shutdown waits up to 10 seconds in the CLI before forcing exit. Network failures or shutdown do not prove a send was cancelled; do not automatically retry it.

The tool allowlist, account allowlist, encryption, and host-side human approval requirements are identical for both transports. HTTP authentication does not prevent an authorized model from misusing tools the operator enables.

## Filesystem boundary

`email_save_attachment` must be explicitly enabled. It confines paths to `EMAIL_MCP_DOWNLOADS_DIR` (default: `<data-dir>/downloads`), rejects linked directories, destination symbolic/hard links and special files, and validates after asynchronous fetching. Files are replaced atomically with mode 0600; created directories use 0700. Existing directories must be owned by the current user and not group/world writable on POSIX. Attachments on disk are not encrypted.

Keep the configured base directory and its ancestors under trusted control. Portable Node path checks are not a sandbox against a malicious concurrent process running as the same user and swapping parent directories. Use OS/container isolation for that threat. Windows deployments need private ACLs; POSIX modes are not a Windows ACL guarantee. Keep the outgoing attachment directory separate from private state; the send-attachment guard also excludes a custom `EMAIL_MCP_DATA_DIR`.

## Verification scope

Regression tests use fake credentials and local/in-memory transports. They cover legacy migration consent and conflicts, wrong-key failures, concurrent Outlook account removal, cross-process cache transactions and crash locks, read-only OAuth defaults, disabled MCP calls, account restrictions, attachment link attacks, HTTP authentication/Host/Origin checks, body limits, and concurrent MCP requests. They do not certify dependency/package provenance, an MCP host's approvals, or live provider behavior.
