import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPair } from "../pair.js";
import { loadConfig, saveConfig } from "../../config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-pair-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("pair command", () => {
  it("errors when bridge not running (no bridge_port in config)", async () => {
    process.exitCode = 0;
    await runPair({ configDir: tmpDir });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("generates a new token and writes it to config when bridge running", async () => {
    await saveConfig({ bridge_port: 17492, pair_token: "old-token" }, tmpDir);
    await runPair({ configDir: tmpDir });
    const cfg = await loadConfig(tmpDir);
    expect(cfg.pair_token).not.toBe("old-token");
    expect(cfg.pair_token).toMatch(/^[0-9a-f]{64}$/);
  });
});
