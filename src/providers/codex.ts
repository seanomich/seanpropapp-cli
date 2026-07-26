import { detectRateLimit, parseRetryAfter } from "./rate-limit-detect.js";
export { detectRateLimit, parseRetryAfter };
import { spawn } from "node:child_process";
import {
  ClassifiedError,
  type AnthropicLikeRequest,
  type AnthropicSSEEvent,
  type Provider,
  type ProviderDetectResult,
} from "./base.js";
import { runCapture, which } from "./detect-util.js";

export interface CodexProviderDeps {
  whichFn?: (bin: string) => Promise<string | null>;
  runCaptureFn?: typeof runCapture;
  spawnFn?: typeof spawn;
  binaryName?: string;
}

const DEFAULT_BINARY = "codex";

/**
 * Flatten an Anthropic-shape request into a single plain-text prompt for
 * `codex exec`, which takes one prompt (on stdin here). The common bridge case
 * is a single user turn, so that is passed verbatim; multi-turn conversations
 * are role-labeled so prior context survives.
 */
export function buildCodexPrompt(req: AnthropicLikeRequest): string {
  const flatten = (content: AnthropicLikeRequest["messages"][number]["content"]): string =>
    typeof content === "string"
      ? content
      : content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text ?? "")
          .join("\n");

  const parts: string[] = [];
  if (req.system) parts.push(req.system);

  const onlyOneUserTurn =
    req.messages.length === 1 && req.messages[0]?.role === "user";
  for (const m of req.messages) {
    const content = flatten(m.content);
    parts.push(onlyOneUserTurn ? content : `${m.role}: ${content}`);
  }
  return parts.join("\n\n");
}

/**
 * Args for `codex exec`. We run it non-interactively with JSONL events on
 * stdout, no git-repo requirement (the bridge runs anywhere), a read-only
 * sandbox (the bridge generates text, it must never execute model-proposed
 * shell commands), and no persisted session files.
 *
 * We deliberately do NOT pass `-m`: the SeanPropApp bridge sends the generic
 * `subscription` pseudo-model (and our tier names), none of which are real
 * Codex models, so we let Codex use the user's configured default. Bridge-driven
 * model selection is tracked in #16.
 */
export function buildCodexExecArgs(): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ephemeral",
  ];
}

const AUTH_PATTERNS: RegExp[] = [
  /not logged in/i,
  /codex login/i,
  /unauthorized/i,
  /\b401\b/,
  /authentication/i,
];

