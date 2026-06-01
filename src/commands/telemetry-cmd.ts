/**
 * `seanpropapp telemetry enable|disable|status`.
 *
 * Persists the opt-in flag in `~/.seanpropapp/config.json`. The first time the
 * user enables, generates a correlation_id so subsequent emits have stable
 * identity.
 */
import { updateConfig } from "../config.js";
import {
  ensureCorrelationId,
  telemetryStatus,
} from "../telemetry.js";

export interface TelemetryCmdOptions {
  configDir?: string;
  stdout?: (line: string) => void;
  json?: boolean;
}

function emit(
  out: (s: string) => void,
  json: boolean,
  human: string,
  obj: Record<string, unknown>,
): void {
  if (json) {
    out(`${JSON.stringify(obj)}\n`);
  } else {
    out(`${human}\n`);
  }
}

export async function runTelemetryEnable(
  opts: TelemetryCmdOptions = {},
): Promise<void> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const tcfg: Parameters<typeof ensureCorrelationId>[0] = {};
  if (opts.configDir !== undefined) tcfg.configDir = opts.configDir;
  const correlationId = await ensureCorrelationId(tcfg);
  await updateConfig({ telemetry_enabled: true }, opts.configDir);
  emit(
    out,
    opts.json ?? false,
    `Telemetry enabled. Events will POST to https://prop.seanoneill.com/api/telemetry. See TELEMETRY.md for details.\nCorrelation id: ${correlationId}`,
    {
      ok: true,
      enabled: true,
      correlation_id: correlationId,
    },
  );
}

export async function runTelemetryDisable(
  opts: TelemetryCmdOptions = {},
): Promise<void> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  await updateConfig({ telemetry_enabled: false }, opts.configDir);
  emit(
    out,
    opts.json ?? false,
    "Telemetry disabled. No events will be sent. Your correlation id is kept so re-enabling later preserves history.",
    { ok: true, enabled: false },
  );
}

export async function runTelemetryStatus(
  opts: TelemetryCmdOptions = {},
): Promise<void> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const tcfg: Parameters<typeof telemetryStatus>[0] = {};
  if (opts.configDir !== undefined) tcfg.configDir = opts.configDir;
  const s = await telemetryStatus(tcfg);
  const human = [
    `Telemetry: ${s.enabled ? "on" : "off"}`,
    `URL: ${s.url}`,
    `OS: ${s.os}`,
    `Correlation id: ${s.correlation_id ?? "(not yet generated)"}`,
  ].join("\n");
  emit(out, opts.json ?? false, human, {
    enabled: s.enabled,
    url: s.url,
    os: s.os,
    correlation_id: s.correlation_id ?? null,
  });
}
