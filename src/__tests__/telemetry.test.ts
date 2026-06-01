import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildPayload,
  emit,
  emitConnectStart,
  ensureCorrelationId,
  isTelemetryEnabled,
  telemetryStatus,
  telemetryUrl,
} from "../telemetry.js";
import { loadConfig, saveConfig } from "../config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seanpropapp-tel-test-"));
});

afterEach(async () => {
  delete process.env["SEANPROPAPP_TELEMETRY_URL"];
  delete process.env["SEANPROPAPP_TELEMETRY"];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("telemetryUrl", () => {
  it("defaults to the prod endpoint", () => {
    expect(telemetryUrl()).toBe("https://prop.seanoneill.com/api/telemetry");
  });
  it("honors SEANPROPAPP_TELEMETRY_URL env", () => {
    process.env["SEANPROPAPP_TELEMETRY_URL"] = "https://example.test/t";
    expect(telemetryUrl()).toBe("https://example.test/t");
  });
  it("honors caller override", () => {
    expect(telemetryUrl("https://override")).toBe("https://override");
  });
});

describe("isTelemetryEnabled", () => {
  it("returns false on a fresh config (opt-in default)", async () => {
    const enabled = await isTelemetryEnabled({ configDir: tmpDir });
    expect(enabled).toBe(false);
  });
  it("returns true once user opts in", async () => {
    await saveConfig({ telemetry_enabled: true }, tmpDir);
    expect(await isTelemetryEnabled({ configDir: tmpDir })).toBe(true);
  });
  it("--no-telemetry equivalent forces off", async () => {
    await saveConfig({ telemetry_enabled: true }, tmpDir);
    expect(
      await isTelemetryEnabled({ configDir: tmpDir, forceDisable: true }),
    ).toBe(false);
  });
  it("env SEANPROPAPP_TELEMETRY=0 forces off", async () => {
    await saveConfig({ telemetry_enabled: true }, tmpDir);
    process.env["SEANPROPAPP_TELEMETRY"] = "0";
    expect(await isTelemetryEnabled({ configDir: tmpDir })).toBe(false);
  });
});

describe("ensureCorrelationId", () => {
  it("generates + persists a UUID on first call", async () => {
    const id1 = await ensureCorrelationId({ configDir: tmpDir });
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
    const cfg = await loadConfig(tmpDir);
    expect(cfg.correlation_id).toBe(id1);
  });
  it("reuses the same id on subsequent calls", async () => {
    const a = await ensureCorrelationId({ configDir: tmpDir });
    const b = await ensureCorrelationId({ configDir: tmpDir });
    expect(a).toBe(b);
  });
});

describe("buildPayload", () => {
  it("includes event, correlation id, cli version, os, node, ts", () => {
    const payload = buildPayload("cli_connect_start", "fake-uuid");
    expect(payload.event).toBe("cli_connect_start");
    expect(payload.correlation_id).toBe("fake-uuid");
    expect(payload.cli_version).toMatch(/\d+\.\d+\.\d+/);
    expect(payload.os).toMatch(/\//);
    expect(payload.node).toMatch(/^v/);
    expect(Date.parse(payload.ts)).toBeGreaterThan(0);
  });
});

describe("emit", () => {
  it("is a no-op (no fetch) when disabled", async () => {
    const fetchSpy = vi.fn();
    const res = await emit("cli_connect_start", {
      configDir: tmpDir,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("telemetry_disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("POSTs JSON to the configured URL when enabled", async () => {
    await saveConfig({ telemetry_enabled: true }, tmpDir);
    const fetchSpy = vi.fn(
      async () => new Response("ok", { status: 200 }),
    );
    const res = await emit("cli_pair_complete", {
      configDir: tmpDir,
      url: "https://example.test/t",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.sent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("https://example.test/t");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).event).toBe("cli_pair_complete");
  });
  it("swallows network errors and never throws", async () => {
    await saveConfig({ telemetry_enabled: true }, tmpDir);
    const fetchSpy = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await emit("cli_connect_start", {
      configDir: tmpDir,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/network/);
  });
  it("swallows HTTP errors", async () => {
    await saveConfig({ telemetry_enabled: true }, tmpDir);
    const fetchSpy = vi.fn(
      async () => new Response("nope", { status: 500 }),
    );
    const res = await emit("cli_connect_start", {
      configDir: tmpDir,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("http_500");
  });
  it("emitConnectStart is just a wrapper around emit", async () => {
    await saveConfig({ telemetry_enabled: true }, tmpDir);
    const fetchSpy = vi.fn(
      async () => new Response("ok", { status: 200 }),
    );
    const res = await emitConnectStart({
      configDir: tmpDir,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.sent).toBe(true);
    const body = JSON.parse(
      fetchSpy.mock.calls[0]?.[1]?.body as string,
    );
    expect(body.event).toBe("cli_connect_start");
  });
});

describe("telemetryStatus", () => {
  it("reports disabled + no correlation_id on a fresh config", async () => {
    const s = await telemetryStatus({ configDir: tmpDir });
    expect(s.enabled).toBe(false);
    expect(s.correlation_id).toBeUndefined();
    expect(s.url).toBe("https://prop.seanoneill.com/api/telemetry");
  });
});
