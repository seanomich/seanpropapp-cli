# Telemetry

**Default: OFF.** The CLI does not send any telemetry unless you explicitly opt in.

To enable:

```sh
seanpropapp telemetry enable
```

To disable later:

```sh
seanpropapp telemetry disable
```

To check:

```sh
seanpropapp telemetry status
```

You can also suppress telemetry for a single invocation with `--no-telemetry`.

## What gets sent when telemetry is on

Three event types, all related to the "time-to-hello-world" loop (TX7 in the v1.4.0 plan):

| Event                       | When                                                              |
|-----------------------------|-------------------------------------------------------------------|
| `cli_connect_start`         | `connect` invocation begins.                                      |
| `cli_pair_complete`         | Bridge observes the browser confirm pairing.                      |
| `cli_first_analysis_complete` | The first non-trivial analysis run finishes after pairing.       |

Each event includes:

- A UTC timestamp.
- A `correlation_id` UUID generated on first opt-in and persisted in `~/.seanpropapp/config.json`. This is the only stable identifier we send.
- An anonymized `user_id` (HMAC of the email used to sign in to the workspace, server-side).
- The CLI version (`@seanpropapp/cli@x.y.z`).
- OS family + Node major version (e.g. `darwin/arm64`, `node 20.x`).

## What never gets sent

- Your prompts.
- Your provider responses.
- Module outputs or any analysis content.
- The pair token, MCP token, or any other secret material.
- The exact stdout/stderr of any subprocess.
- File paths inside your workspace.
- IP address beyond what every HTTP request carries; we do not store it server-side keyed to your `correlation_id`.

## Where it goes

Telemetry events POST to `https://prop.seanoneill.com/api/telemetry`. The receiving table has a 90-day retention; rows older than that are pruned by the daily cron in the proposition-app repo. The schema is documented in the proposition-app `supabase/migrations/` directory.

## v0.1.0-alpha caveat

For this release, the telemetry module is wired into `connect` and emits the events to the endpoint above, but the workspace-side aggregation that turns these into a TTHW metric (TX8) ships with v1.4.0 of the proposition-app workspace. Until then, the events land but no dashboard reads them. We're documenting this honestly because the README links here.

## How to verify

If you opt in and want to see the wire-level behavior:

```sh
seanpropapp telemetry enable
SEANPROPAPP_TELEMETRY_URL="https://your-debug-endpoint" seanpropapp connect
```

Set the env var to a URL you control to capture the exact payload.
