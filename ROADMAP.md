# Roadmap

**This file is the only index of open work in this repo.** Every open item has exactly one home:
a plan under `docs/plans/` when it carries a decision or a sequence (the line here links it), or a
single line under Leftovers when it does not. Every open line ends with the date it was last
confirmed; `roadmap-check` in CI (`npm run check:roadmap` locally) fails a line older than 30 days,
an open line on a finished plan, or a live plan indexed nowhere. Rule and grammar: knowledge-base
`standards/document-lifecycle.md`, section 4.

## Leftovers (clear, do not carry)

- [ ] Outgoing attachments: the five MCP tools (`email_send`, `email_draft_create`,
      `email_draft_update`, `email_reply`, and `email_forward`) expose no `attachments` input, so an
      invoice PDF cannot be sent or drafted through the MCP (hit 2026-09-25 drafting Scheunerei
      Rechnung Nr. 59, fell back to the `gws` CLI). Provider support is partial: Outlook and
      IMAP/SMTP `email_send` already consume `SendEmailParams.attachments`, while Gmail MIME
      construction and all draft paths discard them. Expose an `attachments` input (local path or
      base64 plus filename and MIME type), complete the Gmail and draft-provider paths, add a size
      cap, and run a live test per provider (2026-09-25)
- [ ] Google OAuth (Open Authorization) verification for the Gmail integration: waiting on
      Google. Both blockers Google named on 2026-09-07 are fixed: the privacy policy's "How
      sensitive data is protected" section (live since 2026-09-18), and a new demo video
      recorded 2026-09-27 (https://youtu.be/L7g0q9khjA0, unlisted) covering the consent screen
      with all three scopes, permanent delete shown in Gmail's Bin, and the block rule shown in
      Gmail's filters. The video link is saved in the Cloud Console's Data access section, and
      the new edge-to-edge app logo is in the pending branding. Google's status on 2026-09-27:
      "received your form", review up to 4 to 6 weeks, first email within 3 to 5 days. A reply
      on the Trust and Safety thread sits in Marlin's Gmail Drafts for him to send. When Google
      approves: close GitHub issue #1 ("unverified app") and re-enable the lumitra.co zone
      protections (knowledge-base ROADMAP, infra line) (2026-09-27)
- [x] Credential hardening, pull request #15: the Outlook token cache is now encrypted
      (`msal-cache.enc`, same AES-256-GCM scheme and key as credentials.enc, plaintext caches
      migrated without signing anyone out); `email_remove_account` revokes the Google grant and
      clears the Outlook cache entry, reporting what it could not do; the OAuth callback
      listener binds only the loopback addresses; saved attachments are owner-only (2026-09-18)
- [x] 1.8.0 verified against the real providers on 2026-09-27: the first Outlook call under
      1.8.0 turned `msal-cache.json` into the encrypted `msal-cache.enc` (owner-only) and Outlook
      kept working; `email_remove_account` on the Gmail account returned "Google revoked the
      grant"; the Gmail re-add through the setup wizard (recorded in the verification video)
      went through the loopback-only listener and connected (2026-09-27)
- [x] Marlin sent both Gmail replies ("Re: Anfrage zum Email MCP", "Re: email-mcp OAuth access")
      on 2026-09-06; the line saying they sat unsent was stale (2026-09-18)
- [x] Real Outlook re-auth on 1.7.2 done by Marlin on 2026-09-18 (`marlinjp@hotmail.de`):
      Microsoft's consumer authority echoed the OAuth `state` value back on the loopback
      redirect, the wizard accepted it and updated the existing "hotmail" account in place, and
      Claude Code then listed all 10 folders through the reconnected server (2026-09-18)
- [ ] Marlin: open the scroll-driven demo at https://email.lumitra.co/demo/ on a real iPhone once
      and check touch scrolling through the pinned acts, the top tab strip, the tool rail and the
      copy buttons; only verified in headless Chrome so far (2026-09-10)
