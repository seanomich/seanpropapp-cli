import openImport from "open";
import { ClaudeProvider } from "../providers/claude.js";
import { CodexProvider } from "../providers/codex.js";
import { detectAllProviders } from "../providers/index.js";
import type { Provider, ProviderDetectResult } from "../providers/base.js";
import { startServer } from "../http/server.js";
import { updateConfig, loadConfig } from "../config.js";
import {
  generatePairToken,
  osc8Link,
  pairUrl,
} from "./pair-url.js";
import { planClaudeInstall, runInstall } from "./install-claude.js";
import { confirm } from "./prompt.js";
import { spawnBackgroundBridge } from "./bridge.js";
import { emitConnectStart } from "../telemetry.js";

const HANDSHAKE_TIMEOUT_MS = 60_000;
const HANDSHAKE_POLL_MS = 1_000;
const SAMPLE_URL = "https://prop.seanoneill.com/workspace?sample=true";

export interface ConnectOptions {
  /** When true, the bridge runs in this process instead of being detached. */
  noBridgeFork?: boolean;
  /** Override the requested initial port. */
  port?: number;
  /** Override config dir. */
  configDir?: string;
  /**
   * Test seam: skip Y/N prompt + install. Always treats Claude as detected.
   * Tests use this so they don't depend on terminal input.
   */
  skipInstallPrompt?: boolean;
  /** Test seam: skip the browser launch. */
  skipBrowserOpen?: boolean;
  /** Test seam: provider override for detection in unit tests. */
  providers?: { claude?: Provider; codex?: Provider };
  /** Stdout writer override for tests. */
  stdout?: (line: string) => void;
  /** Stderr writer override for tests. */
  stderr?: (line: string) => void;
  /**
   * Test seam: skip the handshake wait loop and pretend the user paired
   * immediately at this timestamp.
   */
  fakePairedAt?: string;
  /** When true, suppress telemetry emit for this run (--no-telemetry). */
  noTelemetry?: boolean;
}

export interface ConnectResult {
  success: boolean;
  elapsedSeconds: number;
  bridgePort?: number;
  pairUrl?: string;
  reason?: string;
}

function fmtSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * Persona A entry point. Runs the full first-time flow:
 *  1. Detect Claude CLI; inline-guide install if missing.
 *  2. Generate pair token.
 *  3. Start bridge (background by default).
 *  4. Print clickable + plain-text pair URL (TX13).
 *  5. Open browser.
 *  6. Poll config for paired_at (set by bridge once /pair confirms).
 *  7. Print elapsed time + sample-analysis CTA on success (TX6).
 */
