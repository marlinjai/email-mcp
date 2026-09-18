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
- [ ] Encrypt the Outlook token cache `~/.email-mcp/msal-cache.json` (it holds the Outlook refresh
      token as plain JSON with owner-only file permissions, while credentials.enc is AES-256-GCM),
      e.g. by routing the MSAL cache plugin through the same encryption as the credential store;
      the privacy policy currently discloses it as unencrypted and needs updating once done (2026-09-18)
- [ ] `email_remove_account` only deletes the local credential: make it also revoke the grant
      (Google's token revocation endpoint) and drop the account from the MSAL cache, then update
      the privacy policy's "Revoking access" section, which currently says it does not (2026-09-18)
- [ ] The OAuth callback listener (`OAuthCallbackServer.start`, src/auth/oauth-server.ts) calls
      `listen(0)` with no host, so it binds all network interfaces during sign-in; bind it to the
      loopback interface only (check `localhost` resolving to ::1 vs 127.0.0.1) (2026-09-18)
- [ ] Marlin: read the two Gmail Drafts replies (subjects "Re: Anfrage zum Email MCP" and "Re:
      email-mcp OAuth access") and send them; they have sat unsent since 2026-09-06 (2026-09-10)
- [ ] Marlin: complete one real Outlook re-auth on the current package (the `marlinjp@hotmail.de`
      account, currently `connected: false`) to confirm the OAuth `state` parameter added in
      v1.7.1 is echoed back correctly by Microsoft's consumer authority; only unit-tested against
      a mocked MSAL (Microsoft Authentication Library) client so far (2026-09-10)
- [ ] Marlin: open the scroll-driven demo at https://email.lumitra.co/demo/ on a real iPhone once
      and check touch scrolling through the pinned acts, the top tab strip, the tool rail and the
      copy buttons; only verified in headless Chrome so far (2026-09-10)
