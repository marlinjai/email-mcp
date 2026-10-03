# Roadmap

**This file is the only index of open work in this repo.** Every open item has exactly one home:
a plan under `docs/plans/` when it carries a decision or a sequence (the line here links it), or a
single line under Leftovers when it does not. Every open line ends with the date it was last
confirmed; `roadmap-check` in CI (`npm run check:roadmap` locally) fails a line older than 30 days,
an open line on a finished plan, or a live plan indexed nowhere. Rule and grammar: knowledge-base
`standards/document-lifecycle.md`, section 4.

## Leftovers (clear, do not carry)

- [x] 1.8.1 released on 2026-09-27 (MIME fix from #27, the shared MIME builder that keeps HTML
      bodies intact): tag v1.8.1 published through the npm workflow, npm latest is 1.8.1, and a
      real draft created through the 1.8.1 server in Gmail opened in the rich editor with the
      bold word and the link intact (no "Plain text mode"); the test draft was discarded (2026-09-27)
- [ ] Forwarding rules ([plan](docs/plans/2026-10-02-forward-rules.md)): the three tools
      (`email_create_forward_rule`, `email_list_forward_rules`, `email_delete_forward_rule`)
      and the `EMAIL_MCP_FORWARD_ALLOWLIST` guard are built and tested against mocks, and
      released: npm latest is 1.9.0 since 2026-10-02 (tag v1.9.0, GitHub release). Both
      prerequisites for Marlin's first real use are in place since 2026-10-02:
      expenses@marlinjai.com is a confirmed forwarding address of the configured Gmail account
      (whole-mailbox forwarding stays disabled), and `EMAIL_MCP_FORWARD_ALLOWLIST` is set in the
      Infisical Dotfiles project (env dev, path /), which the `cc.sh` launcher injects into
      Claude Code, so the email server inherits it after a restart. Open: the live check on a
      real Gmail and a real Outlook account (create, list, see the rule in the provider's
      settings, delete); the first Gmail run is the Anthropic invoice rule. Google was told
      about the new use of `gmail.settings.basic` in the reply Marlin sent on the
      verification thread on 2026-10-03 (2026-10-03)
