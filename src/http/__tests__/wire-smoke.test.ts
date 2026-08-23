import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, type RunningServer } from "../server.js";
import type {
  Provider,
  AnthropicSSEEvent,
  AnthropicLikeRequest,
} from "../../providers/base.js";

/**
 * WIRE smoke test: boots a REAL listening socket and drives it with REAL
 * fetch, rather than calling `app.request()`.
 *
 * Why this file exists as a separate suite from cors.test.ts:
 *
 * `app.request()` invokes Hono's fetch handler directly and returns whatever
 * Response object the handler produced. That is not the wire. The
 * v0.1.0-beta.4 CORS bug lived in exactly that gap: both streaming endpoints
 * returned a raw `new Response(stream, ...)`, which bypasses Hono's response
 * builder, so headers set via `c.header()` in corsMiddleware never reached the
 * wire. Chrome blocked every POST /v1/messages with "No
 * 'Access-Control-Allow-Origin' header is present" while the unit tests stayed
 * green, because a handler-level assertion cannot see a header that is lost
 * between the handler and the socket.
 *
 * cors.test.ts still covers the allowlist logic and asserts
 * streamingResponseCorsHeaders() returns the right map. This file asserts the
 * map actually arrives at a client. Those are different claims and the second
 * one is the one that shipped broken.
 *
 * The provider is faked so this runs on a CI box with no Claude or Codex CLI
 * installed. Everything below the provider -- routing, auth, CORS, the SSE
 * encoder, the raw Response construction, @hono/node-server's serve() -- is
 * the real code path.
 */

const TOKEN = "wire-smoke-token-0123456789";
const ORIGIN = "https://seanpropapp.com";

function fakeProvider(): Provider {
  return {
    name: "claude",
    detect: async () => ({
      installed: true,
      binary: "/fake/claude",
      version: "wire-smoke",
    }),
    async *stream(
      _request: AnthropicLikeRequest,
      _signal?: AbortSignal,
    ): AsyncIterable<AnthropicSSEEvent> {
      yield { type: "message_start", message: { id: "msg_wire", model: "haiku" } };
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      };
      // Two deltas with a yield to the event loop between them, so the response
      // is genuinely chunked rather than one buffered write. A single-delta
      // stream can pass even if the server buffers the whole body first, which
      // would hide the very property this file is here to prove.
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "BRIDGE" },
      };
      await new Promise((r) => setTimeout(r, 10));
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " OK" },
      };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      };
      yield { type: "message_stop" };
    },
  };
}

let server: RunningServer;

beforeAll(async () => {
  // Port 0 asks the OS for an ephemeral port. Deliberate: the default range
  // (17492-17500) may be occupied by a developer's real bridge, and a smoke
  // test must not fight it for a port or, worse, silently talk to it.
  server = await startServer({
    port: 0,
    token: TOKEN,
    providers: { claude: fakeProvider() },
  });
});

afterAll(async () => {
  await server?.close();
});

function url(path: string): string {
  return `${server.url}${path}`;
}

const STREAM_BODY = JSON.stringify({
  model: "haiku",
  max_tokens: 64,
  stream: true,
  messages: [{ role: "user", content: "say BRIDGE OK" }],
});

describe("wire smoke: real socket, real fetch", () => {
  it("binds a real ephemeral port and serves the handshake", async () => {
    expect(server.port).toBeGreaterThan(0);

    const res = await fetch(url("/v1/handshake"), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; providers: unknown };
    expect(body.version).toBeTruthy();
    expect(body.providers).toBeTruthy();
  });

  it("rejects a request with no Bearer token", async () => {
    const res = await fetch(url("/v1/handshake"));
    expect(res.status).toBe(401);
  });

  it("answers the preflight with the PNA opt-in Chrome requires", async () => {
    const res = await fetch(url("/v1/messages"), {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    // Chrome 130+ silently blocks public-origin -> 127.0.0.1 without this.
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("rejects a disallowed origin with 403", async () => {
    const res = await fetch(url("/v1/handshake"), {
      headers: { Origin: "https://evil.example.com", Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  /**
   * THE REGRESSION TEST. A green run of this assertion is the thing
   * v0.1.0-beta.4 did not have.
   */
  it("carries CORS headers on the STREAMING response, not just the preflight", async () => {
    const res = await fetch(url("/v1/messages"), {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: STREAM_BODY,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // fetch resolves as soon as headers land, before the body is consumed. So
    // reading these here also proves they were sent with the response head
    // rather than appended after the stream finished.
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("vary")).toContain("Origin");

    // Read to completion rather than cancelling: aborting mid-stream is covered
    // deliberately by its own test below.
    await res.text();
  });

  /**
   * Client disconnects mid-stream. This is ordinary user behaviour -- closing
   * the tab, hitting stop, navigating away during a long analysis -- and it
   * used to take the whole bridge process down.
   *
   * The mechanism: cancelling the readable rejects the in-flight
   * `writer.write()` in the streaming task, control enters its catch, which
   * wrote the error event to the SAME broken writer. That second write rejected
   * too, and since the task is deliberately not awaited, the rejection escaped.
   * Node's default for an unhandled rejection is fatal, so the bridge exited 1
   * and every later request failed until it was restarted.
   *
   * Verified before the fix with a standalone repro against the built server:
   * "PROCESS EXIT code=1 ... ERR_UNHANDLED_REJECTION".
   *
   * The assertion is that the SERVER SURVIVES and still answers -- not merely
   * that the cancel resolved, which it did even while the bug was live.
   *
   * HOW THIS TEST ACTUALLY GATES THE BUG -- read before "cleaning up" noise.
   * Measured both ways: `vitest run` on this file exits 1 without the fix and 0
   * with it. But the exit-1 comes from vitest failing the run on the escaped
   * unhandled rejection, NOT from the assertion below, which passes either way
   * because a vitest worker does not die on an unhandled rejection the way the
   * bare `node` bridge process does.
   *
   * So: do NOT register a global `process.on("unhandledRejection")` handler in
   * this suite or in vitest setup, and do not set
   * `--unhandled-rejections=warn`. Any of those silences the channel this test
   * gates on and leaves it green against a bridge that crashes in production.
   * (That mistake was made once while diagnosing this: an early repro installed
   * such a handler and reported the process surviving, which was an artifact of
   * the handler, not of the code.)
   */
  it("survives a client aborting mid-stream and keeps serving", async () => {
    const res = await fetch(url("/v1/messages"), {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: STREAM_BODY,
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    // Give the abandoned streaming task a turn to reject if it is going to.
    await new Promise((r) => setTimeout(r, 100));

    // The listener is still up and serving. Under the bug this process would
    // already have exited, taking the test runner with it.
    const after = await fetch(url("/v1/handshake"), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(after.status).toBe(200);
  });

  it("streams the SSE body in more than one chunk", async () => {
    const res = await fetch(url("/v1/messages"), {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: STREAM_BODY,
    });

    expect(res.body).toBeTruthy();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const text = chunks.join("");

    // Arrived incrementally rather than as one buffered write. Asserting the
    // body content alone would pass on a fully buffered response and would not
    // distinguish a stream from a blob.
    expect(chunks.length).toBeGreaterThan(1);

    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");
    // Both deltas made it through in order.
    expect(text.indexOf("BRIDGE")).toBeGreaterThan(-1);
    expect(text.indexOf(" OK")).toBeGreaterThan(text.indexOf("BRIDGE"));
  });

  it("carries CORS headers on the OpenAI-compat streaming response too", async () => {
    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "haiku",
        stream: true,
        messages: [{ role: "user", content: "say BRIDGE OK" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("[DONE]");
  });
});
