---
type: plan
status: completed
date: 2026-02-15
projects: [email-mcp]
---

# Clean My Email — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Reality update (2026-09-10)

Superseded by the unified `@marlinjai/email-mcp` server (see
`docs/plans/2026-02-16-email-mcp-plan.md`), which shipped the same triage goal
through provider-native APIs instead of `nikolausm/imap-mcp-server`. Live on npm
at v1.8.0 (published 2026-09-18).

**Goal:** Set up an MCP-powered Claude Code skill that triages junk mail across Gmail, iCloud, and Outlook accounts — classifying, rescuing, sorting, and blocking spam domains.

**Architecture:** `nikolausm/imap-mcp-server` provides multi-account IMAP access as a global MCP server. A Claude Code skill (`/clean-email`) orchestrates the cleaning workflow using MCP tools and Claude's classification judgment. A `blocklist.json` persists blocked domains between runs.

**Tech Stack:** nikolausm/imap-mcp-server (TypeScript/Node), Claude Code skills (.md), JSON config

---

### Task 1: Install imap-mcp-server

**Files:**
- Clone to: `/Users/marlinjai/software dev/clean-my-email/mcp-server/`

**Step 1: Clone and build the MCP server**

```bash
cd "/Users/marlinjai/software dev/clean-my-email"
git clone https://github.com/nikolausm/imap-mcp-server.git mcp-server
cd mcp-server
npm install
npm run build
```

**Step 2: Verify the build succeeded**

Run: `ls "/Users/marlinjai/software dev/clean-my-email/mcp-server/dist/index.js"`
Expected: File exists

**Step 3: Commit**

```bash
cd "/Users/marlinjai/software dev/clean-my-email"
echo "mcp-server/" >> .gitignore
git add .gitignore
git commit -m "chore: add .gitignore excluding mcp-server clone"
```

---

### Task 2: Register MCP server in Claude Code global settings

**Files:**
- Modify: `~/.claude/settings.json`

**Step 1: Add imap-mcp-server to global MCP config**

