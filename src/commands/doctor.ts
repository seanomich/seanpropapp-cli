/**
 * `seanpropapp doctor`: self-diagnostic for the bridge + provider stack.
 *
 * Output is plain text with simple section headings, no emojis. Every WARN
 * or FAIL line is followed by an actionable suggestion. The check ordering
 * matches the typical first-run failure mode (no Claude CLI -> port taken ->
 * not paired yet).
 *
 * No secrets are ever printed; we only report token PRESENCE.
 */
import net from "node:net";
import os from "node:os";
import { detectAllProviders } from "../providers/index.js";
import {
  loadConfig,
  getConfigPath,
} from "../config.js";
import {
  DEFAULT_BRIDGE_PORT,
  MAX_PORT_FALLBACK,
} from "../http/server.js";
import { CLI_VERSION } from "../version.js";

export interface DoctorOptions {
  configDir?: string;
  /** Override fetch (used by tests). */
  fetchImpl?: typeof fetch;
  /** Override stdout writer (used by tests). */
  stdout?: (line: string) => void;
  /** Override provider detection (used by tests). */
  detectFn?: typeof detectAllProviders;
  /** Override the port-probe function (used by tests). */
  probePortFn?: (port: number) => Promise<boolean>;
  /** When true, emit a single JSON envelope instead of human-readable sections. */
  json?: boolean;
}

export interface DoctorResult {
  ok: boolean;
  sections: Record<string, string[]>;
}

/**
 * Returns true if the given local port can be bound (i.e., is free).
 * Honors a short timeout so the doctor doesn't stall.
 */
export function probePortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const cleanup = (ok: boolean) => {
      if (settled) return;
      settled = true;
      srv.removeAllListeners();
      srv.close(() => resolve(ok));
    };
    srv.once("error", () => cleanup(false));
    srv.once("listening", () => cleanup(true));
    try {
      srv.listen(port, "127.0.0.1");
    } catch {
      cleanup(false);
    }
    setTimeout(() => cleanup(false), 500);
  });
}

/**
 * Pretty-print a number as `Xm Ys` for paired_at deltas.
 */
function fmtAge(ms: number): string {
  if (ms < 0) return "in the future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export async function runDoctor(
  opts: DoctorOptions = {},
): Promise<DoctorResult> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const detectFn = opts.detectFn ?? detectAllProviders;
  const probePort = opts.probePortFn ?? probePortAvailable;
  const sections: Record<string, string[]> = {};
  let ok = true;

  function section(name: string, lines: string[]) {
    sections[name] = lines;
    out(`\n${name}\n`);
    for (const line of lines) out(`  ${line}\n`);
  }

  // 1. CLI + system.
  section("System", [
    `seanpropapp v${CLI_VERSION}`,
    `Node ${process.version} (${process.platform}/${process.arch})`,
    `Host: ${os.hostname()}`,
  ]);

  // 2. Providers.
  const providerLines: string[] = [];
  const detected = await detectFn();
  if (detected.claude.installed) {
    providerLines.push(
      `Claude CLI: detected${detected.claude.version ? ` (${detected.claude.version})` : ""}`,
    );
  } else {
    providerLines.push(
      `Claude CLI: NOT FOUND. Install with: brew install anthropic/claude/claude (macOS) or see https://claude.ai/cli`,
    );
    ok = false;
  }
  if (detected.codex.installed) {
    providerLines.push(
      `Codex CLI: detected${detected.codex.version ? ` (${detected.codex.version})` : ""}`,
    );
  } else {
    providerLines.push(`Codex CLI: not detected (optional)`);
  }
  if (!detected.gemini.installed) {
    providerLines.push(`Gemini CLI: not yet supported`);
  }
  section("Providers", providerLines);

  // 3. Port availability.
  const portLines: string[] = [];
  let firstFreePort: number | null = null;
  for (let p = DEFAULT_BRIDGE_PORT; p <= MAX_PORT_FALLBACK; p++) {
    const free = await probePort(p);
    portLines.push(`Port ${p}: ${free ? "free" : "in use"}`);
    if (free && firstFreePort === null) firstFreePort = p;
  }
  if (firstFreePort === null) {
    portLines.push(
      `WARN: every port in ${DEFAULT_BRIDGE_PORT}-${MAX_PORT_FALLBACK} is taken. Stop another process or pass --port to seanpropapp bridge.`,
    );
    ok = false;
  } else {
    portLines.push(`Next free port: ${firstFreePort}`);
  }
  section("Bridge ports", portLines);

  // 4. Config + pairing.
  const cfg = await loadConfig(opts.configDir);
  const configPath = getConfigPath(opts.configDir);
  const configLines: string[] = [`Config: ${configPath}`];
  if (cfg.pair_token) {
    configLines.push("Pair token: present (value redacted)");
  } else {
    configLines.push(
      "Pair token: MISSING. Run `seanpropapp connect` to generate one.",
    );
    ok = false;
  }
  if (cfg.mcp_token) {
    configLines.push("MCP token: present (value redacted)");
  } else {
    configLines.push("MCP token: missing (only needed for `seanpropapp mcp`)");
  }
  if (cfg.paired_at) {
    const parsed = Date.parse(cfg.paired_at);
    if (Number.isFinite(parsed)) {
      configLines.push(
        `Paired at: ${cfg.paired_at} (${fmtAge(Date.now() - parsed)})`,
      );
    } else {
      configLines.push(`Paired at: ${cfg.paired_at}`);
    }
  } else {
    configLines.push(
      "Paired at: never. Complete pairing in the browser via `seanpropapp connect`.",
    );
  }
  if (cfg.bridge_url) {
    configLines.push(`Bridge URL: ${cfg.bridge_url}`);
  }
  if (cfg.bridge_port) {
    configLines.push(`Bridge port: ${cfg.bridge_port}`);
  }
  if (
    cfg.telemetry_enabled === undefined ||
    cfg.telemetry_enabled === false
  ) {
    configLines.push("Telemetry: opt-in (off)");
  } else {
    configLines.push("Telemetry: opt-in (on)");
  }
  section("Config", configLines);

  // 5. Bridge health check.
  const healthLines: string[] = [];
  if (cfg.bridge_url && cfg.pair_token) {
    try {
      const url = `${cfg.bridge_url.replace(/\/$/, "")}/v1/handshake`;
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.pair_token}` },
      });
      if (res.ok) {
        healthLines.push(`Bridge reachable at ${url} (HTTP ${res.status})`);
      } else if (res.status === 401) {
        healthLines.push(
          `Bridge reachable but rejected the saved pair token (HTTP 401). Re-pair with: \`seanpropapp connect\``,
        );
        ok = false;
      } else {
        healthLines.push(
          `Bridge returned HTTP ${res.status} for ${url}. Restart with: \`seanpropapp connect\``,
        );
        ok = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      healthLines.push(
        `Bridge not reachable at ${cfg.bridge_url}: ${msg}. Try: \`seanpropapp connect\``,
      );
      ok = false;
    }
  } else {
    healthLines.push(
      "Bridge not configured. Run `seanpropapp connect` to start the bridge.",
    );
  }
  section("Bridge health", healthLines);

  // 6. Summary.
  if (opts.json) {
    // Drain anything we accumulated by replaying as a JSON envelope.
    // (We still printed the human sections above so JSON consumers piping
    // through `tee` see both; clean callers should pipe stdout-only.)
    out(`${JSON.stringify({ ok, sections })}\n`);
  } else {
    out(
      `\n${ok ? "All checks passed." : "Some checks failed. See suggestions above."}\n`,
    );
  }

  return { ok, sections };
}
