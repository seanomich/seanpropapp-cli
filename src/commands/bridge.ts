import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startServer } from "../http/server.js";
import { generatePairToken } from "./pair-url.js";
import { loadConfig, updateConfig, getConfigPath } from "../config.js";

const HEALTHCHECK_TIMEOUT_MS = 3_000;
const HEALTHCHECK_POLL_MS = 100;

export interface BridgeRunOptions {
  port?: number;
  foreground?: boolean;
  /** When true (the default), reuse a token from config; otherwise generate. */
  reuseToken?: boolean;
  /** Override config dir (used by tests). */
  configDir?: string;
  /** Pre-supplied token (used by `connect` which generates it first). */
  token?: string;
}

/**
 * Foreground bridge: bind the HTTP server and stay alive until interrupted.
 *
 * Listens for SIGHUP and reloads the pair token from disk so `seanpropapp pair`
 * can rotate the token without restarting the bridge. SIGINT / SIGTERM trigger
 * a clean shutdown.
 */
export async function runBridgeForeground(
  opts: BridgeRunOptions,
): Promise<void> {
  const cfg = await loadConfig(opts.configDir);
  let currentToken =
    opts.token ??
    (opts.reuseToken && cfg.pair_token ? cfg.pair_token : generatePairToken());
  let currentPairedAt = cfg.paired_at ?? null;

  const running = await startServer({
    token: () => currentToken,
    port: opts.port,
    pairedAt: () => currentPairedAt,
  });

  await updateConfig(
    {
      pair_token: currentToken,
      bridge_url: running.url,
      bridge_port: running.port,
    },
    opts.configDir,
  );

  process.stdout.write(`Bridge ready on port ${running.port}\n`);
  process.stdout.write(`URL: ${running.url}\n`);
  process.stdout.write(`Config: ${getConfigPath(opts.configDir)}\n`);
  process.stdout.write("Press Ctrl-C to stop.\n");

  const reloadOnSighup = async () => {
    try {
      const next = await loadConfig(opts.configDir);
      if (next.pair_token && next.pair_token !== currentToken) {
        currentToken = next.pair_token;
        process.stdout.write("SIGHUP: reloaded pair token from config.\n");
      } else {
        process.stdout.write(
          "SIGHUP: no token change in config; bridge token unchanged.\n",
        );
      }
      if (next.paired_at && next.paired_at !== currentPairedAt) {
        currentPairedAt = next.paired_at;
      }
    } catch (err) {
      process.stderr.write(
        `SIGHUP: failed to reload config: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };
  process.on("SIGHUP", reloadOnSighup);

  // Keep alive until SIGINT / SIGTERM.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      process.off("SIGHUP", reloadOnSighup);
      await running.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/**
 * Probe the bridge's /v1/handshake endpoint, returning true if the server
 * is reachable. Used by the post-spawn health check.
 */
async function pingHandshake(
  port: number,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/v1/handshake`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok || res.status === 401; // 401 still means "server is up".
  } catch {
    return false;
  }
}

/**
 * Poll the bridge until it responds, or the timeout elapses. Returns true
 * when reachable.
 */
export async function waitForBridge(
  port: number,
  token: string,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    fetchImpl?: typeof fetch;
    nowFn?: () => number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const now = opts.nowFn ?? (() => Date.now());
  const sleep =
    opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = opts.timeoutMs ?? HEALTHCHECK_TIMEOUT_MS;
  const poll = opts.pollMs ?? HEALTHCHECK_POLL_MS;
  const deadline = now() + timeout;
  while (now() < deadline) {
    if (await pingHandshake(port, token, fetchImpl)) return true;
    await sleep(poll);
  }
  return false;
}

/**
 * Spawn the current CLI binary in foreground mode as a detached child so the
 * parent process can return immediately. Used by `connect`.
 *
 * After spawning, polls /v1/handshake every 100ms for up to 3s to confirm
 * the child actually bound the port. Lane C-Core's probe-bind-close-then-spawn
 * dance has a sub-second race window we close here.
 *
 * Returns the child's PID + whether the post-spawn handshake succeeded.
 * If `requireHealthy` is true (the default), throws when the handshake never
 * comes up so the caller can fail fast with a clear error.
 */
export async function spawnBackgroundBridge(opts: {
  port?: number;
  token: string;
  configDir?: string;
  requireHealthy?: boolean;
  /** Test seam: skip the post-spawn poll entirely. */
  skipHealthcheck?: boolean;
  /** Test seam: override fetch used by the post-spawn poll. */
  fetchImpl?: typeof fetch;
}): Promise<{ pid: number | undefined; healthy: boolean }> {
  // Resolve the path to our own CLI entrypoint. When installed via npm, this
  // file lives at dist/commands/bridge.js, and the entry binary is dist/index.js.
  const here = fileURLToPath(import.meta.url);
  const entry = path.resolve(path.dirname(here), "..", "index.js");

  const args = ["bridge", "--foreground", "--no-token-rotation"];
  if (opts.port) args.push("--port", String(opts.port));
  if (opts.configDir) args.push("--config", opts.configDir);

  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SEANPROPAPP_PRESEED_TOKEN: opts.token,
    },
  });
  child.unref();

  if (opts.skipHealthcheck || !opts.port) {
    // Without a known port, the parent can't probe; the caller (connect.ts)
    // bound + closed the port itself, so it can fall back to its own check.
    return { pid: child.pid, healthy: false };
  }

  const healthOpts: Parameters<typeof waitForBridge>[2] = {};
  if (opts.fetchImpl) healthOpts.fetchImpl = opts.fetchImpl;
  const healthy = await waitForBridge(opts.port, opts.token, healthOpts);
  if (!healthy && opts.requireHealthy !== false) {
    throw new Error(
      `Bridge process spawned (pid ${child.pid ?? "unknown"}) but did not become reachable on port ${opts.port} within ${HEALTHCHECK_TIMEOUT_MS}ms. ` +
        "Run `seanpropapp doctor` to inspect, or try `seanpropapp bridge --foreground` to see the bridge's own stderr.",
    );
  }
  return { pid: child.pid, healthy };
}
