import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeAuthMiddleware } from "../auth-middleware.js";

function buildApp(token: string) {
  const app = new Hono();
  app.use("*", makeAuthMiddleware(token));
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("auth-middleware", () => {
  it("rejects 401 when Authorization header missing", async () => {
    const app = buildApp("good-token");
    const res = await app.request("/ping");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/missing/i);
  });

  it("rejects 401 when scheme is not Bearer", async () => {
    const app = buildApp("good-token");
    const res = await app.request("/ping", {
      headers: { Authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects 401 when token mismatches", async () => {
    const app = buildApp("good-token");
    const res = await app.request("/ping", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects 401 when token length differs (no length oracle leak)", async () => {
    const app = buildApp("good-token");
    const res = await app.request("/ping", {
      headers: { Authorization: "Bearer xx" },
    });
    expect(res.status).toBe(401);
  });

  it("passes through with valid Bearer", async () => {
    const app = buildApp("good-token");
    const res = await app.request("/ping", {
      headers: { Authorization: "Bearer good-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
