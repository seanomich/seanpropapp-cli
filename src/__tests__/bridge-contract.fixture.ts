/**
 * Wire contract between proposition-app (browser client) and seanpropapp-cli
 * (the local bridge). This file is the source of truth for the request/response
 * shapes that cross the bridge boundary.
 *
 * ⚠️ KEEP IN SYNC with the identical copy in the other repo:
 *   - seanpropapp-cli:  src/__tests__/bridge-contract.fixture.ts   (this file)
 *   - proposition-app:  src/lib/llm/__tests__/bridge-contract.fixture.ts
 *
 * Changing the contract requires updating BOTH copies in the same change.
 * The per-repo contract tests assert each side honors what's here, so drift
 * (the beta.4 streaming-CORS and beta.5 model-name bugs were both contract
 * drift) fails a test instead of failing a user.
 */

/**
 * Model names proposition-app sends for the three local_bridge tiers
 * (src/lib/llm/models.ts MODEL_MAP.local_bridge[tier].modelId). The bridge's
 * mapToClaudeCliModel MUST accept each of these VERBATIM (not via the
 * default-to-sonnet fallback), or a tier silently degrades to sonnet.
 */
export const BRIDGE_TIER_MODELS = {
  deep: "opus",
  standard: "sonnet",
  quick: "haiku",
} as const;

export const BRIDGE_MODEL_NAMES = ["opus", "sonnet", "haiku"] as const;

/**
 * A canonical POST /v1/messages request body as the browser produces it
 * (stream-client.ts). The bridge's MessagesRequestSchema must accept it.
 */
export const SAMPLE_MESSAGES_REQUEST = {
  model: "sonnet",
  max_tokens: 4096,
  stream: true,
  system: "You are a proposition analyst.",
  messages: [{ role: "user", content: "Analyze Acme Corp." }],
} as const;

/**
 * The Anthropic-shape SSE event sequence the bridge emits for a normal
 * completion. The browser's parser (consumeBridgeStream) consumes exactly
 * these event types; new/renamed event shapes must update both sides.
 */
export const SAMPLE_SSE_EVENTS = [
  { type: "message_start", message: { id: "msg_contract", model: "claude" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
] as const;

/** Concatenation of the text_delta chunks above; what the browser should render. */
export const SAMPLE_SSE_TEXT = "Hello world";

/**
 * Error event `type` values the bridge emits inside `{ type: "error", error: {...} }`
 * and that the browser must map to BRIDGE-XXX codes.
 */
export const BRIDGE_ERROR_TYPES = ["rate_limit_exceeded", "internal_error"] as const;
