---
type: plan
status: completed
date: 2026-02-15
projects: [email-mcp]
---

# Clean My Email — Design Document

**Date:** 2026-02-15
**Status:** Approved

## Reality update (2026-09-10)

Superseded by the unified `@marlinjai/email-mcp` Model Context Protocol server
(`docs/plans/2026-02-16-email-mcp-design.md` and its implementation plan), which
shipped a provider-adapter architecture instead of the `nikolausm/imap-mcp-server`
dependency this document proposed. The product is live on npm at v1.8.0 (published 2026-09-18) with 334
passing tests. Marked completed rather than archived because the underlying goal
(multi-account triage across Gmail, iCloud and Outlook) is exactly what shipped,
just built differently.

## Purpose

An MCP-powered Claude Code skill that connects to multiple email accounts (Gmail, iCloud, Outlook) and intelligently triages junk mail — classifying, rescuing non-junk, sorting promotions, blocking spam domains, and learning over time.

## Architecture

### Components

1. **MCP Server**: `nikolausm/imap-mcp-server` — provides IMAP access to all three accounts via a single server with multi-account support, encrypted credential storage, and a web setup wizard.

2. **Claude Code Skill**: `/clean-email` — a project-scoped command at `.claude/commands/clean-email.md` that orchestrates the entire cleaning workflow using MCP tools and Claude's classification judgment.

3. **Blocklist**: `config/blocklist.json` — a persistent, growing list of blocked sender domains. Checked before classification to skip known junk without re-analyzing. Manually editable.

### MCP Server Setup

- Install `nikolausm/imap-mcp-server` globally via npm
- Configure 3 accounts via web wizard (`npm run setup`): Gmail, iCloud Mail, Outlook
- Register as a global MCP server in `~/.claude/settings.json`
- Credentials encrypted with AES-256, keys stored in `~/.imap-mcp/.key`

### Workflow (per `/clean-email` invocation)

1. **List accounts** — verify all connected accounts
2. **For each account:**
   a. List IMAP folders to discover folder names (Junk, Spam, Promotions, etc.)
   b. Open junk/spam folder
   c. Fetch recent emails (last 7 days or since last run)
   d. **Pre-filter**: auto-delete anything from blocklisted domains
   e. **Classify remaining** using Claude's judgment:
      - **Junk** → delete, add sender domain to blocklist
      - **Not junk** → move to Inbox, flag, print summary
      - **Promotion/Newsletter** → move to matching existing folder
3. **Report results**: deleted count, rescued count, sorted count, new blocked domains

### Folder Matching

The skill reads actual IMAP folder names from each account and matches promotions/newsletters to existing folders. No hardcoded folder names — adapts to whatever folders the user has.

### Blocklist (`config/blocklist.json`)

```json
{
  "blocked_domains": ["spammer.com", "junk-mail.net"],
  "last_updated": "2026-02-15T12:00:00Z",
  "stats": {
    "total_blocked": 42,
    "total_rescued": 7
  }
}
```

- Grows automatically as junk is confirmed
- Manually editable to unblock false positives
- Checked before AI classification to save processing time

## Project Structure

```
/Users/marlinjai/software dev/clean-my-email/
├── .claude/
│   └── commands/
│       └── clean-email.md       # The /clean-email skill
├── docs/
│   └── plans/
│       └── 2026-02-15-clean-my-email-design.md
├── config/
│   └── blocklist.json           # Blocked domains, persisted
├── .gitignore
└── README.md
```

## Accounts

- Gmail (primary)
- iCloud Mail
- Outlook

## Key Design Decisions

- **MCP over API**: Uses existing Claude subscription, no additional API costs
- **nikolausm/imap-mcp-server**: Chosen for native multi-account support over non-dirty/imap-mcp (single account only)
- **Skill over script**: Interactive Claude Code command rather than automated cron — user stays in control
- **Domain blocking**: Builds intelligence over time, reducing classification work on repeat runs
- **Folder discovery**: Dynamic folder matching avoids hardcoded assumptions about email provider folder structure
