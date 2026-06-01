# @seanpropapp/cli

Run [SeanPropApp](https://prop.seanoneill.com) proposition analyses on your
existing Claude Pro or ChatGPT Plus subscription. No API key, no extra cost.

## Quick start

```sh
npx @seanpropapp/cli connect
```

That's it. Click the link that appears, confirm the device, and your
SeanPropApp workspace is now powered by your AI subscription.

Time to hello world: about 3 minutes (Champion tier coming in v1.5).

## What this is

A small open-source CLI that runs locally on your computer and lets the
SeanPropApp browser app send requests to your Claude or ChatGPT subscription
without an API key. Your tokens stay between your computer and your AI
provider.

## What you need

- Node 18 or later (run `node --version` to check).
- A Claude Pro subscription OR a ChatGPT Plus subscription.
- The Claude CLI or Codex CLI installed (we will guide you through it).

## Commands

| Command     | What it does                                              |
|-------------|-----------------------------------------------------------|
| `connect`   | Start everything and pair with your browser (use this first). |
| `bridge`    | Run the bridge server explicitly.                         |
| `pair`      | Generate a new pair URL.                                  |
| `mcp`       | Run as an MCP stdio server (Claude Desktop, Cursor).      |
| `doctor`    | Self-diagnostic.                                          |
| `autostart` | Install OS-native auto-start.                             |

Global flags: `--config <path>`, `--quiet`, `--json`, `--verbose`.

## How it works

The CLI runs a small HTTP server on `127.0.0.1` (default port `17492`). The
SeanPropApp browser workspace sends LLM requests to that local URL, attaching a
Bearer pair token that lives only on your machine. The CLI in turn shells out
to your installed Claude CLI or Codex CLI, which runs against your subscription.

Architecture documentation: see the `ENG_PLAN_v140.md` in the
`seanpropapp/proposition-app` repo (link to be added with v1.4.0 release).

## Trust signals

- Source code: 100% visible in this repository.
- License: MIT.
- npm provenance: every release will be attested (set up in Lane C-Polish).
- Telemetry: opt-in only; see `TELEMETRY.md` (added in Lane C-Polish).
- Security disclosures: security@seanoneill.com.
- Files in the npm package: see `npm pack --dry-run`.

## Status

This is `0.1.0-alpha.1`, the foundational half of the v1.4.0 release. The
`connect`, `bridge`, and `pair` commands are live. `mcp`, `doctor`, and
`autostart` will land in the Lane C-Polish follow-up alongside CI, npm
provenance, and the per-OS autostart docs.

## Contributing

Issues and pull requests welcome at
[github.com/seanpropapp/cli](https://github.com/seanpropapp/cli).

## License

MIT. See [LICENSE](./LICENSE).
