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
  it("falls back to next port when default is busy", async () => {
    await blockPort(DEFAULT_BRIDGE_PORT);
    const r = await startServer({ token: "tok" });
    running.push(r);
    expect(r.port).toBeGreaterThan(DEFAULT_BRIDGE_PORT);
    expect(r.port).toBeLessThanOrEqual(17500);
  });

  it("uses the requested port when free", async () => {
    // Pick a high port to avoid the default range.
    const r = await startServer({ token: "tok", port: 27492 });
    running.push(r);
    expect(r.port).toBe(27492);
  });
});
