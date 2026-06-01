import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runConnect } from "../connect.js";
import { loadConfig } from "../../config.js";
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
    expect(result.pairUrl).toMatch(/prop\.seanoneill\.com\/pair#t=/);

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
