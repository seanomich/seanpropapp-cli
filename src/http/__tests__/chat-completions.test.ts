import { describe, it, expect } from "vitest";
import { createApp } from "../server.js";
import { openaiToAnthropic } from "../chat-completions.js";
import { ClassifiedError } from "../../providers/base.js";
import type { Provider, AnthropicSSEEvent } from "../../providers/base.js";

const ORIGIN = "http://localhost:3000";

function streamingProvider(name: string, events: AnthropicSSEEvent[], throwErr?: unknown): Provider {
  return {
    name,
    detect: async () => ({ installed: true }),
    async *stream() {
      for (const e of events) yield e;
      if (throwErr) throw throwErr;
    },
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "Content-Type": "application/json", Origin: ORIGIN },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function appWith(claude: Provider) {
  return createApp({ token: "tok", providers: { claude, codex: streamingProvider("codex", []) } });
}

const OK_BODY = {
  model: "claude-sonnet-4",
  messages: [{ role: "user", content: "hi" }],
};

describe("openaiToAnthropic", () => {
  it("concatenates system messages and maps roles", () => {
    const out = openaiToAnthropic({
      model: "m",
      messages: [
        { role: "system", content: "rule A" },
        { role: "system", content: "rule B" },
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    });
    expect(out.system).toBe("rule A\n\nrule B");
    expect(out.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("passes through max_tokens / temperature / stream, omits absent system", () => {
    const out = openaiToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "q" }],
      max_tokens: 50,
      temperature: 0.3,
      stream: true,
    });
    expect(out.system).toBeUndefined();
    expect(out.max_tokens).toBe(50);
    expect(out.temperature).toBe(0.3);
    expect(out.stream).toBe(true);
  });
});

describe("/v1/chat/completions", () => {
  it("requires Bearer auth", async () => {
    const res = await appWith(streamingProvider("claude", [])).request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(OK_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-JSON and schema-invalid bodies with 400", async () => {
    const app = appWith(streamingProvider("claude", []));
    expect((await post(app, "nope{")).status).toBe(400);
    // OpenAI shape requires string content; an array should fail
    const bad = await post(app, { model: "m", messages: [{ role: "user", content: [{ type: "text" }] }] });
    expect(bad.status).toBe(400);
  });

  it("streams OpenAI-shaped chunks and a [DONE] terminal", async () => {
    const events: AnthropicSSEEvent[] = [
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Yo" } },
      { type: "message_stop" },
    ];
    const res = await post(appWith(streamingProvider("claude", events)), OK_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"Yo"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("REGRESSION: streaming response carries the CORS header for an allowed origin", async () => {
    const res = await post(appWith(streamingProvider("claude", [{ type: "message_stop" }])), OK_BODY);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("surfaces a provider error as an error chunk (rate_limit_exceeded for subscription cap)", async () => {
    const err = new ClassifiedError("cap", { category: "subscription_limit", retryAfterSeconds: 9 });
    const res = await post(appWith(streamingProvider("claude", [], err)), OK_BODY);
    const text = await res.text();
    expect(text).toContain("rate_limit_exceeded");
    expect(text).toContain('"retry_after_seconds":9');
  });
});
