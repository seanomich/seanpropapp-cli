import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bridgePidPath,
  writeBridgePid,
  readBridgePid,
  removeBridgePid,
  bridgePidAgeMs,
  isProcessAlive,
} from "../bridge-pid.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-pid-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("bridge-pid", () => {
  it("writes then reads back the pid", async () => {
    await writeBridgePid(4242, tmpDir);
    expect(await readBridgePid(tmpDir)).toBe(4242);
    expect(bridgePidPath(tmpDir)).toBe(path.join(tmpDir, "bridge.pid"));
  });

  it("returns null when no pid file exists", async () => {
    expect(await readBridgePid(tmpDir)).toBeNull();
    expect(await bridgePidAgeMs(tmpDir)).toBeNull();
  });

  it("returns null for a corrupt pid file", async () => {
    await fs.writeFile(bridgePidPath(tmpDir), "not-a-number\n");
    expect(await readBridgePid(tmpDir)).toBeNull();
  });

  it("remove is idempotent and clears the file", async () => {
    await writeBridgePid(1, tmpDir);
    await removeBridgePid(tmpDir);
    expect(await readBridgePid(tmpDir)).toBeNull();
    // Second remove on an already-absent file must not throw.
    await removeBridgePid(tmpDir);
  });

  it("reports a non-negative age once written", async () => {
    await writeBridgePid(9, tmpDir);
    const age = await bridgePidAgeMs(tmpDir);
    expect(age).not.toBeNull();
    expect(age as number).toBeGreaterThanOrEqual(0);
  });

  it("isProcessAlive is true for this process and false for an unused pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // PID 1 always exists; use a very high pid unlikely to be allocated.
    expect(isProcessAlive(2_000_000_000)).toBe(false);
  });
});
