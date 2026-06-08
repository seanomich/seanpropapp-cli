import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { startServer, DEFAULT_BRIDGE_PORT } from "../server.js";
import type { RunningServer } from "../server.js";

const blockers: net.Server[] = [];
const running: RunningServer[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.close();
  }
  for (const b of blockers.splice(0)) {
    await new Promise<void>((resolve) => b.close(() => resolve()));
  }
});

function blockPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      blockers.push(srv);
      resolve();
    });
  });
}

describe("port fallback", () => {
  it("falls back to the next port when the requested port is busy", async () => {
    // Use a port the test controls (not the hardcoded default) so a real bridge
    // running on 17492 during local dev doesn't break this test.
    const base = 27600;
    await blockPort(base);
    const r = await startServer({ token: "tok", port: base });
    running.push(r);
    expect(r.port).toBe(base + 1);
  });

  it("uses the requested port when free", async () => {
    const r = await startServer({ token: "tok", port: 27492 });
    running.push(r);
    expect(r.port).toBe(27492);
  });

  it("binds within the default range when no port is requested", async () => {
    // Covers the default-port branch (startPort === DEFAULT_BRIDGE_PORT). Robust
    // whether or not 17492 is free: it binds the default or falls back upward.
    const r = await startServer({ token: "tok" });
    running.push(r);
    expect(r.port).toBeGreaterThanOrEqual(DEFAULT_BRIDGE_PORT);
    expect(r.port).toBeLessThanOrEqual(17500);
  });
});
