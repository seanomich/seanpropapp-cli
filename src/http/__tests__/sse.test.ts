import { describe, it, expect } from "vitest";
import {
  encodeAnthropicSSE,
  anthropicEventToOpenAIChunk,
  encodeOpenAIChunk,
  type OpenAIDelta,
} from "../sse.js";
import type { AnthropicSSEEvent } from "../../providers/base.js";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("encodeAnthropicSSE", () => {
  it("emits the Anthropic wire format: event: <type>\\ndata: <json>\\n\\n", () => {
    const ev: AnthropicSSEEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    };
    const out = dec(encodeAnthropicSSE(ev));
    expect(out.startsWith("event: content_block_delta\n")).toBe(true);
    expect(out).toContain("data: ");
    expect(out.endsWith("\n\n")).toBe(true);
    // the data line round-trips to the same event
    const json = out.split("data: ")[1].trimEnd();
    expect(JSON.parse(json)).toEqual(ev);
  });

  it("names the event from the type for every variant", () => {
    expect(dec(encodeAnthropicSSE({ type: "message_stop" }))).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });
});

describe("anthropicEventToOpenAIChunk", () => {
  const ctx = { id: "chatcmpl_x", model: "claude-sonnet-4", created: 1700000000 };

  it("message_start -> role delta chunk", () => {
    const chunk = anthropicEventToOpenAIChunk(
      { type: "message_start", message: { id: "m", model: "claude" } },
      ctx,
    ) as OpenAIDelta;
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0].delta).toEqual({ role: "assistant" });
    expect(chunk.choices[0].finish_reason).toBeNull();
    expect(chunk.id).toBe("chatcmpl_x");
  });

  it("content_block_delta -> content delta chunk", () => {
    const chunk = anthropicEventToOpenAIChunk(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tok" } },
      ctx,
    ) as OpenAIDelta;
    expect(chunk.choices[0].delta).toEqual({ content: "tok" });
  });

  it("message_delta maps stop_reason: null -> running, non-null -> stop", () => {
    const running = anthropicEventToOpenAIChunk(
      { type: "message_delta", delta: { stop_reason: null } },
      ctx,
    ) as OpenAIDelta;
    expect(running.choices[0].finish_reason).toBeNull();
    const stopped = anthropicEventToOpenAIChunk(
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ctx,
    ) as OpenAIDelta;
    expect(stopped.choices[0].finish_reason).toBe("stop");
  });

  it("message_stop -> {done:true}; error/others -> null", () => {
    expect(anthropicEventToOpenAIChunk({ type: "message_stop" }, ctx)).toEqual({ done: true });
    expect(
      anthropicEventToOpenAIChunk(
        { type: "error", error: { type: "x", message: "y" } },
        ctx,
      ),
    ).toBeNull();
    expect(
      anthropicEventToOpenAIChunk({ type: "content_block_stop", index: 0 }, ctx),
    ).toBeNull();
  });
});

describe("encodeOpenAIChunk", () => {
  it("encodes a chunk as a data line", () => {
    const chunk: OpenAIDelta = {
      id: "i",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
    };
    const out = dec(encodeOpenAIChunk(chunk));
    expect(out).toBe(`data: ${JSON.stringify(chunk)}\n\n`);
  });

  it("encodes the terminal {done:true} as data: [DONE]", () => {
    expect(dec(encodeOpenAIChunk({ done: true }))).toBe("data: [DONE]\n\n");
  });
});
