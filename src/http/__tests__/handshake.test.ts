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
});
