import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runConnect } from "../connect.js";
import { loadConfig, saveConfig } from "../../config.js";
import type { Provider } from "../../providers/base.js";

let tmpDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-connect-"));
  stdout = [];
  stderr = [];
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeProvider(name: string, installed: boolean): Provider {
  return {
    name,
    detect: async () => ({
      installed,
      binary: installed ? `/usr/local/bin/${name}` : undefined,
      version: installed ? "1.0.0" : undefined,
      reason: installed ? undefined : "not found",
    }),
    async *stream() {
      // no-op
    },
  };
}

describe("connect command", () => {
  it("happy path: detected Claude → bridge starts → paired → elapsed printed", async () => {
    // Pick a high port to avoid conflicts with anything running locally.
    const port = 28492 + Math.floor(Math.random() * 100);
    const result = await runConnect({
      configDir: tmpDir,
      port,
      noBridgeFork: false, // we'll override below via probe-only path
      skipInstallPrompt: true,
      skipBrowserOpen: true,
      skipBridgeHealthcheck: true,
      providers: {
        claude: fakeProvider("claude", true),
        codex: fakeProvider("codex", false),
      },
      fakePairedAt: "2026-06-01T12:00:00Z",
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    });

    expect(result.success).toBe(true);
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(result.pairUrl).toMatch(/seanpropapp\.com\/pair#t=/);

    // Config should now hold the pair token + bridge port + paired_at.
    const cfg = await loadConfig(tmpDir);
    expect(cfg.pair_token).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.bridge_port).toBe(result.bridgePort);
    expect(cfg.paired_at).toBe("2026-06-01T12:00:00Z");

    // Output should mention "Connected in" + sample analysis URL.
    const out = stdout.join("");
    expect(out).toMatch(/Connected in [\d.]+s/);
    expect(out).toContain("workspace?sample=true");
    expect(out).toContain("Or paste in browser:");
  });

  it("ignores a STALE paired_at from a prior session and times out with non-misleading copy (#3)", async () => {
    // A previous session left paired_at in config. A new connect must NOT treat
    // it as this run's pairing, and the timeout copy must not tell the user to
    // re-run connect (which would spawn a duplicate bridge, #1).
    await saveConfig({ paired_at: "2020-01-01T00:00:00Z" }, tmpDir);
    const port = 28692 + Math.floor(Math.random() * 100);
    const result = await runConnect({
      configDir: tmpDir,
      port,
      skipInstallPrompt: true,
      skipBrowserOpen: true,
      skipBridgeHealthcheck: true,
      handshakeTimeoutMs: 40,
      handshakePollMs: 10,
      providers: {
        claude: fakeProvider("claude", true),
        codex: fakeProvider("codex", false),
      },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("pair_timeout");
    const errOut = stderr.join("");
    expect(errOut).toMatch(/doctor/);
    expect(errOut).not.toMatch(/re-run/i);
  });

  it("missing Claude CLI + skipInstallPrompt + manual fallback exits non-success", async () => {
    const result = await runConnect({
      configDir: tmpDir,
      skipInstallPrompt: true,
      skipBrowserOpen: true,
      providers: {
        claude: fakeProvider("claude", false),
        codex: fakeProvider("codex", false),
      },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    });
    expect(result.success).toBe(false);
    expect(result.reason).toBe("manual_install_required");
    const out = stdout.join("");
    expect(out).toMatch(/Claude CLI not found/i);
  });
});
