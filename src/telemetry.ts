/**
 * Opt-in CLI telemetry for the three TTHW events (TX7).
 *
 * Defaults to OFF: every emit returns immediately unless the user opts in
 * via `seanpropapp telemetry enable` (which sets `telemetry_enabled=true`
 * in config) or unless the SEANPROPAPP_TELEMETRY env var is set to "1".
 *
 * Network failures are swallowed silently. Telemetry must never block the
 * core flow (connect/pair/bridge).
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import { loadConfig, updateConfig } from "./config.js";
import { CLI_VERSION } from "./version.js";

export type CliTelemetryEvent =
  | "cli_connect_start"
  | "cli_pair_complete"
  | "cli_first_analysis_complete";

export interface TelemetryContext {
  configDir?: string;
  /** Override the receiving URL (used by tests + dev). */
  url?: string;
  /** Override fetch (used by tests). */
  fetchImpl?: typeof fetch;
  /** Force disable for a single emit (used by --no-telemetry). */
  forceDisable?: boolean;
}

export interface TelemetryPayload {
  event: CliTelemetryEvent;
  correlation_id: string;
  cli_version: string;
  os: string;
  node: string;
  ts: string;
}

const DEFAULT_URL = "https://prop.seanoneill.com/api/telemetry";

/**
 * Returns the URL the telemetry events POST to, honoring env override.
 */
export function telemetryUrl(override?: string): string {
  if (override) return override;
  const env = process.env["SEANPROPAPP_TELEMETRY_URL"];
  if (env) return env;
  return DEFAULT_URL;
}

/**
 * Returns true if telemetry should fire on this invocation.
 * Order: --no-telemetry > env > config.
 */
export async function isTelemetryEnabled(
  ctx: TelemetryContext = {},
): Promise<boolean> {
  if (ctx.forceDisable) return false;
  const env = process.env["SEANPROPAPP_TELEMETRY"];
  if (env === "0" || env?.toLowerCase() === "off") return false;
  const cfg = await loadConfig(ctx.configDir);
  return cfg.telemetry_enabled === true;
}

/**
 * Loads or generates a stable correlation id and persists it to config.
 * Even with telemetry disabled, the id is generated lazily on first opt-in.
 */
export async function ensureCorrelationId(
  ctx: TelemetryContext = {},
): Promise<string> {
  const cfg = await loadConfig(ctx.configDir);
  if (cfg.correlation_id) return cfg.correlation_id;
  const id = randomUUID();
  await updateConfig({ correlation_id: id }, ctx.configDir);
  return id;
}

/**
 * Build the JSON payload. Pure; no I/O.
 */
export function buildPayload(
  event: CliTelemetryEvent,
  correlationId: string,
): TelemetryPayload {
  return {
    event,
    correlation_id: correlationId,
    cli_version: CLI_VERSION,
    os: `${process.platform}/${process.arch}`,
    node: process.version,
    ts: new Date().toISOString(),
  };
}

/**
 * Emit a CLI telemetry event. No-op when telemetry is disabled. Network
 * failures are swallowed; the caller never blocks.
 */
export async function emit(
  event: CliTelemetryEvent,
  ctx: TelemetryContext = {},
): Promise<{ sent: boolean; reason?: string }> {
  if (!(await isTelemetryEnabled(ctx))) {
    return { sent: false, reason: "telemetry_disabled" };
  }
  const correlationId = await ensureCorrelationId(ctx);
  const payload = buildPayload(event, correlationId);
  const url = telemetryUrl(ctx.url);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { sent: false, reason: `http_${res.status}` };
    return { sent: true };
  } catch (err) {
    return {
      sent: false,
      reason: `network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Public wrappers so call sites read cleanly.
 */
export function emitConnectStart(
  ctx: TelemetryContext = {},
): Promise<{ sent: boolean; reason?: string }> {
  return emit("cli_connect_start", ctx);
}

export function emitPairComplete(
  ctx: TelemetryContext = {},
): Promise<{ sent: boolean; reason?: string }> {
  return emit("cli_pair_complete", ctx);
}

export function emitFirstAnalysisComplete(
  ctx: TelemetryContext = {},
): Promise<{ sent: boolean; reason?: string }> {
  return emit("cli_first_analysis_complete", ctx);
}

/**
 * Returns a short human-readable summary used by `seanpropapp telemetry status`.
 */
export async function telemetryStatus(
  ctx: TelemetryContext = {},
): Promise<{
  enabled: boolean;
  correlation_id: string | undefined;
  url: string;
  os: string;
}> {
  const cfg = await loadConfig(ctx.configDir);
  return {
    enabled: cfg.telemetry_enabled === true,
    correlation_id: cfg.correlation_id,
    url: telemetryUrl(ctx.url),
    os: `${process.platform}/${process.arch}/${os.release()}`,
  };
}
