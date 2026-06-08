import { spawn } from "node:child_process";
import {
  ClassifiedError,
  type AnthropicLikeRequest,
  type AnthropicSSEEvent,
  type Provider,
  type ProviderDetectResult,
} from "./base.js";
import { runCapture, which } from "./detect-util.js";

/**
 * Override hooks for testing. The provider takes optional injectables so we
 * can mock subprocess behavior without complex module mocks.
 */
export interface ClaudeProviderDeps {
  whichFn?: (bin: string) => Promise<string | null>;
  runCaptureFn?: typeof runCapture;
  spawnFn?: typeof spawn;
  binaryName?: string;
}

const DEFAULT_BINARY = "claude";

/**
 * Map an incoming Anthropic-style model name (whatever the browser sends in
 * the POST body) to one of the three model tiers Claude CLI accepts on its
 * `--model` flag: `opus`, `sonnet`, `haiku`.
 *
 * Inputs we handle:
 *   - Bare CLI tier names (opus / sonnet / haiku) -> passthrough
 *   - Anthropic API model IDs (claude-opus-4-7, claude-sonnet-4-6,
 *     claude-haiku-4-5-...) -> matched by substring
 *   - The literal 'subscription' that proposition-app's
 *     src/lib/llm/models.ts has historically sent for all three
 *     local_bridge tiers -> default to 'sonnet' (the balanced tier
 *     subscriptions reliably have access to)
 *   - Anything unrecognized -> 'sonnet' (sensible fallback rather than
 *     letting Claude CLI reject the run)
 *
 * Future direction: the proposition-app models.ts is being updated to send
 * the actual tier name per modelTier. Once that lands and propagates,
 * 'subscription' will stop appearing in real traffic. The mapping stays as a
 * safety net for older clients.
 */
export function mapToClaudeCliModel(model: string): "opus" | "sonnet" | "haiku" {
  const normalized = model.toLowerCase();
  if (normalized === "opus" || normalized === "sonnet" || normalized === "haiku") {
    return normalized;
  }
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  // 'sonnet', 'subscription', 'claude-sonnet-*', and unrecognized values all
  // resolve to the balanced default tier.
  return "sonnet";
}

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /429/,
  /too many requests/i,
  /subscription.*limit/i,
  /window.*capped/i,
];

const RETRY_AFTER_PATTERNS: RegExp[] = [
  /retry.?after[:\s]+(\d+)\s*s/i,
  /retry.?after[:\s]+(\d+)/i,
  /try again in\s+(\d+)\s*s/i,
];

export function detectRateLimit(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

export function parseRetryAfter(text: string): number | undefined {
  for (const re of RETRY_AFTER_PATTERNS) {
    const m = re.exec(text);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}

/** Flatten a message's string|block content into plain text. */
function messageText(m: AnthropicLikeRequest["messages"][number]): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * Build the single stdin prompt for `claude --print` from an Anthropic-style
 * messages array.
 *
 * Claude CLI's `--print` mode takes ONE prompt on stdin; it has no native
 * multi-turn input. A single user turn is sent verbatim — the overwhelmingly
 * common case (first module run, chat). For a multi-turn conversation we MUST
 * NOT send only the last turn: proposition-app's module RE-RUN packs the prior
 * output and the user's corrections into earlier turns, then ends with a short
 * "regenerate from the conversation above" instruction. Sending only that last
 * turn left the model with nothing to regenerate, so re-runs returned a stub
 * ("there's nothing above to regenerate or incorporate").
 *
 * Fix: flatten every turn into a role-labeled transcript (Human:/Assistant:)
 * so the full conversation reaches the model. The system prompt is passed
 * separately via --system-prompt and is not included here.
 *
 * Regression: proposition-app#446 / seanpropapp-cli#8 (shipped broken in
 * v0.1.0-beta.6 via the old lastUserText()).
 */
export function buildClaudePrompt(req: AnthropicLikeRequest): string {
  const turns = req.messages.filter((m) => messageText(m).trim().length > 0);
  // Single turn (or none): send the message text verbatim — identical to the
  // pre-fix single-message behavior, so first runs and chat are unchanged.
  if (turns.length <= 1) {
    return turns.length === 1 ? messageText(turns[0]!) : "";
  }
  // Multi-turn: preserve the full conversation as a labeled transcript.
  return turns
    .map((m) => {
      const text = messageText(m);
      if (m.role === "assistant") return `Assistant: ${text}`;
      // 'system' messages don't normally appear here (the client sends system
      // separately), but if one does, include its text without a turn label.
      if (m.role === "system") return text;
      return `Human: ${text}`;
    })
    .join("\n\n");
}

export class ClaudeProvider implements Provider {
  public readonly name = "claude";
  private readonly deps: Required<Omit<ClaudeProviderDeps, "spawnFn">> & {
    spawnFn: typeof spawn;
  };

  constructor(deps: ClaudeProviderDeps = {}) {
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
      return { installed: false, reason: "claude binary not found in PATH" };
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
      throw new ClassifiedError("Claude CLI not installed", {
        category: "cli_missing",
        provider: this.name,
      });
    }

    // Translate whatever the browser sent into one of Claude CLI's three
    // accepted tier names (opus | sonnet | haiku). Passing the abstract
    // 'subscription' that proposition-app/src/lib/llm/models.ts has been
    // emitting causes Claude CLI to exit with:
    //   "There's an issue with the selected model (subscription). It may
    //    not exist or you may not have access to it."
    const cliModel = mapToClaudeCliModel(request.model);
    const args = ["--print", "--model", cliModel];
    if (request.system) {
      args.push("--system-prompt", request.system);
    }
    const stdinPayload = buildClaudePrompt(request);

    const child = this.deps.spawnFn(detected.binary, args, {
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

    if (child.stdin) {
      child.stdin.end(stdinPayload);
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    yield { type: "message_start", message: { id: messageId, model: request.model } };
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };

    try {
      let totalOut = "";
      if (child.stdout) {
        for await (const chunk of child.stdout as AsyncIterable<Buffer | string>) {
          const text = typeof chunk === "string" ? chunk : chunk.toString();
          if (text.length === 0) continue;
          totalOut += text;
          // Check stdout for rate-limit signals too (CLIs sometimes write to stdout).
          if (detectRateLimit(text)) {
            const retryAfter = parseRetryAfter(text);
            throw new ClassifiedError("Subscription rate limit", {
              category: "subscription_limit",
              retryAfterSeconds: retryAfter,
              provider: this.name,
            });
          }
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          };
        }
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once("close", (code) => resolve(code));
      });

      const stderr = stderrChunks.join("");
      if (exitCode !== 0) {
        if (detectRateLimit(stderr) || detectRateLimit(totalOut)) {
          const retryAfter = parseRetryAfter(stderr) ?? parseRetryAfter(totalOut);
          throw new ClassifiedError("Subscription rate limit", {
            category: "subscription_limit",
            retryAfterSeconds: retryAfter,
            provider: this.name,
          });
        }
        throw new ClassifiedError(
          `Claude CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
          { category: "cli_crashed", provider: this.name },
        );
      }

      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      };
      yield { type: "message_stop" };
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }
  }
}
