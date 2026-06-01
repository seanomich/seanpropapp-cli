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
 * OpenAI Chat Completion format used internally before translating back
 * to Anthropic SSE for the bridge's unified output.
 */
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

/**
 * Translate Anthropic Messages → OpenAI Chat Completions shape.
 * Exported so tests can verify the translation surface directly.
 */
export function anthropicToOpenAI(req: AnthropicLikeRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];
  if (req.system) {
    messages.push({ role: "system", content: req.system });
  }
  for (const m of req.messages) {
    let content: string;
    if (typeof m.content === "string") {
      content = m.content;
    } else {
      content = m.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("\n");
    }
    if (m.role === "system") {
      messages.push({ role: "system", content });
    } else if (m.role === "assistant") {
      messages.push({ role: "assistant", content });
    } else {
      messages.push({ role: "user", content });
    }
  }
  const result: OpenAIChatRequest = {
    model: req.model,
    messages,
    stream: req.stream,
  };
  if (req.max_tokens !== undefined) result.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) result.temperature = req.temperature;
  return result;
}

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /429/,
  /too many requests/i,
  /quota.?exceeded/i,
];

export function detectRateLimit(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

export function parseRetryAfter(text: string): number | undefined {
  const re = /retry.?after[:\s]+(\d+)/i;
  const m = re.exec(text);
  if (m && m[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) return n;
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
    // Codex CLI's version flag varies; try common shapes and fall back to "present".
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

    // Translate inbound Anthropic-shape into OpenAI-shape (consumed via stdin
    // JSON so the spawned Codex CLI receives a self-describing payload).
    const openaiReq = anthropicToOpenAI(request);
    const stdinPayload = JSON.stringify(openaiReq);

    // Codex CLI invocation: use --json-input so the CLI reads the OpenAI
    // chat completions payload from stdin and streams plain text to stdout.
    // The flag set here is the canonical contract we ship against; if Codex
    // ships a different shape we adapt the args, not the wire format.
    const args = ["--json-input", "--model", request.model];

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
          `Codex CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
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
