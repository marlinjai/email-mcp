# Roadmap

**This file is the only index of open work in this repo.** Every open item has exactly one home:
a plan under `docs/plans/` when it carries a decision or a sequence (the line here links it), or a
single line under Leftovers when it does not. Every open line ends with the date it was last
confirmed; `roadmap-check` in CI (`npm run check:roadmap` locally) fails a line older than 30 days,
an open line on a finished plan, or a live plan indexed nowhere. Rule and grammar: knowledge-base
`standards/document-lifecycle.md`, section 4.

## Leftovers (clear, do not carry)

- [ ] Google OAuth (Open Authorization) brand verification for the Gmail integration is submitted
      and pending Google's review; the data-access review for the restricted `gmail.modify` and
      `gmail.settings.basic` scopes is under way. GitHub issue #1 tracks the "unverified app"
      blocker this closes. Nobody but Google can move this forward; re-check the Verification
      Centre and update this line when it resolves (2026-09-10)
- [ ] Marlin: read the two Gmail Drafts replies (subjects "Re: Anfrage zum Email MCP" and "Re:
      email-mcp OAuth access") and send them; they have sat unsent since 2026-09-06 (2026-09-10)
- [ ] Marlin: complete one real Outlook re-auth on the current package (the `marlinjp@hotmail.de`
      account, currently `connected: false`) to confirm the OAuth `state` parameter added in
      v1.7.1 is echoed back correctly by Microsoft's consumer authority; only unit-tested against
      a mocked MSAL (Microsoft Authentication Library) client so far (2026-09-10)
- [ ] Marlin: open the scroll-driven demo at https://email.lumitra.co/demo/ on a real iPhone once
      and check touch scrolling through the pinned acts, the top tab strip, the tool rail and the
      copy buttons; only verified in headless Chrome so far (2026-09-10)
