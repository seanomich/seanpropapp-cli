import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  corsMiddleware,
  isOriginAllowed,
  ALLOWED_ORIGINS,
  PREFLIGHT_MAX_AGE_SECONDS,
  streamingResponseCorsHeaders,
} from "../cors.js";

function buildApp() {
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.get("/ping", (c) => c.json({ ok: true }));
  app.post("/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("cors", () => {
  it("isOriginAllowed allows prod + localhost only", () => {
    expect(isOriginAllowed("https://prop.seanoneill.com")).toBe(true);
    expect(isOriginAllowed("http://localhost:3000")).toBe(true);
    expect(isOriginAllowed("https://evil.example.com")).toBe(false);
    expect(isOriginAllowed(null)).toBe(false);
    expect(isOriginAllowed(undefined)).toBe(false);
  });

  it("allows GET with prod origin and echoes Access-Control-Allow-Origin", async () => {
    const app = buildApp();
    const res = await app.request("/ping", {
      headers: { Origin: "https://prop.seanoneill.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://prop.seanoneill.com",
    );
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("rejects 403 for disallowed origin", async () => {
    const app = buildApp();
    const res = await app.request("/ping", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("responds to OPTIONS preflight with Max-Age 86400 and 204", async () => {
    const app = buildApp();
    const res = await app.request("/ping", {
      method: "OPTIONS",
      headers: {
        Origin: "https://prop.seanoneill.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-max-age")).toBe(
      String(PREFLIGHT_MAX_AGE_SECONDS),
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
    // PNA opt-in: Chrome 130+ blocks https-public to localhost-private
    // requests unless the preflight carries this header. Required for chat
    // POSTs to /v1/messages to succeed in modern Chrome.
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("allows localhost dev origin", async () => {
    const app = buildApp();
    const res = await app.request("/ping", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(200);
  });

  it("ALLOWED_ORIGINS list contains only the two expected entries", () => {
    expect(ALLOWED_ORIGINS).toEqual([
      "https://prop.seanoneill.com",
      "http://localhost:3000",
    ]);
  });
});

describe("streamingResponseCorsHeaders", () => {
  // Regression for the v0.1.0-beta.3 production bug: the /v1/messages and
  // /v1/chat/completions handlers returned `new Response(stream, {...})`
  // directly, which bypassed the headers set by the Hono middleware on the
  // context. Chrome then blocked the streaming response with
  //   Access to fetch at ... has been blocked by CORS policy:
  //   No 'Access-Control-Allow-Origin' header is present on the requested resource.
  // even though the preflight OPTIONS had succeeded. Both endpoints now spread
  // the output of this helper into their Response init.
  it("returns the CORS headers a streaming Response must carry for an allowlisted origin", () => {
    const headers = streamingResponseCorsHeaders("https://prop.seanoneill.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://prop.seanoneill.com");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("false");
    expect(headers["Vary"]).toBe("Origin");
  });

  it("returns the same headers for the localhost dev origin", () => {
    const headers = streamingResponseCorsHeaders("http://localhost:3000");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
  });

  it("returns an empty object for null / undefined / disallowed origin so the helper composes safely", () => {
    expect(streamingResponseCorsHeaders(null)).toEqual({});
    expect(streamingResponseCorsHeaders(undefined)).toEqual({});
    expect(streamingResponseCorsHeaders("https://evil.example.com")).toEqual({});
  });
});
