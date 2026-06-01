# Security policy

## Reporting a vulnerability

Email **security@seanoneill.com** with:

- A description of the issue.
- The CLI version (`seanpropapp --version`).
- The OS + Node version.
- Repro steps or proof-of-concept code, where relevant.

Please do **not** open a public GitHub issue for security reports. If the vulnerability is in a transitive dependency we already track via Dependabot, you can open a public issue; everything else goes via email.

## Response SLA

- **Acknowledgement: within 7 days** of receiving your report.
- **Triage decision and remediation intent: within 30 days** of acknowledgement.

If a fix requires changes in the upstream proposition-app service or in a downstream provider (Claude CLI, Codex CLI), the 30-day clock starts when this CLI's part of the fix is ready to ship.

## Scope

In scope:

- Bridge HTTP server (auth, CORS, token handling, response classification).
- Token storage in `~/.seanpropapp/config.json` and any path that emits the token to logs/stdout.
- MCP stdio server (token resolution, request forwarding).
- Local privilege escalation via `autostart install` (LaunchAgent / systemd unit / Task Scheduler entry).
- Anything that lets a remote site read or write a local user's bridge token, bypass CORS, or hit a non-allowlisted origin.

Out of scope:

- Third-party dependency advisories that we already get via Dependabot. We bump on the normal release cadence; if you want a faster bump, open a PR.
- Issues that require a malicious local user with shell access (the threat model assumes the local user is trusted).
- Self-XSS or social-engineering of the user into pasting the pair token somewhere public.

## Disclosure

We coordinate disclosure with you. Default plan: we ship the fix, you publish your write-up, we link it from the release notes. We will not name you in the release notes without your written consent.
