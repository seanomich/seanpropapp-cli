import { describe, it, expect, vi } from "vitest";
import { waitForBridge } from "../bridge.js";

describe("waitForBridge", () => {
  it("returns true on the first ok response", async () => {
    const fetchSpy = vi.fn(
      async () => new Response("ok", { status: 200 }),
    );
    const ok = await waitForBridge(17492, "tok", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
      timeoutMs: 100,
      pollMs: 10,
    });
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0]!;
    expect(firstCall[0]).toContain("/v1/handshake");
  });

  it("treats 401 as 'server up' (auth fail is still alive)", async () => {
    const fetchSpy = vi.fn(
      async () => new Response("nope", { status: 401 }),
    );
    const ok = await waitForBridge(17492, "tok", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
      timeoutMs: 100,
      pollMs: 10,
    });
    expect(ok).toBe(true);
  });

  it("polls until success", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return new Response("ok", { status: 200 });
    });
    const ok = await waitForBridge(17492, "tok", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
      timeoutMs: 500,
      pollMs: 5,
    });
    expect(ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("returns false when timeout elapses", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const ok = await waitForBridge(17492, "tok", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
      timeoutMs: 30,
      pollMs: 10,
    });
    expect(ok).toBe(false);
  });
});
