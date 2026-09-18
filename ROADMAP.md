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
- [ ] Release the credential hardening from pull request #15 to npm as 1.8.0. The release
      pull request (branch `release/1.8.0`) bumps the version, turns the changelog into the
      1.8.0 section and updates `site/privacy.html` and the README to the 1.8.0 behavior
      (encrypted `msal-cache.enc`, Google revocation on account removal, loopback-only sign-in
      listener, owner-only attachments). Remaining: merge it (this deploys the site), push the
      tag `v1.8.0` (this publishes to npm through `.github/workflows/publish.yml`), confirm
      `npm view @marlinjai/email-mcp version` prints 1.8.0, then do one real Gmail sign-in, one
      real Outlook sign-in and one remove-and-re-add on 1.8.0, since none of this has run
      against a real provider yet (2026-09-18)
- [x] Marlin sent both Gmail replies ("Re: Anfrage zum Email MCP", "Re: email-mcp OAuth access")
      on 2026-09-06; the line saying they sat unsent was stale (2026-09-18)
- [ ] Marlin: complete one real Outlook re-auth on the current package (the `marlinjp@hotmail.de`
      account, currently `connected: false`) to confirm the OAuth `state` parameter added in
      v1.7.1 is echoed back correctly by Microsoft's consumer authority; only unit-tested against
      a mocked MSAL (Microsoft Authentication Library) client so far (2026-09-10)
- [ ] Marlin: open the scroll-driven demo at https://email.lumitra.co/demo/ on a real iPhone once
      and check touch scrolling through the pinned acts, the top tab strip, the tool rail and the
      copy buttons; only verified in headless Chrome so far (2026-09-10)
