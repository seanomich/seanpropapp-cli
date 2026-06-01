/**
 * Common provider interface. Each provider wraps a local subscription CLI
 * (Claude CLI, Codex CLI, future Gemini CLI) and exposes a streaming API in
 * Anthropic's Messages SSE shape.
 *
 * The bridge speaks both Anthropic and OpenAI wire formats; providers
 * normalize to Anthropic internally and the OpenAI endpoint translates
 * on the way out.
 */

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | Array<{ type: string; text?: string }>;
}

export interface AnthropicLikeRequest {
  model: string;
  max_tokens?: number;
  system?: string;
  messages: AnthropicMessage[];
  stream?: boolean;
  temperature?: number;
}

export type AnthropicSSEEvent =
  | { type: "message_start"; message: { id: string; model: string } }
  | { type: "content_block_start"; index: number; content_block: { type: "text"; text: string } }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null }; usage?: { output_tokens: number } }
  | { type: "message_stop" }
  | { type: "error"; error: { type: string; message: string; retry_after_seconds?: number } };

export interface ProviderDetectResult {
  installed: boolean;
  binary?: string;
  version?: string;
  reason?: string;
}

export interface Provider {
  readonly name: string;
  detect(): Promise<ProviderDetectResult>;
  stream(
    request: AnthropicLikeRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AnthropicSSEEvent>;
}

/**
 * Error category emitted when a provider's underlying CLI reports a
 * subscription rate-limit (Claude Pro window cap, ChatGPT Plus cap, etc.).
 * The browser maps this to ProviderErrorBlock's subscription_limit subtype.
 */
export class ClassifiedError extends Error {
  public readonly category:
    | "subscription_limit"
    | "auth_required"
    | "cli_missing"
    | "cli_crashed"
    | "short_output"
    | "unknown";
  public readonly retryAfterSeconds?: number;
  public readonly provider?: string;

  constructor(
    message: string,
    opts: {
      category: ClassifiedError["category"];
      retryAfterSeconds?: number;
      provider?: string;
    },
  ) {
    super(message);
    this.name = "ClassifiedError";
    this.category = opts.category;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.provider = opts.provider;
  }
}
