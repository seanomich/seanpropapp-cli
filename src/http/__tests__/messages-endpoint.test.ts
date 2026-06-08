import { describe, it, expect } from "vitest";
import { createApp } from "../server.js";
import { ClassifiedError } from "../../providers/base.js";
import type { Provider, AnthropicSSEEvent } from "../../providers/base.js";

const ORIGIN = "http://localhost:3000";

/** Provider whose stream yields the given events, or throws `throwErr`. */
function streamingProvider(
  name: string,
  events: AnthropicSSEEvent[],
  throwErr?: unknown,
): Provider {
  return {
    name,
    detect: async () => ({ installed: true, binary: `/bin/${name}`, version: "1" }),
    async *stream() {
      for (const e of events) yield e;
      if (throwErr) throw throwErr;
    },
  };
}

function appWith(claude: Provider, codex?: Provider) {
  return createApp({
    token: "tok",
    providers: { claude, codex: codex ?? streamingProvider("codex", []) },
  });
}

function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: {
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const OK_BODY = {
  model: "claude-sonnet-4",
  max_tokens: 100,
  messages: [{ role: "user", content: "hello" }],
  stream: true,
};

describe("/v1/messages", () => {
  it("requires Bearer auth", async () => {
    const res = await appWith(streamingProvider("claude", [])).request("/v1/messages", {
      method: "POST",
      body: JSON.stringify(OK_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-JSON body with 400 invalid_request", async () => {
    const res = await post(appWith(streamingProvider("claude", [])), "not json{");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request");
  });

  it("rejects a schema-invalid body with 400 and field detail", async () => {
    const app = appWith(streamingProvider("claude", []));
    // missing model + empty messages
    const res = await post(app, { messages: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request");
    expect(body.error.message).toMatch(/model|messages/);
  });

  it("streams provider events as Anthropic SSE on a 200 text/event-stream", async () => {
    const events: AnthropicSSEEvent[] = [
      { type: "message_start", message: { id: "m1", model: "claude" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "message_stop" },
    ];
    const res = await post(appWith(streamingProvider("claude", events)), OK_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text":"Hello"');
    expect(text).toContain("event: message_stop");
  });

  it("REGRESSION: the streaming response carries the CORS header for an allowed origin", async () => {
    // beta.4 bug: the raw new Response() bypassed Hono middleware, so the
    // browser blocked the stream with "No Access-Control-Allow-Origin header".
    const res = await post(appWith(streamingProvider("claude", [{ type: "message_stop" }])), OK_BODY);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("surfaces a ClassifiedError(subscription_limit) as a rate_limit_exceeded error event", async () => {
    const err = new ClassifiedError("Pro cap reached", {
      category: "subscription_limit",
      retryAfterSeconds: 42,
    });
    const res = await post(
      appWith(streamingProvider("claude", [{ type: "message_start", message: { id: "m", model: "c" } }], err)),
      OK_BODY,
    );
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("rate_limit_exceeded");
    expect(text).toContain('"retry_after_seconds":42');
  });

  it("surfaces a generic provider error as an internal_error event (never hangs)", async () => {
    const res = await post(
      appWith(streamingProvider("claude", [], new Error("boom"))),
      OK_BODY,
    );
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("internal_error");
    expect(text).toContain("boom");
  });

  it("routes by model: gpt-* goes to codex, claude-* to claude", async () => {
    const claude = streamingProvider("claude", [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "FROM_CLAUDE" } },
      { type: "message_stop" },
    ]);
    const codex = streamingProvider("codex", [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "FROM_CODEX" } },
      { type: "message_stop" },
    ]);
    const app = appWith(claude, codex);
    const claudeText = await (await post(app, { ...OK_BODY, model: "claude-sonnet-4" })).text();
    expect(claudeText).toContain("FROM_CLAUDE");
    const gptText = await (await post(app, { ...OK_BODY, model: "gpt-4o" })).text();
    expect(gptText).toContain("FROM_CODEX");
  });
});
