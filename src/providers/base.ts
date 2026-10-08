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
  /**
   * proposition-app#716: present when the app wants this run to research live
   * sources. A provider that cannot research ignores it and runs as before; the
   * app learns what was retrieved from the events, never from the request.
   * The budgets are advisory here (the prompt states them): a local CLI has no
   * per-tool call cap to enforce them with.
   */
  research?: { max_searches?: number; max_fetches?: number };
}

/** Anthropic server-tool blocks the bridge re-emits for a research run. */
export type ResearchContentBlock =
  | {
      type: "server_tool_use";
      id: string;
      name: "web_search" | "web_fetch";
      input: { query: string } | { url: string };
    }
  | {
      type: "web_search_tool_result";
      tool_use_id: string;
      content:
        | Array<{ type: "web_search_result"; url: string; title?: string }>
        | { type: "web_search_tool_result_error"; error_code: string };
    }
  | {
      type: "web_fetch_tool_result";
      tool_use_id: string;
      content:
        | { type: "web_fetch_result"; url: string; retrieved_at: string }
        | { type: "web_fetch_tool_result_error"; error_code: string };
    };

export type AnthropicSSEEvent =
  | { type: "message_start"; message: { id: string; model: string } }
  | { type: "content_block_start"; index: number; content_block: { type: "text"; text: string } }
  | { type: "content_block_start"; index: number; content_block: ResearchContentBlock }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null };
      usage?: { output_tokens: number; input_tokens?: number };
    }
  | { type: "message_stop" }
  | {
      type: "error";
      error: {
        /** Legacy wire value. Both throttling kinds that used to be one still map
         *  to "rate_limit_exceeded" here, so an older client keeps working. */
        type: string;
        /** ADDITIVE (CLI #27): the precise ClassifiedError category, so a current
         *  client can distinguish subscription_limit / rate_limited / overloaded
         *  and offer the matching recovery instead of guessing from `type`. */
        category?: ClassifiedError["category"];
        message: string;
        retry_after_seconds?: number;
        /** ADDITIVE: when a subscription window resets, as the CLI wrote it
         *  ("10:10pm (Europe/London)"). Present only when the CLI said. */
        resets_at?: string;
      };
    };

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
 * A provider failure with a category the browser can act on.
 *
 * The throttling categories are deliberately three, not one (CLI #27). They imply
 * different user actions, and collapsing them produced advice that was actively
 * wrong: a user with 5% of their weekly allowance used was told to wait for a
 * subscription window to reset, next to a button offering to sell them an upgrade.
 */
export class ClassifiedError extends Error {
  public readonly category:
    /** The USER's own allowance is spent: Claude Pro window cap, weekly cap,
     *  ChatGPT Plus cap. Waiting or upgrading is the fix. */
    | "subscription_limit"
    /** The PROVIDER is throttling this request (HTTP 429). Nothing is wrong with
     *  the user's plan; retrying shortly, or falling back a model, is the fix.
     *  Distinct from subscription_limit because telling someone with 5% of their
     *  allowance used to "wait for your window to reset" is misleading, and the
     *  app's UPGRADE SUBSCRIPTION affordance invites a purchase that fixes
     *  nothing (CLI #27). */
    | "rate_limited"
    /** The provider is overloaded (HTTP 529). Retryable, and the correct trigger
     *  for a within-class model fallback (proposition-app#652), which cannot help
     *  when the user's own allowance is exhausted. */
    | "overloaded"
    | "auth_required"
    | "cli_missing"
    | "cli_crashed"
    | "short_output"
    | "unknown";
  public readonly retryAfterSeconds?: number;
  /** When the user's window resets, verbatim from the CLI, when it said. */
  public readonly resetsAt?: string;
  public readonly provider?: string;

  constructor(
    message: string,
    opts: {
      category: ClassifiedError["category"];
      retryAfterSeconds?: number;
      resetsAt?: string;
      provider?: string;
    },
  ) {
    super(message);
    this.name = "ClassifiedError";
    this.category = opts.category;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.resetsAt = opts.resetsAt;
    this.provider = opts.provider;
  }
}
