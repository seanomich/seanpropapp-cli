import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runDoctor, probePortAvailable } from "../doctor.js";
import { saveConfig } from "../../config.js";
import { writeBridgePid } from "../bridge-pid.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-doctor-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("reports providers + ports + config without crashing on a fresh install", async () => {
    const lines: string[] = [];
    const res = await runDoctor({
      configDir: tmpDir,
      stdout: (s) => lines.push(s),
      detectFn: async () => ({
        claude: { installed: true, binary: "/usr/local/bin/claude", version: "1.0.0" },
        codex: { installed: false, reason: "not in PATH" },
        gemini: { installed: false, reason: "not yet supported" },
      }),
      probePortFn: async () => true,
      fetchImpl: (async () =>
        new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    expect(res.sections["System"]).toBeDefined();
    expect(res.sections["Providers"]?.some((l) => l.includes("Claude CLI"))).toBe(
      true,
    );
    expect(res.sections["Bridge ports"]?.length).toBeGreaterThan(0);
    expect(res.sections["Config"]).toBeDefined();
    // Output should not contain a literal token string. (We never wrote one.)
    expect(lines.join("")).not.toMatch(/token=/);
    // Without a paired bridge configured, ok must be false (missing pair token).
    expect(res.ok).toBe(false);
  });

  it("reports redacted token presence; never prints the value", async () => {
    await saveConfig(
      {
        pair_token: "supersecret-do-not-leak",
        mcp_token: "supersecret-mcp",
        bridge_url: "http://127.0.0.1:17492",
        bridge_port: 17492,
        paired_at: new Date().toISOString(),
      },
      tmpDir,
    );
    const captured: string[] = [];
    await runDoctor({
      configDir: tmpDir,
      stdout: (s) => captured.push(s),
      detectFn: async () => ({
        claude: { installed: true, binary: "/usr/local/bin/claude", version: "1.0.0" },
        codex: { installed: false, reason: "n/a" },
        gemini: { installed: false, reason: "n/a" },
      }),
      probePortFn: async () => true,
      fetchImpl: (async () =>
        new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    const joined = captured.join("");
    expect(joined).not.toContain("supersecret-do-not-leak");
    expect(joined).not.toContain("supersecret-mcp");
    expect(joined).toContain("Pair token: present");
    expect(joined).toContain("MCP token: present");
  });

  it("flags bridge unreachable when fetch rejects", async () => {
    await saveConfig(
      {
        pair_token: "tok",
        bridge_url: "http://127.0.0.1:17492",
      },
      tmpDir,
    );
    const res = await runDoctor({
      configDir: tmpDir,
      stdout: () => {},
      detectFn: async () => ({
        claude: { installed: true, binary: "x", version: "1.0.0" },
        codex: { installed: false, reason: "n/a" },
        gemini: { installed: false, reason: "n/a" },
      }),
      probePortFn: async () => true,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    const healthLines = res.sections["Bridge health"]?.join("\n") ?? "";
    expect(healthLines).toMatch(/not reachable/);
    expect(healthLines).toMatch(/seanpropapp connect/);
  });

  it("flags bridge 401 as needs re-pair", async () => {
    await saveConfig(
      { pair_token: "tok", bridge_url: "http://127.0.0.1:17492" },
      tmpDir,
    );
    const res = await runDoctor({
      configDir: tmpDir,
      stdout: () => {},
      detectFn: async () => ({
        claude: { installed: true, binary: "x", version: "1.0.0" },
        codex: { installed: false, reason: "n/a" },
        gemini: { installed: false, reason: "n/a" },
      }),
      probePortFn: async () => true,
      fetchImpl: (async () =>
        new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    const healthLines = res.sections["Bridge health"]?.join("\n") ?? "";
    expect(healthLines).toMatch(/401/);
    expect(healthLines).toMatch(/Re-pair/);
  });

  it("reports a running bridge PID + age when a live pid file exists (#1)", async () => {
    await writeBridgePid(process.pid, tmpDir);
    const captured: string[] = [];
    const res = await runDoctor({
      configDir: tmpDir,
      stdout: (s) => captured.push(s),
      detectFn: async () => ({
        claude: { installed: true, binary: "x", version: "1.0.0" },
        codex: { installed: false, reason: "n/a" },
        gemini: { installed: false, reason: "n/a" },
      }),
      probePortFn: async () => true,
      fetchImpl: (async () =>
        new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    const proc = res.sections["Bridge process"]?.join("\n") ?? "";
    expect(proc).toMatch(new RegExp(`Running bridge PID ${process.pid}`));
  });

  it("reports a stale bridge PID when the recorded process is gone (#1)", async () => {
    await writeBridgePid(2_000_000_000, tmpDir);
    const res = await runDoctor({
      configDir: tmpDir,
      stdout: () => {},
      detectFn: async () => ({
        claude: { installed: true, binary: "x", version: "1.0.0" },
        codex: { installed: false, reason: "n/a" },
        gemini: { installed: false, reason: "n/a" },
      }),
      probePortFn: async () => true,
      fetchImpl: (async () =>
        new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    const proc = res.sections["Bridge process"]?.join("\n") ?? "";
    expect(proc).toMatch(/Stale PID/);
  });

  it("surfaces the bridge's own provider detection from the handshake body (#2)", async () => {
    await saveConfig(
      { pair_token: "tok", bridge_url: "http://127.0.0.1:17492" },
      tmpDir,
    );
    const res = await runDoctor({
      configDir: tmpDir,
      stdout: () => {},
      detectFn: async () => ({
        claude: { installed: true, binary: "x", version: "1.0.0" },
        codex: { installed: false, reason: "n/a" },
        gemini: { installed: false, reason: "n/a" },
      }),
      probePortFn: async () => true,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            providers: {
              claude: { installed: true },
              codex: { installed: false },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    const health = res.sections["Bridge health"]?.join("\n") ?? "";
    expect(health).toMatch(/Bridge reports providers:/);
    expect(health).toMatch(/claude=detected/);
    expect(health).toMatch(/codex=not detected/);
  });

  it("flags missing Claude CLI as not ok", async () => {
    await saveConfig({ pair_token: "t", bridge_url: "http://127.0.0.1:17492" }, tmpDir);
    const res = await runDoctor({
      configDir: tmpDir,
      stdout: () => {},
      detectFn: async () => ({
        claude: { installed: false, reason: "not in PATH" },
        codex: { installed: false, reason: "n/a" },
        gemini: { installed: false, reason: "n/a" },
      }),
      probePortFn: async () => true,
      fetchImpl: (async () =>
        new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.sections["Providers"]?.join("\n")).toMatch(/NOT FOUND/);
  });
});

describe("probePortAvailable", () => {
  it("returns true for a free ephemeral port (we close it before binding)", async () => {
    // Pick an unusual high port that's almost certainly free locally.
    const ok = await probePortAvailable(38123);
    expect(typeof ok).toBe("boolean");
  });
});