export async function runConnect(
  opts: ConnectOptions = {},
): Promise<ConnectResult> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const t0 = Date.now();

  // Fire-and-forget telemetry. Swallowed silently if disabled or offline.
  void emitConnectStart({
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
    ...(opts.noTelemetry ? { forceDisable: true } : {}),
  });

  // 1. Detect Claude CLI.
  out("Looking for Claude CLI on your system...\n");

  const claude = opts.providers?.claude ?? new ClaudeProvider();
  const codex = opts.providers?.codex ?? new CodexProvider();
  let detected: { claude: ProviderDetectResult; codex: ProviderDetectResult };
  if (opts.providers) {
    detected = {
      claude: await claude.detect(),
      codex: await codex.detect(),
    };
  } else {
    const all = await detectAllProviders();
    detected = { claude: all.claude, codex: all.codex };
  }

  if (!detected.claude.installed && !detected.codex.installed) {
    out("\n  Claude CLI not found.\n\n");
    out(
      "  SeanPropApp uses your Claude Pro subscription via the official Claude CLI.\n",
    );
    out("  You need to install it once.\n\n");

    const plan = await planClaudeInstall();
    if (plan.autoCommand && !opts.skipInstallPrompt) {
      out(`    ${plan.autoCommand.label}\n\n`);
      const yes = await confirm("  Install now? [Y/n] ");
      if (yes) {
        out("\n");
        const code = await runInstall(
          plan.autoCommand.binary,
          plan.autoCommand.args,
        );
        if (code !== 0) {
          err(
            `\n  Install failed (exit ${code ?? "unknown"}). See the output above and re-run \`seanpropapp connect\`.\n`,
          );
          return {
            success: false,
            elapsedSeconds: (Date.now() - t0) / 1000,
            reason: "install_failed",
          };
        }
        // Re-detect.
        const after = await claude.detect();
        detected.claude = after;
      } else {
        out(`\n  ${plan.manualMessage}\n`);
        out("  Re-run `seanpropapp connect` once Claude CLI is installed.\n");
        return {
          success: false,
          elapsedSeconds: (Date.now() - t0) / 1000,
          reason: "user_declined_install",
        };
      }
    } else {
      out(`  ${plan.manualMessage}\n`);
      out("  Re-run `seanpropapp connect` once Claude CLI is installed.\n");
      return {
        success: false,
        elapsedSeconds: (Date.now() - t0) / 1000,
        reason: "manual_install_required",
      };
    }
  }

  if (detected.claude.installed) {
    const v = detected.claude.version ? ` (${detected.claude.version})` : "";
    out(`  Claude CLI detected${v}\n`);
  }
  if (detected.codex.installed) {
    const v = detected.codex.version ? ` (${detected.codex.version})` : "";
    out(`  Codex CLI detected${v}\n`);
  }

  // 2. Generate pair token.
  const token = generatePairToken();

  // 3. Start bridge (background by default).
  let bridgePort: number;
  let stopInlineBridge: (() => Promise<void>) | undefined;

  if (opts.noBridgeFork) {
    const running = await startServer({
      token,
      port: opts.port,
      pairedAt: async () => {
        const cfg = await loadConfig(opts.configDir);
        return cfg.paired_at ?? null;
      },
    } as never);
    bridgePort = running.port;
    stopInlineBridge = () => running.close();
  } else {
    // Detached child. We still need to know what port it bound. Quick approach
    // for v1.4.0: bind here just long enough to claim the port, then close
    // and hand the port over to the child. This avoids a stdio handshake.
    const probe = await startServer({
      token,
      port: opts.port,
      pairedAt: () => null,
    });
    bridgePort = probe.port;
    await probe.close();
    await spawnBackgroundBridge({
      port: bridgePort,
      token,
      ...(opts.configDir ? { configDir: opts.configDir } : {}),
    });
  }

  await updateConfig(
    {
      pair_token: token,
      bridge_port: bridgePort,
      bridge_url: `http://127.0.0.1:${bridgePort}`,
    },
    opts.configDir,
  );

  out(`  Bridge ready on port ${bridgePort}\n`);

  // 4. Print pair URL: clickable + plain (TX13).
  const url = pairUrl(token);
  out(`\n  Pair URL: ${osc8Link(url, url)}\n`);
  out(`  Or paste in browser: ${url}\n`);

  // 5. Open browser.
  if (!opts.skipBrowserOpen) {
    try {
      // `open` is a default-export ESM module.
      await (openImport as unknown as (target: string) => Promise<unknown>)(url);
    } catch {
      // Non-fatal: the user can still paste the plain URL.
    }
  }

  out("\n  Waiting for you to confirm pairing in the browser...\n");

  // 6. Poll for paired_at.
  let paired = false;
  if (opts.fakePairedAt) {
    await updateConfig({ paired_at: opts.fakePairedAt }, opts.configDir);
    paired = true;
  } else {
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const cfg = await loadConfig(opts.configDir);
      if (cfg.paired_at) {
        paired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, HANDSHAKE_POLL_MS));
    }
  }

  if (!paired) {
    if (stopInlineBridge) await stopInlineBridge();
    err(
      "\n  Timed out waiting for pairing (60s).\n" +
        "  Either re-run `seanpropapp connect` or click the pair URL again.\n",
    );
    return {
      success: false,
      elapsedSeconds: (Date.now() - t0) / 1000,
      reason: "pair_timeout",
      bridgePort,
      pairUrl: url,
    };
  }

  // 7. Success.
  const elapsedMs = Date.now() - t0;
  out(
    `\n  Connected in ${fmtSeconds(elapsedMs)}s! Run a sample analysis at:\n` +
      `    ${SAMPLE_URL}\n\n` +
      "  Next time, just run `npx @seanpropapp/cli connect` to reconnect.\n",
  );

  // When in --no-bridge-fork mode, hand control to the inline server so it
  // keeps running until the user kills the process.
  if (stopInlineBridge) {
    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        await stopInlineBridge!();
        resolve();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  }

  return {
    success: true,
    elapsedSeconds: elapsedMs / 1000,
    bridgePort,
    pairUrl: url,
  };
}
