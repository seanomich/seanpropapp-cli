# Changelog

All notable changes to this CLI are recorded here. The format is loosely Keep a Changelog; we add structure once the release cadence demands it.

## 0.1.0-beta.3

### Fixed

- **Chat from prop.seanoneill.com to the local bridge silently failed in Chrome 130+ with `TypeError: Failed to fetch`.** Chrome enforces Private Network Access (PNA) on requests from public-origin pages to private network addresses (127.0.0.1). The bridge's CORS preflight (`OPTIONS /v1/messages`) now sends `Access-Control-Allow-Private-Network: true` to opt in, unblocking POST `/v1/messages` from the browser. Without this header, fresh preflights (no cached entry) fail at the browser layer with no console signal beyond the generic TypeError. Cached preflights from earlier sessions (24h `Max-Age`) would continue to work, which masked the bug during local testing where the bridge always bound the same port across reconnects. The fix is unconditional — Safari and Firefox currently ignore the header, so there is no compatibility downside.

  Symptom catch: when the browser's bridge port-walk shows orphan bridges responding (401 token mismatch) but the live bridge returning `Failed to fetch`, that delta is PNA. The orphans worked off cached preflight; the new bridge didn't have one. Issue: https://github.com/seanomich/proposition-app discovered during v1.4.0 user testing 2026-06-02.

## 0.1.0-beta.2

### Fixed

- `dist/index.js` now has the executable bit set (was `-rw-r--r--` in beta.1, causing `npx @seanpropapp/cli` to fail with `command not found`). Build script appends `chmod +x dist/index.js` after `tsc`.
- `src/version.ts` constant bumped to match `package.json`.

## 0.1.0-beta.1

First public-feedback build. Everything below shipped in the Lane C-Polish pass on top of the Lane C-Core foundation.

### Added

- `mcp` command: stdio MCP server mirroring the existing `@seanpropapp/mcp` surface. One `run_module` tool + one prompt per methodology module. Routes assemble calls to `/api/mcp/assemble-prompt` with the bearer token.
- `doctor` command: sectioned self-diagnostic. Detects providers, probes ports 17492-17500, reports token PRESENCE (never the value), pings the bridge `/v1/handshake`, and emits a JSON envelope when `--json` is set.
- `autostart install|uninstall` command: macOS LaunchAgent, Linux systemd `--user` unit, Windows schtasks instructions. Per-OS guides in `docs/`.
- `telemetry enable|disable|status` command and the opt-in TX7 events (`cli_connect_start`, `cli_pair_complete`, `cli_first_analysis_complete`). Default is OFF. Network failures are swallowed silently.
- `--no-telemetry` global flag.
- SIGHUP handler on the foreground bridge: reloads the pair token from config without restarting the listener so `pair` can rotate without downtime.
- Post-spawn health check on `spawnBackgroundBridge`: polls `/v1/handshake` for up to 3s and throws with a clear error if the bridge never becomes reachable.
- GitHub Actions workflows: CI (lint + test + build + audit on push/PR, matrix on node 20 + 22) and Publish (`npm publish --provenance --access public` on tag push). All actions SHA-pinned per D9.
- `SECURITY.md`, `TELEMETRY.md`, `CONTRIBUTING.md` and a polished README with accurate trust signals.

### Changed

- Bumped vitest from ^2.0.0 to ^4.0.0; npm audit now reports 0 high/critical advisories.
- `makeAuthMiddleware` and `startServer` accept either a token string or a getter function; the getter form is what enables SIGHUP rotation.
- `package.json` adds `publishConfig.access=public` and `publishConfig.provenance=true`.

### Caveats / known issues

- Windows auto-start install is not fully automated; the command prints the exact `schtasks` line the user must run. Full XML import is a v1.4.1 follow-up.
- The MCP server is a feature-parity stub; full migration of the `@seanpropapp/mcp` package (streaming, multi-region routing, local caching) is the v1.4.0 deliverable tracked in proposition-app#341.
- Telemetry events post to `/api/telemetry` but the workspace-side TTHW dashboard (TX8) ships with v1.4.0 of the proposition-app workspace.

## 0.1.0-alpha.1

Lane C-Core scaffold. Internal-only build.

### Added

- Bridge HTTP server (Hono + @hono/node-server), Anthropic + OpenAI compat endpoints.
- Claude CLI + Codex CLI providers.
- `connect`, `bridge`, `pair` commands.
- Token-bound CORS + Bearer auth.
- Port fallback 17492-17500.
- README + LICENSE.