export function detectAuthError(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

/**
 * Extract the assistant text from one parsed `codex exec --json` JSONL event,
 * or null if the event carries no user-visible message. Codex emits, in order:
 *   {type:"thread.started"} {type:"turn.started"}
 *   {type:"item.completed", item:{type:"agent_message", text:"..."}}
 *   {type:"turn.completed", usage:{output_tokens, ...}}
 * Only `agent_message` items are surfaced; reasoning / command items are ignored.
 */
export function agentTextFromEvent(evt: unknown): string | null {
  if (!evt || typeof evt !== "object") return null;
  const e = evt as { type?: string; item?: { type?: string; text?: string } };
  if (e.type === "item.completed" && e.item?.type === "agent_message") {
    return typeof e.item.text === "string" ? e.item.text : null;
  }
  return null;
}

function outputTokensFromEvent(evt: unknown): number | undefined {
  if (!evt || typeof evt !== "object") return undefined;
  const e = evt as { type?: string; usage?: { output_tokens?: number } };
  if (e.type === "turn.completed" && typeof e.usage?.output_tokens === "number") {
    return e.usage.output_tokens;
  }
  return undefined;
}

export class CodexProvider implements Provider {
  public readonly name = "codex";
  private readonly deps: Required<Omit<CodexProviderDeps, "spawnFn">> & {
    spawnFn: typeof spawn;
  };

  constructor(deps: CodexProviderDeps = {}) {
    this.deps = {
      whichFn: deps.whichFn ?? which,
      runCaptureFn: deps.runCaptureFn ?? runCapture,
      spawnFn: deps.spawnFn ?? spawn,
      binaryName: deps.binaryName ?? DEFAULT_BINARY,
    };
  }

  async detect(): Promise<ProviderDetectResult> {
    const binary = await this.deps.whichFn(this.deps.binaryName);
    if (!binary) {
      return { installed: false, reason: "codex binary not found in PATH" };
    }
    const versionRun = await this.deps.runCaptureFn(binary, ["--version"], {
      timeoutMs: 5000,
    });
    const version =
      versionRun.stdout.trim().split(/\s+/).pop() || versionRun.stderr.trim();
    return { installed: true, binary, version: version || undefined };
  }

  async *stream(
    request: AnthropicLikeRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AnthropicSSEEvent> {
    const detected = await this.detect();
    if (!detected.installed || !detected.binary) {
      throw new ClassifiedError("Codex CLI not installed", {
        category: "cli_missing",
        provider: this.name,
      });
    }

    const prompt = buildCodexPrompt(request);
    const child = this.deps.spawnFn(detected.binary, buildCodexExecArgs(), {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    const abortHandler = () => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abortHandler);

    // `codex exec` reads the prompt from stdin when none is given as an arg.
    if (child.stdin) {
      child.stdin.end(prompt);
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    yield { type: "message_start", message: { id: messageId, model: request.model } };
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };

    let outputTokens = 0;
    let rawForClassify = "";
    // Mitigation 2 (see rate-limit-detect.ts): rawForClassify accumulates the
    // agent's own text, so it is only a trustworthy refusal signal before any
    // real output has been emitted.
    let emittedChars = 0;

    try {
      // Parse JSONL: accumulate stdout, emit on each complete line.
      let buffer = "";
      const handleLine = function* (
        line: string,
      ): Generator<AnthropicSSEEvent> {
        const trimmed = line.trim();
        if (!trimmed) return;
        rawForClassify += trimmed + "\n";
        let evt: unknown;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          return; // not a JSON line (banner / partial); ignore
        }
        const text = agentTextFromEvent(evt);
        if (text) {
          emittedChars += text.length;
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          };
        }
        const toks = outputTokensFromEvent(evt);
        if (toks !== undefined) outputTokens = toks;
      };

      if (child.stdout) {
        for await (const chunk of child.stdout as AsyncIterable<Buffer | string>) {
          buffer += typeof chunk === "string" ? chunk : chunk.toString();
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            yield* handleLine(line);
          }
        }
      }
      // Flush any trailing partial line.
      if (buffer.length > 0) yield* handleLine(buffer);

      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once("close", (code) => resolve(code));
      });
      const stderr = stderrChunks.join("");
      const haystack = stderr + "\n" + rawForClassify;
      // stderr is always safe to scan; the agent's own output only counts when
      // the run produced nothing.
      const limitHaystack = emittedChars === 0 ? haystack : stderr;

      if (exitCode !== 0) {
        if (detectRateLimit(limitHaystack)) {
          throw new ClassifiedError(
            // Include what the CLI actually said, so an incident leaves evidence.
            `Codex subscription rate limit reached (exit ${exitCode}): ${limitHaystack.trim().slice(0, 300)}`,
            {
              category: "subscription_limit",
              retryAfterSeconds: parseRetryAfter(limitHaystack),
              provider: this.name,
            },
          );
        }
        if (detectAuthError(haystack)) {
          throw new ClassifiedError(
            "Codex CLI is not logged in. Run `codex login`, then retry.",
            { category: "auth_required", provider: this.name },
          );
        }
        throw new ClassifiedError(
          `Codex CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
          { category: "cli_crashed", provider: this.name },
        );
      }

      // A zero exit means the CLI reported success. Only a run that produced NO
      // agent output at all can still be a refusal dressed as success; once real
      // output exists, its prose must never be reinterpreted as a refusal. That
      // reinterpretation turned finished analyses into fake "subscription rate
      // limit" failures (2026-07-25). Unlike the Claude provider, codex emits
      // structured JSONL, so emittedChars genuinely tracks agent text here and
      // this gate is meaningful rather than vacuous.
      if (emittedChars === 0 && detectRateLimit(rawForClassify)) {
        throw new ClassifiedError("Codex subscription rate limit reached", {
          category: "subscription_limit",
          retryAfterSeconds: parseRetryAfter(rawForClassify),
          provider: this.name,
        });
      }

      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: outputTokens },
      };
      yield { type: "message_stop" };
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }
  }
}
