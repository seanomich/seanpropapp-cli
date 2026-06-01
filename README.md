# @seanpropapp/cli

Run [SeanPropApp](https://prop.seanoneill.com) proposition analyses on your existing Claude Pro or ChatGPT Plus subscription. No API key, no extra cost.

## Quick start

```sh
npx @seanpropapp/cli connect
```

That's it. Click the link that appears, confirm the device in your browser, and your SeanPropApp workspace is now powered by your AI subscription.

Time to hello world: about 3 minutes on a fresh machine (Claude CLI install included). Reconnects on a paired machine take a couple of seconds.

## What this is

A small open-source CLI that runs locally on your computer and lets the SeanPropApp browser app send LLM requests to your Claude or ChatGPT subscription without an API key. Your prompts and your provider responses stay between your computer and your AI provider; this repo only ships the bridge code.

## What you need

- Node 18 or later (run `node --version`).
- A Claude Pro subscription OR a ChatGPT Plus subscription.
- The Claude CLI or Codex CLI installed. `connect` will guide you through this on first run.

## Commands

| Command             | What it does                                                |
|---------------------|-------------------------------------------------------------|
| `connect`           | Start everything and pair with your browser. Use this first.|
| `bridge`            | Run the bridge server explicitly.                           |
| `pair`              | Generate a new pair URL.                                    |
| `mcp`               | Run as an MCP stdio server (Claude Desktop, Cursor).        |
| `doctor`            | Self-diagnostic with actionable suggestions.                |
| `autostart install` | Install an OS-native supervisor so the bridge starts at login. See [docs/autostart-macos.md](./docs/autostart-macos.md), [docs/autostart-linux.md](./docs/autostart-linux.md), [docs/autostart-windows.md](./docs/autostart-windows.md). |
| `telemetry`         | `enable`, `disable`, or `status`. Default is off.           |

Global flags: `--config <path>`, `--quiet`, `--json`, `--verbose`, `--no-telemetry`.

## How it works

The CLI runs a small HTTP server on `127.0.0.1` (default port `17492`, falling back through `17500`). The SeanPropApp browser workspace sends LLM requests to that local URL, attaching a Bearer pair token that lives only on your machine. The CLI in turn shells out to your installed Claude CLI or Codex CLI, which runs against your subscription.

The bridge accepts requests only from `https://prop.seanoneill.com` (and `http://localhost:3000` for development); every other Origin is rejected with 403.

## Trust signals

- **Source code:** 100% in this repository. Review the bridge HTTP server, providers, and command code before installing.
- **License:** MIT.
- **npm provenance:** every release is published with `--provenance` (see [.github/workflows/publish.yml](./.github/workflows/publish.yml)).
- **Telemetry:** opt-in only. See [TELEMETRY.md](./TELEMETRY.md).
- **Security disclosure:** [SECURITY.md](./SECURITY.md) (mailto: security@seanoneill.com).
- **Files in the npm package:** run `npm pack --dry-run` to see exactly what we ship. Currently `dist/`, `README.md`, `LICENSE`.

## Status

v0.1.0-beta.1. The connect/bridge/pair/mcp/doctor/autostart/telemetry commands are live. CI + npm-provenance publish are set up. The workspace-side TTHW dashboard (TX8) ships with v1.4.0 of the proposition-app workspace; until then, telemetry events land but are not visualized in-app.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and pull requests welcome at [github.com/seanpropapp/cli](https://github.com/seanpropapp/cli).

## License

MIT. See [LICENSE](./LICENSE).
