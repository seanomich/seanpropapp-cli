import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveMcpToken } from "../server.js";
import { saveConfig } from "../../config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-mcp-test-"));
});

afterEach(async () => {
  delete process.env["SEANPROPAPP_MCP_TOKEN"];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveMcpToken", () => {
  it("prefers SEANPROPAPP_MCP_TOKEN env when set", async () => {
    process.env["SEANPROPAPP_MCP_TOKEN"] = "env-token";
    await saveConfig({ mcp_token: "config-token" }, tmpDir);
    const result = await resolveMcpToken({ configDir: tmpDir });
    expect(result.token).toBe("env-token");
    expect(result.source).toBe("env");
  });

  it("falls back to config.mcp_token", async () => {
    await saveConfig({ mcp_token: "config-token" }, tmpDir);
    const result = await resolveMcpToken({ configDir: tmpDir });
    expect(result.token).toBe("config-token");
    expect(result.source).toBe("config");
  });

  it("trims whitespace tokens", async () => {
    await saveConfig({ mcp_token: "  trimmed  " }, tmpDir);
    const result = await resolveMcpToken({ configDir: tmpDir });
    expect(result.token).toBe("trimmed");
  });

  it("throws a helpful error when no token is found", async () => {
    await expect(resolveMcpToken({ configDir: tmpDir })).rejects.toThrow(
      /No MCP token found/,
    );
    await expect(resolveMcpToken({ configDir: tmpDir })).rejects.toThrow(
      /mcp-setup/,
    );
  });

  it("ignores empty env values and falls back to config", async () => {
    process.env["SEANPROPAPP_MCP_TOKEN"] = "   ";
    await saveConfig({ mcp_token: "config-token" }, tmpDir);
    const result = await resolveMcpToken({ configDir: tmpDir });
    expect(result.token).toBe("config-token");
    expect(result.source).toBe("config");
  });
});

describe("manifest", () => {
  it("exposes 17 user-runnable modules including SETUP", async () => {
    const { MODULES } = await import("../manifest.js");
    expect(MODULES.length).toBe(17);
    expect(MODULES.some((m) => m.id === "SETUP")).toBe(true);
    expect(MODULES.some((m) => m.id === "EXEC_SUMMARY")).toBe(true);
  });
});
