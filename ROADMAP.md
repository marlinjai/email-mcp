# Roadmap

**This file is the only index of open work in this repo.** Every open item has exactly one home:
a plan under `docs/plans/` when it carries a decision or a sequence (the line here links it), or a
single line under Leftovers when it does not. Every open line ends with the date it was last
confirmed; `roadmap-check` in CI (`npm run check:roadmap` locally) fails a line older than 30 days,
an open line on a finished plan, or a live plan indexed nowhere. Rule and grammar: knowledge-base
`standards/document-lifecycle.md`, section 4.

## Leftovers (clear, do not carry)

- [ ] Google OAuth (Open Authorization) brand verification for the Gmail integration is submitted;
      the data-access review for the restricted `gmail.modify` and `gmail.settings.basic` scopes
      is blocked. On 2026-09-18 Google named two blockers: (1) the privacy policy did not describe
      data protection mechanisms for sensitive data, addressed by the "How sensitive data is
      protected" section on site/privacy.html (PR fix/demo-mobile-and-privacy-2026-09-18); (2) the
      demo video must show the OAuth consent screen and the app's features, which needs Marlin to
      re-record it. After both, Marlin replies on the Google Trust and Safety email thread.
      GitHub issue #1 tracks the "unverified app" blocker this closes (2026-09-18)
- [x] Credential hardening, pull request #15: the Outlook token cache is now encrypted
      (`msal-cache.enc`, same AES-256-GCM scheme and key as credentials.enc, plaintext caches
      migrated without signing anyone out); `email_remove_account` revokes the Google grant and
      clears the Outlook cache entry, reporting what it could not do; the OAuth callback
      listener binds only the loopback addresses; saved attachments are owner-only (2026-09-18)
- [ ] Verify 1.8.0 against the real providers. Released 2026-09-18: pull request #16 merged
      (site with the updated privacy policy deployed), tag `v1.8.0` published to npm with a
      provenance statement, registry `latest` is 1.8.0. Remaining: after Claude Code restarts
      the server on 1.8.0, confirm `~/.email-mcp/msal-cache.json` became `msal-cache.enc` and
      Outlook still works (the migration), then one real Gmail sign-in and one remove-and-re-add
      (checks the loopback-only listener and the Google revocation), since none of the 1.8.0
      changes has run against a real provider yet (2026-09-18)
- [x] Marlin sent both Gmail replies ("Re: Anfrage zum Email MCP", "Re: email-mcp OAuth access")
      on 2026-09-06; the line saying they sat unsent was stale (2026-09-18)
- [x] Real Outlook re-auth on 1.7.2 done by Marlin on 2026-09-18 (`marlinjp@hotmail.de`):
      Microsoft's consumer authority echoed the OAuth `state` value back on the loopback
      redirect, the wizard accepted it and updated the existing "hotmail" account in place, and
      Claude Code then listed all 10 folders through the reconnected server (2026-09-18)
- [ ] Marlin: open the scroll-driven demo at https://email.lumitra.co/demo/ on a real iPhone once
      and check touch scrolling through the pinned acts, the top tab strip, the tool rail and the
      copy buttons; only verified in headless Chrome so far (2026-09-10)
