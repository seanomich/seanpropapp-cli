import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reuseOrphanBridge } from "../orphan-bridge.js";
import { saveConfig, loadConfig } from "../../config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-orphan-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Fake monotonic clock so timeout loops advance without real delay. */
function fakeClock() {
  let clock = 0;
  return {
    nowFn: () => clock,
    sleepFn: async (ms: number) => {
      clock += ms;
    },
  };
}

/** Detect whether a fetch init carried an Authorization header. */
function hasAuth(init?: RequestInit): boolean {
  const h = init?.headers as Record<string, string> | undefined;
  return Boolean(h && h["Authorization"]);
}

describe("reuseOrphanBridge", () => {
  it("no pid file: spawn fresh, never touches any process (unknown-bridge / missing-pid case)", async () => {
    const kill = vi.fn();
    const result = await reuseOrphanBridge({
      token: "new-token",
      configDir: tmpDir,
      readPidFn: async () => null,
      killFn: kill,
    });
    expect(result).toEqual({ action: "spawn", reason: "no_pid_file" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("stale pid file (process gone): removes the pid file and spawns fresh", async () => {
    const removePid = vi.fn(async () => {});
    const kill = vi.fn();
    const result = await reuseOrphanBridge({
      token: "new-token",
      configDir: tmpDir,
      readPidFn: async () => 4242,
      isAliveFn: () => false,
      removePidFn: removePid,
      killFn: kill,
    });
    expect(result).toEqual({ action: "spawn", reason: "stale_pid" });
    expect(removePid).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("orphan alive + serving: rotates token, SIGHUPs, reuses the SAME port (no second spawn)", async () => {
    await saveConfig({ bridge_port: 17492, pair_token: "old-token" }, tmpDir);
    const kill = vi.fn();
    // Unauthenticated probe -> 401 (bridge is up); authed probe with new token
    // -> 200 (reload took effect).
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response("", { status: hasAuth(init) ? 200 : 401 });
    });

    const result = await reuseOrphanBridge({
      token: "new-token",
      configDir: tmpDir,
      readPidFn: async () => 4242,
      isAliveFn: () => true,
      killFn: kill,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ action: "reused", port: 17492 });
    expect(kill).toHaveBeenCalledWith(4242, "SIGHUP");
    expect(kill).not.toHaveBeenCalledWith(4242, "SIGTERM");
    // The rotated token is persisted so the SIGHUP reload picks it up.
    const cfg = await loadConfig(tmpDir);
    expect(cfg.pair_token).toBe("new-token");
  });

  it("alive pid but not serving on the recorded port: spawn fresh, never signals it", async () => {
    await saveConfig({ bridge_port: 17492 }, tmpDir);
    const kill = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await reuseOrphanBridge({
      token: "new-token",
      configDir: tmpDir,
      readPidFn: async () => 4242,
      isAliveFn: () => true,
      killFn: kill,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({
      action: "spawn",
      reason: "pid_alive_but_not_serving",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("reload never takes: SIGTERMs the bridge we own, waits for the port to free, spawns fresh", async () => {
    await saveConfig({ bridge_port: 17492 }, tmpDir);
    const clock = fakeClock();
    const kill = vi.fn();
    const removePid = vi.fn(async () => {});
    let killed = false;
    // Before SIGTERM: unauth->401, authed->401 (reload never accepted).
    // After SIGTERM: the port stops responding (null) so the free-wait exits.
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (killed && !hasAuth(init)) throw new Error("ECONNREFUSED");
      return new Response("", { status: 401 });
    });
    kill.mockImplementation((_pid: number, signal: string) => {
      if (signal === "SIGTERM") killed = true;
    });

    const result = await reuseOrphanBridge({
      token: "new-token",
      configDir: tmpDir,
      readPidFn: async () => 4242,
      isAliveFn: () => true,
      killFn: kill,
      removePidFn: removePid,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
      reloadTimeoutMs: 1000,
      freeTimeoutMs: 1000,
      pollMs: 100,
    });

    expect(result).toEqual({ action: "spawn", reason: "reload_failed_killed" });
    expect(kill).toHaveBeenCalledWith(4242, "SIGHUP");
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(removePid).toHaveBeenCalled();
  });
});
