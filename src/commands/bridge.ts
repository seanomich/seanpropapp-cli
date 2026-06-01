import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startServer } from "../http/server.js";
import { generatePairToken } from "./pair-url.js";
import { loadConfig, updateConfig, getConfigPath } from "../config.js";

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
 */
export async function runBridgeForeground(
  opts: BridgeRunOptions,
): Promise<void> {
  const cfg = await loadConfig(opts.configDir);
  const token =
    opts.token ??
    (opts.reuseToken && cfg.pair_token ? cfg.pair_token : generatePairToken());

  const running = await startServer({
    token,
    port: opts.port,
    pairedAt: () => cfg.paired_at ?? null,
  });

  await updateConfig(
    {
      pair_token: token,
      bridge_url: running.url,
      bridge_port: running.port,
    },
    opts.configDir,
  );

  process.stdout.write(`Bridge ready on port ${running.port}\n`);
  process.stdout.write(`URL: ${running.url}\n`);
  process.stdout.write(`Config: ${getConfigPath(opts.configDir)}\n`);
  process.stdout.write("Press Ctrl-C to stop.\n");

  // Keep alive until SIGINT / SIGTERM.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await running.close();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/**
 * Spawn the current CLI binary in foreground mode as a detached child so the
 * parent process can return immediately. Used by `connect`.
 *
 * Returns the child's PID. The child writes its own status to stdout — we
 * don't pipe it back to the parent because the parent has its own output.
 */
export async function spawnBackgroundBridge(opts: {
  port?: number;
  token: string;
  configDir?: string;
}): Promise<{ pid: number | undefined }> {
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
  return { pid: child.pid };
}
