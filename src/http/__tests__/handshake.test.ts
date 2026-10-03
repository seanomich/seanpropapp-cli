import { describe, it, expect } from "vitest";
import { createApp } from "../server.js";
import type { Provider } from "../../providers/base.js";

function fakeProvider(name: string, installed: boolean): Provider {
  return {
    name,
    detect: async () => ({
      installed,
      binary: installed ? `/usr/local/bin/${name}` : undefined,
      version: installed ? "1.0.0" : undefined,
      reason: installed ? undefined : "not installed",
    }),
    async *stream() {
      // no-op
    },
  };
}

describe("handshake", () => {
  it("returns version, providers, paired_at, device_name", async () => {
    const app = createApp({
      token: "tok",
      providers: {
        claude: fakeProvider("claude", true),
        codex: fakeProvider("codex", false),
      },
      pairedAt: () => "2026-06-01T00:00:00Z",
    });

    const res = await app.request("/v1/handshake", {
      headers: { Authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      providers: {
        claude: { installed: boolean; binary?: string };
        codex: { installed: boolean };
        gemini: { installed: boolean; reason?: string };
      };
      paired_at: string | null;
      device_name: string;
    };

    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.providers.claude.installed).toBe(true);
    expect(body.providers.claude.binary).toBe("/usr/local/bin/claude");
    expect(body.providers.codex.installed).toBe(false);
    expect(body.providers.gemini.installed).toBe(false);
    expect(body.providers.gemini.reason).toBeDefined();
    expect(body.paired_at).toBe("2026-06-01T00:00:00Z");
    expect(typeof body.device_name).toBe("string");
    expect(body.device_name.length).toBeGreaterThan(0);
  });

  it("returns paired_at null when not paired", async () => {
    const app = createApp({
      token: "tok",
      providers: {
        claude: fakeProvider("claude", false),
        codex: fakeProvider("codex", false),
      },
    });
    const res = await app.request("/v1/handshake", {
      headers: { Authorization: "Bearer tok" },
    });
    const body = (await res.json()) as { paired_at: string | null };
    expect(body.paired_at).toBeNull();
  });

  it("requires Bearer auth", async () => {
    const app = createApp({
      token: "tok",
      providers: {
        claude: fakeProvider("claude", true),
        codex: fakeProvider("codex", true),
      },
    });
    const res = await app.request("/v1/handshake");
    expect(res.status).toBe(401);
  });

  // #3: paired_at is recorded on the browser's pair confirmation only. The
  // browser is cross-origin (carries an Origin header that cleared CORS); the
  // parent's local healthcheck poll and doctor send no Origin.
  it("fires onBrowserPair when the handshake carries an allowed Origin", async () => {
    let pairs = 0;
    const app = createApp({
      token: "tok",
      providers: { claude: fakeProvider("claude", true) },
      onBrowserPair: () => {
        pairs += 1;
      },
    });
    const res = await app.request("/v1/handshake", {
      headers: {
        Authorization: "Bearer tok",
        Origin: "https://seanpropapp.com",
      },
    });
    expect(res.status).toBe(200);
    expect(pairs).toBe(1);
  });

  it("does NOT fire onBrowserPair for a local (no-Origin) healthcheck", async () => {
    let pairs = 0;
    const app = createApp({
      token: "tok",
      providers: { claude: fakeProvider("claude", true) },
      onBrowserPair: () => {
        pairs += 1;
      },
    });
    const res = await app.request("/v1/handshake", {
      headers: { Authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    expect(pairs).toBe(0);
  });

  // #2: detection runs at REQUEST time, so a provider that becomes installed
  // after the server was constructed is still reported as installed.
  it("reflects provider detection at request time, not server-start time", async () => {
    let installed = false;
    const flakyProvider: Provider = {
      name: "claude",
      detect: async () => ({
        installed,
        binary: installed ? "/usr/local/bin/claude" : undefined,
      }),
      async *stream() {
        // no-op
      },
    };
    const app = createApp({ token: "tok", providers: { claude: flakyProvider } });

    const before = (await (
      await app.request("/v1/handshake", {
        headers: { Authorization: "Bearer tok" },
      })
    ).json()) as { providers: { claude: { installed: boolean } } };
    expect(before.providers.claude.installed).toBe(false);

    // Simulate the CLI being installed AFTER the bridge started.
    installed = true;
    const after = (await (
      await app.request("/v1/handshake", {
        headers: { Authorization: "Bearer tok" },
      })
    ).json()) as { providers: { claude: { installed: boolean } } };
    expect(after.providers.claude.installed).toBe(true);
  });
});
