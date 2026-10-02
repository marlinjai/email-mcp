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
- [ ] Outgoing attachments: the five MCP tools (`email_send`, `email_draft_create`,
      `email_draft_update`, `email_reply`, and `email_forward`) expose no `attachments` input, so an
      invoice PDF cannot be sent or drafted through the MCP (hit 2026-09-25 drafting Scheunerei
      Rechnung Nr. 59, fell back to the `gws` CLI). Provider support: Gmail (send and drafts),
      IMAP and iCloud drafts, IMAP/SMTP `email_send` and Outlook `email_send` already consume
      `SendEmailParams.attachments` (the shared MIME builder in `src/providers/mime.ts` since
      2026-09-27); only the Outlook draft paths still discard them. Expose an `attachments` input
      (local path or base64 plus filename and MIME type), complete the Outlook draft path, add a
      size cap, and run a live test per provider (2026-09-27)
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
      Restricted mode does not avoid it. Next steps, in order: (1) Marlin sends the reply
      drafted in Gmail on 2026-10-01, which describes the local-only data flow and asks whether
      the assessment applies, since Google's documentation requires it for an app that "has the
      ability to access data from or through a third-party server"; (2) if Google says it
      applies, or has not answered by 2026-11-02, start AL1 with TAC Security (it takes 2 to 6
      weeks, and a deadline extension is requested from the lab, not from Google). Funding, decided by
      Marlin on 2026-10-01 and 2026-10-02: donations are collected toward the 675 US dollars
      until 2026-11-02 (GitHub Sponsors and Buy Me a Coffee), Marlin pays what is missing on
      that day as a Lumitra business expense, and the renewal is decided again in a year; no
      paid tier, because gating the shared client needs a server this project does not have.
      The homepage shows a funding bar rendered by `scripts/funding.mjs` in the site deploy
      workflow (every deploy and daily). It shows the goal without an amount until Marlin adds
      two repository secrets: `GH_SPONSORS_TOKEN` (classic personal access token of his
      account, scope `read:user`) and `BMC_TOKEN` (read-only token from the Buy Me a Coffee
      developer dashboard). The Buy Me a Coffee response fields are taken from its public
      client libraries, so the first run with `BMC_TOKEN` is the real test: a mismatch turns
      the deploy run red and the bar keeps the last amount. The setup wizard's donation line
      ships with the next npm release. No grant application, decided by Marlin on 2026-10-01 after a fit
      assessment (`~/software-dev/decision-pages/2026-10-01-email-mcp-grant-fit.html`): NLnet's
      open fund, Restack, states "AI-related projects are not within scope", and the Prototype
      Fund pays for six months of near full-time work from 2027-06-01 at about a 9 percent
      acceptance rate; neither is confirmed to cover this recurring audit fee. The site
      documents the status at https://email.lumitra.co/privacy#google-verification. When Google
      approves: close GitHub issue #1 ("unverified app"), update that site section, and
      re-enable the lumitra.co zone protections (knowledge-base ROADMAP, infra line)
      (2026-10-01)
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
