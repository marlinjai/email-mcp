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
- [ ] Release the credential hardening from pull request #15 to npm and update
      `site/privacy.html` in the same step, so the published policy never describes behavior the
      published package lacks. Sentences to change: the Outlook cache is now encrypted and named
      `msal-cache.enc`; account removal now revokes the Google grant and clears the Outlook
      cache (Microsoft consumer grants still need account.live.com/consent/Manage); saved
      attachments are now owner-only; optionally, the sign-in listener is loopback-only. Then do
      one real sign-in with Gmail and with Outlook and one remove-and-re-add on the released
      version, since none of this has run against a real provider yet (2026-09-18)
- [x] Marlin sent both Gmail replies ("Re: Anfrage zum Email MCP", "Re: email-mcp OAuth access")
      on 2026-09-06; the line saying they sat unsent was stale (2026-09-18)
- [ ] Marlin: complete one real Outlook re-auth on the current package (the `marlinjp@hotmail.de`
      account, currently `connected: false`) to confirm the OAuth `state` parameter added in
      v1.7.1 is echoed back correctly by Microsoft's consumer authority; only unit-tested against
      a mocked MSAL (Microsoft Authentication Library) client so far (2026-09-10)
- [ ] Marlin: open the scroll-driven demo at https://email.lumitra.co/demo/ on a real iPhone once
      and check touch scrolling through the pinned acts, the top tab strip, the tool rail and the
      copy buttons; only verified in headless Chrome so far (2026-09-10)
