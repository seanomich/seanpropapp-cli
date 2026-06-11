# AGENTS.md — @seanpropapp/cli

Context for AI agents (Codex and others) working on or reviewing this repo. This
is the durable "constitution": mission, principles, and the non-negotiable
confidentiality/security rules. It is the primary context doc for this repo
(there is no separate CLAUDE.md here). The sibling app repo `proposition-app`
(SeanPropApp) has its own `AGENTS.md` with the wider product strategy.

## What this is
`@seanpropapp/cli` is a small, **open-source** CLI that runs locally on a user's
machine. It lets the SeanPropApp browser app send LLM requests to the user's
existing **Claude Pro or ChatGPT Plus subscription** through a local bridge — no
API key, no extra cost. Published to npm as `@seanpropapp/cli`.

Core flow: the browser pairs with the local bridge (`connect`/`pair`), then sends
requests to a localhost HTTP server (`/v1/messages`, `/v1/chat/completions`,
SSE-streamed). The bridge forwards them to the locally-installed Claude CLI or
Codex CLI subprocess and streams the response back. Also runs as an MCP stdio
server for Claude Desktop / Cursor.

## The cardinal rule: confidentiality of user content
This is the most important property of this codebase. The product promise,
stated in the README, is:

> Your prompts and your provider responses stay between your computer and your
> AI provider; this repo only ships the bridge code.

Everything below protects that promise. Treat any violation as a release blocker.

- **User content (prompts, conversation, provider responses) must never be
  logged, persisted, or transmitted anywhere except between the user's machine
  and their AI provider.** The bridge is a pass-through; it is not a store and
  not a relay to us.
- **Telemetry is OFF by default and must be content-free** — counters and
  diagnostic metadata only, never prompt/response text, file content, or PII.
  If you add a telemetry field, prove it carries no user content.
- **Because this repo is open source, the protection is the design, not
  obscurity.** Anyone can read this code; it must be visibly free of any
  exfiltration or covert logging path. Keep it that way.
- The bridge binds locally. Do not widen its network exposure (no binding to
  `0.0.0.0` without auth, no proxying user content to third parties).

## Security principles
- **Auth + origin gating are load-bearing.** The handshake/pairing token gates
  who may talk to the local server; CORS restricts which origins can reach it.
  `connected gates must use the shared resolver` — never weaken these to "make
  it work." A bridge that accepts anything is the core threat model here.
- **Fail closed.** Missing/invalid auth, missing provider, unknown origin →
  reject, don't fall through.
- **Subprocess handling:** the providers spawn the Claude/Codex CLI. Treat their
  arguments and the conversation payload as untrusted input shapes; do not build
  shell strings that allow injection; pass arrays, not interpolated commands.
- **No silent failures.** Surface actionable errors (the `doctor` command is the
  model). Never swallow an error or fake a success.

## Wire contract (do not break silently)
- `src/__tests__/bridge-contract.fixture.ts` is a **shared, keep-in-sync** wire
  contract mirrored in `proposition-app` (`src/lib/llm/__tests__/`). It pins
  model names (opus/sonnet/haiku), the `/v1/messages` body shape, the SSE event
  sequence, and error types. Changing the contract on one side without the other
  causes the class of bridge-drift bugs that shipped in beta.4/beta.5. If you
  touch request/response/SSE shapes, update both fixtures together.
- **Multi-turn:** `claude --print` has no native multi-turn. Any path relying on
  earlier/assistant turns must flatten the whole conversation into the prompt
  (see `buildClaudePrompt`), never send only the last turn. Re-runs and
  "regenerate from above" depend on this.

## Repo facts
- Language: TypeScript → `tsc` build; bin entry `seanpropapp` (`dist/index.js`).
- Tests: Vitest with a coverage gate (`npm test` = `vitest run --coverage`;
  `npm run test:fast` skips coverage). The HTTP/streaming core
  (`src/http/**`, `src/providers/**`) is the highest-value area to keep covered —
  it's where the streaming-CORS and model-translation bugs lived.
- Publishing is **tag-triggered and machine-independent:** bump `version` in
  BOTH `package.json` and `src/version.ts`, then push a matching `v<version>`
  git tag — GitHub Actions runs `npm publish --provenance`. Any machine with
  push access can cut a release.
- Layout: `src/commands/` (connect, bridge, pair, mcp, doctor, autostart, …),
  `src/http/` (server, messages-endpoint, chat-completions, sse, cors, auth),
  `src/providers/` (claude, codex, detect-util), `src/mcp/`.

## When reviewing or changing code, prioritize (for Codex second opinions)
1. **Any new path that could log, persist, or transmit user prompts/responses.**
   This is the #1 thing to catch. Includes telemetry, debug logging, crash
   reports, and error messages that might echo content.
2. Weakened auth/origin/CORS gating, or a code path that bypasses the shared
   "is this request authorized?" resolver.
3. Subprocess argument construction that could allow command injection.
4. Wire-contract changes not mirrored in the `proposition-app` fixture.
5. Multi-turn flattening regressions (dropping assistant/earlier-user turns).
6. Fail-open behavior where fail-closed is required.

## House style
Match the conventions of the surrounding code. Keep the open-source surface
clean and auditable — readability here is a security feature.
