import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  runTelemetryDisable,
  runTelemetryEnable,
  runTelemetryStatus,
} from "../telemetry-cmd.js";
import { loadConfig } from "../../config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-telcmd-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("telemetry subcommand", () => {
  it("enable persists telemetry_enabled=true and a correlation_id", async () => {
    const lines: string[] = [];
    await runTelemetryEnable({
      configDir: tmpDir,
      stdout: (s) => lines.push(s),
    });
    const cfg = await loadConfig(tmpDir);
    expect(cfg.telemetry_enabled).toBe(true);
    expect(cfg.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.join("")).toMatch(/Telemetry enabled/);
  });

  it("disable persists telemetry_enabled=false and keeps the correlation_id", async () => {
    await runTelemetryEnable({ configDir: tmpDir, stdout: () => {} });
    const before = await loadConfig(tmpDir);
    await runTelemetryDisable({ configDir: tmpDir, stdout: () => {} });
    const after = await loadConfig(tmpDir);
    expect(after.telemetry_enabled).toBe(false);
    expect(after.correlation_id).toBe(before.correlation_id);
  });

  it("status reports off + (not yet generated) on a fresh config", async () => {
    const lines: string[] = [];
    await runTelemetryStatus({
      configDir: tmpDir,
      stdout: (s) => lines.push(s),
    });
    const out = lines.join("");
    expect(out).toMatch(/Telemetry: off/);
    expect(out).toMatch(/not yet generated/);
  });

  it("status reports on + the correlation id after enable", async () => {
    await runTelemetryEnable({ configDir: tmpDir, stdout: () => {} });
    const lines: string[] = [];
    await runTelemetryStatus({
      configDir: tmpDir,
      stdout: (s) => lines.push(s),
    });
    expect(lines.join("")).toMatch(/Telemetry: on/);
  });

  it("--json emits a single JSON envelope", async () => {
    const lines: string[] = [];
    await runTelemetryEnable({
      configDir: tmpDir,
      stdout: (s) => lines.push(s),
      json: true,
    });
    const obj = JSON.parse(lines.join(""));
    expect(obj.ok).toBe(true);
    expect(obj.enabled).toBe(true);
    expect(obj.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