Add the following to `~/.claude/settings.json` under `mcpServers` (create the key if it doesn't exist):

```json
{
  "mcpServers": {
    "imap": {
      "command": "node",
      "args": ["/Users/marlinjai/software dev/clean-my-email/mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

**Step 2: Verify by restarting Claude Code and checking MCP tools are available**

Run: `/mcp` in Claude Code — should show the imap server and its tools.

---

### Task 3: Configure email accounts

**This is an interactive step — requires user input for credentials.**

**Step 1: Run the web setup wizard**

```bash
cd "/Users/marlinjai/software dev/clean-my-email/mcp-server"
npm run setup
```

This opens a browser UI. Add three accounts:
1. **Gmail**: Use app password (Google Account → Security → 2-Step Verification → App Passwords)
2. **iCloud Mail**: Use app-specific password (appleid.apple.com → Sign-In and Security → App-Specific Passwords)
3. **Outlook**: Use app password (Microsoft Account → Security → Advanced Security Options → App Passwords)

**Step 2: Verify accounts connected**

Use the MCP tool `imap_list_accounts` to verify all 3 accounts appear.

**Step 3: Verify folder access**

For each account, use `imap_list_folders` to confirm access and note the junk/spam folder names (e.g., `[Gmail]/Spam`, `Junk`, `Junk Email`).

---

### Task 4: Create the blocklist config

**Files:**
- Create: `config/blocklist.json`

**Step 1: Create initial blocklist**

```json
{
  "blocked_domains": [],
  "last_updated": null,
  "stats": {
    "total_deleted": 0,
    "total_rescued": 0,
    "total_sorted": 0
  }
}
```

**Step 2: Commit**

```bash
cd "/Users/marlinjai/software dev/clean-my-email"
git add config/blocklist.json
git commit -m "feat: add initial empty blocklist config"
```

---

### Task 5: Write the /clean-email skill

**Files:**
- Create: `.claude/commands/clean-email.md`

**Step 1: Write the skill file**

The skill is a Claude Code command file (markdown) that instructs Claude on the cleaning workflow. It should contain:

```markdown
---
name: clean-email
description: Clean junk mail across all email accounts — classify, rescue, sort, and block spam domains
---

# Clean My Email

You are an email triage assistant. Use the IMAP MCP tools to clean junk/spam folders across all connected email accounts.

## Setup

- **Blocklist location:** `config/blocklist.json` in this project directory (`/Users/marlinjai/software dev/clean-my-email/`)
- **MCP Server:** `imap` (nikolausm/imap-mcp-server with multi-account support)

## Workflow

### 1. Load blocklist

Read `config/blocklist.json` from the project directory. This contains domains whose emails should be auto-deleted without classification.

### 2. Connect to all accounts

Use `imap_list_accounts` to see available accounts. For each account, use `imap_connect` to ensure it's connected.

### 3. For each account, process junk/spam folder

Use `imap_list_folders` to find the junk/spam folder for the account. Common names:
- Gmail: `[Gmail]/Spam`
- iCloud: `Junk`
- Outlook: `Junk Email`

Use `imap_search_emails` on the junk/spam folder to get recent emails (last 7 days). If there are many, process in batches of 20.

### 4. Pre-filter: Auto-delete blocklisted domains

For each email, extract the sender's domain. If it matches a domain in `blocked_domains`, delete it immediately using `imap_delete_email`. Count these as "auto-deleted".

### 5. Classify remaining emails

For each remaining email, use `imap_get_email` to read its content. Classify it into one of:

- **JUNK**: Obvious spam, scams, phishing, unwanted marketing from unknown senders
  → Delete using `imap_delete_email`
  → Add sender domain to `blocked_domains` in blocklist

- **NOT JUNK**: Legitimate email that was incorrectly flagged as spam
  → Use `imap_send_email` to forward the email content to the user's own inbox address with subject prefix "[Rescued from Spam] "
  → Delete the original from spam using `imap_delete_email`
  → Print a summary: sender, subject, brief description of contents

- **PROMOTION/NEWSLETTER**: Legitimate promotional or newsletter content
  → Use `imap_list_folders` to find a matching promotions folder
  → If a matching folder exists and move is possible, describe what folder it belongs in
  → If no matching folder, leave it and note it in the report
  → Do NOT add to blocklist (these are opted-in)

### 6. Update blocklist

After processing all accounts:
- Update `config/blocklist.json` with any new blocked domains
- Update `last_updated` timestamp
- Update stats counters
- Write the file using the Write tool

### 7. Report results

Print a summary table:

```
## Email Cleaning Report

| Account | Auto-deleted | Junk deleted | Rescued | Promotions | New domains blocked |
|---------|-------------|-------------|---------|------------|-------------------|
| Gmail   | 12          | 5           | 1       | 3          | 4                 |
| iCloud  | 3           | 2           | 0       | 1          | 2                 |
| Outlook | 8           | 4           | 1       | 0          | 3                 |

### Rescued emails:
- **From:** sender@example.com — **Subject:** "Your invoice" — Looks like a legitimate invoice from a vendor
- **From:** news@service.com — **Subject:** "Account update" — Legitimate account notification

### Newly blocked domains:
spammer.com, junk-mail.net, fake-deals.org
```

## Classification Guidelines

When classifying, consider:
- **Sender reputation**: Known brands/services are likely not junk
- **Content quality**: Proper grammar, real content vs. generic spam
- **Personalization**: Emails addressing the user by name are less likely spam
- **Unsubscribe links**: Presence of legitimate unsubscribe = newsletter/promotion, not junk
- **Urgency/fear tactics**: "Act now!", "Your account is compromised!" = likely junk
- **When in doubt**: Err on the side of NOT JUNK — better to rescue than to lose a real email

## Important

- NEVER delete emails classified as NOT JUNK or PROMOTION
- ALWAYS err on the side of caution — if unsure, classify as NOT JUNK
- Keep the blocklist clean — only add domains that are clearly spam
- Process emails in batches to avoid overwhelming the IMAP server
```

**Step 2: Commit**

```bash
cd "/Users/marlinjai/software dev/clean-my-email"
git add .claude/commands/clean-email.md
git commit -m "feat: add /clean-email skill for email triage"
```

---

### Task 6: Create .gitignore and README

**Files:**
- Modify: `.gitignore`
- Create: `README.md`

**Step 1: Update .gitignore**

```
# MCP server clone (installed separately)
mcp-server/

# OS files
.DS_Store

# Node
node_modules/
```

**Step 2: Create minimal README**

```markdown
# Clean My Email

MCP-powered Claude Code skill for intelligent email junk mail triage.

## Setup

1. Clone and build the MCP server:
   ```bash
   git clone https://github.com/nikolausm/imap-mcp-server.git mcp-server
   cd mcp-server && npm install && npm run build
   ```

2. Add to Claude Code global settings (`~/.claude/settings.json`):
   ```json
   {
     "mcpServers": {
       "imap": {
         "command": "node",
         "args": ["<path-to>/mcp-server/dist/index.js"]
       }
     }
   }
   ```

3. Configure email accounts: `cd mcp-server && npm run setup`

4. Use in Claude Code: `/clean-email`

## Features

- Multi-account support (Gmail, iCloud, Outlook)
- AI-powered junk classification
- Auto-blocking of spam domains (learns over time)
- Rescues non-junk with summaries
- Sorts promotions/newsletters to matching folders
```

**Step 3: Commit**

```bash
cd "/Users/marlinjai/software dev/clean-my-email"
git add .gitignore README.md
git commit -m "chore: add .gitignore and README"
```

---

### Task 7: End-to-end test

**This task requires all previous tasks complete and user credentials configured.**

**Step 1: Restart Claude Code** to pick up the new MCP server config.

**Step 2: Navigate to the project directory**

```bash
cd "/Users/marlinjai/software dev/clean-my-email"
```

**Step 3: Run `/clean-email`** and verify:
- [ ] MCP server connects to all 3 accounts
- [ ] Junk/spam folders are found for each account
- [ ] Emails are fetched and classified
- [ ] Blocklist is updated after run
- [ ] Report is printed with correct counts

**Step 4: Run a second time** to verify:
- [ ] Previously blocked domains are auto-deleted
- [ ] Stats accumulate correctly
