import { describe, it, expect } from "vitest";
import { mapToClaudeCliModel } from "../providers/claude.js";
import { createApp } from "../http/server.js";
import type { Provider, AnthropicSSEEvent } from "../providers/base.js";
import {
  BRIDGE_TIER_MODELS,
  BRIDGE_MODEL_NAMES,
  SAMPLE_MESSAGES_REQUEST,
  SAMPLE_SSE_EVENTS,
  SAMPLE_SSE_TEXT,
} from "./bridge-contract.fixture.js";

/**
 * Bridge side of the proposition-app <-> seanpropapp-cli wire contract.
 * Asserts the bridge accepts what the browser sends and emits what the browser
 * parses. See bridge-contract.fixture.ts (kept in sync with proposition-app).
 */
describe("bridge contract (CLI side)", () => {
  it("accepts every model name proposition-app sends VERBATIM (no silent fallback to sonnet)", () => {
    for (const name of BRIDGE_MODEL_NAMES) {
      expect(mapToClaudeCliModel(name)).toBe(name);
    }
    // And the per-tier mapping the browser relies on:
    expect(mapToClaudeCliModel(BRIDGE_TIER_MODELS.deep)).toBe("opus");
    expect(mapToClaudeCliModel(BRIDGE_TIER_MODELS.standard)).toBe("sonnet");
    expect(mapToClaudeCliModel(BRIDGE_TIER_MODELS.quick)).toBe("haiku");
  });

  it("accepts the browser's canonical /v1/messages request shape (200, not 400)", async () => {
    const fake: Provider = {
      name: "claude",
      detect: async () => ({ installed: true }),
      async *stream() {
        yield { type: "message_stop" } as AnthropicSSEEvent;
      },
    };
    const app = createApp({ token: "tok", providers: { claude: fake } });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify(SAMPLE_MESSAGES_REQUEST),
    });
    expect(res.status).toBe(200);
  });

  it("emits SSE the browser parser consumes: the contract event sequence -> the expected text", async () => {
    const fake: Provider = {
      name: "claude",
      detect: async () => ({ installed: true }),
      async *stream() {
        for (const e of SAMPLE_SSE_EVENTS) yield e as AnthropicSSEEvent;
      },
    };
    const app = createApp({ token: "tok", providers: { claude: fake } });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify(SAMPLE_MESSAGES_REQUEST),
    });
    const text = await res.text();
    // Every contract event type is on the wire, and the deltas reconstruct the text.
    for (const ev of SAMPLE_SSE_EVENTS) expect(text).toContain(`event: ${ev.type}`);
    const rendered = [...text.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(rendered).toBe(SAMPLE_SSE_TEXT);
  });
});
