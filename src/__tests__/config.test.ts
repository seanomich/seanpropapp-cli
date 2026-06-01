import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureConfigDir,
  getConfigDir,
  getConfigPath,
  loadConfig,
  saveConfig,
  updateConfig,
} from "../config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-cli-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("config", () => {
  it("getConfigDir returns override when given", () => {
    expect(getConfigDir(tmpDir)).toBe(tmpDir);
  });

  it("getConfigPath uses override + config.json", () => {
    expect(getConfigPath(tmpDir)).toBe(path.join(tmpDir, "config.json"));
  });

  it("ensureConfigDir creates the directory", async () => {
    const sub = path.join(tmpDir, "nested");
    await ensureConfigDir(sub);
    const stat = await fs.stat(sub);
    expect(stat.isDirectory()).toBe(true);
  });

  it("loadConfig returns empty object when file missing", async () => {
    const cfg = await loadConfig(tmpDir);
    expect(cfg).toEqual({});
  });

  it("saveConfig + loadConfig round trip", async () => {
    await saveConfig({ pair_token: "abc", bridge_port: 17492 }, tmpDir);
    const cfg = await loadConfig(tmpDir);
    expect(cfg.pair_token).toBe("abc");
    expect(cfg.bridge_port).toBe(17492);
  });

  it("saveConfig writes with mode 0600 on POSIX", async () => {
    await saveConfig({ pair_token: "secret" }, tmpDir);
    const filePath = getConfigPath(tmpDir);
    const stat = await fs.stat(filePath);
    if (process.platform !== "win32") {
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("loadConfig returns empty on corrupt JSON", async () => {
    await ensureConfigDir(tmpDir);
    await fs.writeFile(getConfigPath(tmpDir), "{ not valid json");
    const cfg = await loadConfig(tmpDir);
    expect(cfg).toEqual({});
  });

  it("loadConfig returns empty on schema-invalid JSON", async () => {
    await ensureConfigDir(tmpDir);
    await fs.writeFile(
      getConfigPath(tmpDir),
      JSON.stringify({ bridge_port: "not-a-number" }),
    );
    const cfg = await loadConfig(tmpDir);
    expect(cfg).toEqual({});
  });

  it("updateConfig merges over existing", async () => {
    await saveConfig({ pair_token: "abc", bridge_port: 17492 }, tmpDir);
    const next = await updateConfig({ paired_at: "2026-06-01T00:00:00Z" }, tmpDir);
    expect(next.pair_token).toBe("abc");
    expect(next.bridge_port).toBe(17492);
    expect(next.paired_at).toBe("2026-06-01T00:00:00Z");
  });
});
