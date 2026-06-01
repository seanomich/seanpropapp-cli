import type { AnthropicSSEEvent } from "../providers/base.js";

/**
 * Encode an Anthropic-shape SSE event as wire bytes.
 * Anthropic's format: `event: <name>\ndata: <json>\n\n`
 */
export function encodeAnthropicSSE(event: AnthropicSSEEvent): Uint8Array {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new TextEncoder().encode(payload);
}

export interface OpenAIDelta {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { content?: string; role?: "assistant" };
    finish_reason: string | null;
  }>;
}

/**
 * Translate an Anthropic SSE event back into OpenAI Chat Completions
 * chunk format, so the bridge can serve both wire shapes uniformly.
 * Returns null when an event doesn't map to a chunk (e.g. message_start).
 */
export function anthropicEventToOpenAIChunk(
  event: AnthropicSSEEvent,
  ctx: { id: string; model: string; created: number },
): OpenAIDelta | { done: true } | null {
  switch (event.type) {
    case "message_start":
      return {
        id: ctx.id,
        object: "chat.completion.chunk",
        created: ctx.created,
        model: ctx.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      };
    case "content_block_delta":
      return {
        id: ctx.id,
        object: "chat.completion.chunk",
        created: ctx.created,
        model: ctx.model,
        choices: [
          {
            index: 0,
            delta: { content: event.delta.text },
            finish_reason: null,
          },
        ],
      };
    case "message_delta":
      return {
        id: ctx.id,
        object: "chat.completion.chunk",
        created: ctx.created,
        model: ctx.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: event.delta.stop_reason === null ? null : "stop",
          },
        ],
      };
    case "message_stop":
      return { done: true };
    case "error":
      return null;
    default:
      return null;
  }
}

export function encodeOpenAIChunk(chunk: OpenAIDelta | { done: true }): Uint8Array {
  if ("done" in chunk) {
    return new TextEncoder().encode("data: [DONE]\n\n");
  }
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
}