- [ ] Outgoing attachments (pull request #20 by @jonboy648, reworked onto main): the five
      sending tools take an `attachments` input (a file from the folder named in
      `EMAIL_MCP_ATTACHMENTS_DIR`, off when unset, or base64 content with a filename), capped at
      25 MB, and the Outlook draft paths carry attachments. Decided by Marlin on 2026-10-03: files
      only from that one folder, because a path chosen by the assistant could otherwise mail out
      any local file. Open: a live test per provider (Gmail, Outlook, iCloud or IMAP: send and
      draft with a PDF), and Marlin sets `EMAIL_MCP_ATTACHMENTS_DIR` for his own use (Infisical
      Dotfiles project, like the forwarding allowlist). Also open: on Gmail and IMAP
      `email_draft_update` rewrites the whole message, so a draft's existing files are dropped
      unless they are passed again (Outlook keeps them); the tool description says so, the fix
      is to carry them over. Outlook is limited to 3 MB per message
      with a clear error; upload sessions for larger files are not built, by decision of
      2026-10-03. Built on top (pull request #21 by @jonboy648): threaded replies, reply drafts
      and opt-in forwarding of the original attachments; the live test per provider also
      covers a threaded reply and a reply draft (2026-10-03)
- [ ] Google OAuth (Open Authorization) verification for the Gmail integration: one gate
      left, the security assessment. Marlin's reply of 2026-09-27 (new demo video
      https://youtu.be/L7g0q9khjA0, privacy policy section on how sensitive data is protected)
      was sent and accepted. On 2026-09-30 Google answered that the app must complete a CASA
      (Cloud Application Security Assessment) at Assurance Level 1 (AL1, formerly Tier 2) with
      a lab authorized by the App Defense Alliance (ADA) by **2026-12-29**, repeated every 12
      months. Google charges nothing, the lab does: 675 US dollars per application at TAC
      Security, Google's preferred lab (Basic plan, two revalidation cycles; 855 with
      unlimited revalidation; read off casa.tacsecurity.com on 2026-10-01, older write-ups say
      540). No precedent for a waiver was found: Mimestream, a desktop Gmail client without a
      server, and Thunderbird for Android both went through CASA. Known risk: Google's API terms, section 4b, say
      "Developer credentials may not be embedded in open source projects", and the shared
      client ships in this package; Google's reviewers have had the repository link throughout
      and have not raised it. All three scopes are on the restricted list, so the wizard's
      Restricted mode does not avoid it. Marlin's reply of 2026-10-03 on the
      verification thread describes the local-only data flow and asks whether the assessment
      applies, since Google's documentation requires it for an app that "has the ability to
      access data from or through a third-party server"; it also asks whether any programme
      covers the lab fee for open source projects. Waiting on Google's answer. Next step: if
      Google says it applies, or has not answered by 2026-11-02, start AL1 with TAC Security (it takes 2 to 6
      weeks, and a deadline extension is requested from the lab, not from Google). Funding, decided by
      Marlin on 2026-10-01 and 2026-10-02: donations are collected toward the 675 US dollars
      until 2026-11-02 (GitHub Sponsors and Buy Me a Coffee), Marlin pays what is missing on
      that day as a Lumitra business expense, and the renewal is decided again in a year; no
      paid tier, because gating the shared client needs a server this project does not have.
      The homepage shows a funding bar rendered by `scripts/funding.mjs` in the site deploy
      workflow (every deploy and daily). The bar is live and connected to both
      platforms since 2026-10-03 (first reading: 0 of 675 US dollars, 0 supporters). It reads
      two repository secrets: `GH_SPONSORS_TOKEN` (classic personal access token of Marlin's
      account, scope `read:user`) and `BMC_TOKEN` (read-only token "email mcp" from the Buy Me
      a Coffee developer dashboard). Their home is the Infisical Dotfiles project (env dev,
      path `/email-mcp`); the repository secrets are copies, so a rotated token is changed in
      Infisical first and copied to the repository secret again. Both tokens were checked
      against the real services: GitHub answers as marlinjai, Buy Me a Coffee answers
      `{"error":"No supporters"}` and `{"error":"No subscriptions"}` with HTTP 200, the empty
      case the script handles. The Buy Me a Coffee supporter fields match what the open source
      client mayeu20/buymeacoffee-mcp observed live in September 2026; the membership fields
      are documented but unobserved (neither account had members), so the first membership is
      the real test: a mismatch turns the deploy run red and the bar keeps the last amount.
      If the developer dashboard answers "400 Request Header Or Cookie Too Large", delete the
      analytics cookies for buymeacoffee.com in that browser. Donations in euros are converted
      with a fixed rate in `scripts/funding.mjs` (1.1298 US dollars per euro, 2026-10-01); it
      matters only once a euro donation arrives, and setting the Buy Me a Coffee account to
      US dollars removes the conversion.
      The setup wizard's donation line
      is in the package since 1.9.0. No grant application, decided by Marlin on 2026-10-01 after a fit
      assessment (`~/software-dev/decision-pages/2026-10-01-email-mcp-grant-fit.html`): NLnet's
      open fund, Restack, states "AI-related projects are not within scope", and the Prototype
      Fund pays for six months of near full-time work from 2027-06-01 at about a 9 percent
      acceptance rate; neither is confirmed to cover this recurring audit fee. The site
      documents the status at https://email.lumitra.co/privacy#google-verification. When Google
      approves: close GitHub issue #1 ("unverified app"), update that site section,
      re-enable the lumitra.co zone protections (knowledge-base ROADMAP, infra line), and take
      up pull request #22 by @jonboy648 (`email-mcp-fetch`, a command-line tool that reads mail
      for scripts without an assistant). It is parked with the `hold` label by Marlin's decision
      of 2026-10-03, because unattended use is not what Google reviewed and four sentences of
      the privacy policy would become untrue. To take it: rebase its top commit alone onto
      main, no overwriting on download and default to the downloads folder, strict argument
      parsing, the Gmail default folder, disconnect on every exit path, an offset or cursor,
      tests, and a privacy policy section on script-driven use. Declined on the same day: #23
      (`email-mcp-digest`), a personal workflow that belongs in its own package; that would
      need email-mcp to be usable as a library, which is an idea, not a commitment
      (2026-10-03)
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
