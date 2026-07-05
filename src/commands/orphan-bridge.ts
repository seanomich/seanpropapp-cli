/**
 * Orphan-bridge detection + reset (#1).
 *
 * `connect` calls this BEFORE it probes/spawns a bridge. When a prior `connect`
 * left a detached bridge running on the default port (terminal closed, parent
 * exited, child survived), spawning a second bridge would bind the next free
 * port with a FRESH token; the browser then hits 127.0.0.1:17492 (held by the
 * orphan) and gets a 401 because the orphan checks the new token against its
 * old one. That is the pairing "stuck in a loop" users reported.
 *
 * Strategy (preferred = keep the bridge alive):
 *   - No pid file            -> caller spawns fresh (nothing to reuse).
 *   - Pid recorded but dead  -> remove the stale pid file, caller spawns fresh.
 *   - Pid alive + serving    -> rotate the token in config, SIGHUP the bridge to
 *                               reload it, confirm the new token is accepted,
 *                               and reuse the same port. (Option B in #1.)
 *   - SIGHUP reload fails     -> SIGTERM the bridge we own, wait for the port to
 *                               free, caller spawns fresh. (Option A fallback.)
 *
 * All IO is injectable so the three regression scenarios can be tested without
 * real processes or sockets.
 */
import { loadConfig, updateConfig } from "../config.js";
import {
  readBridgePid,
  removeBridgePid,
  isProcessAlive,
} from "./bridge-pid.js";

export type ReuseAction =
  | { action: "reused"; port: number }
  | { action: "spawn"; reason: string };

export interface ReuseOrphanOptions {
  /** The freshly generated token connect wants the bridge to serve. */
  token: string;
  configDir?: string;
  fetchImpl?: typeof fetch;
  readPidFn?: (configDir?: string) => Promise<number | null>;
  isAliveFn?: (pid: number) => boolean;
  removePidFn?: (configDir?: string) => Promise<void>;
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  stderr?: (line: string) => void;
  /** Max time to wait for the SIGHUP token reload to take effect. */
  reloadTimeoutMs?: number;
  /** Max time to wait for the port to free after killing the orphan. */
  freeTimeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_RELOAD_TIMEOUT_MS = 3_000;
const DEFAULT_FREE_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_MS = 100;

/** Probe /v1/handshake. Returns the HTTP status, or null when unreachable. */
async function probeStatus(
  fetchImpl: typeof fetch,
  port: number,
  token?: string,
): Promise<number | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/v1/handshake`, {
      method: "GET",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
    return res.status;
  } catch {
    return null;
  }
}

export async function reuseOrphanBridge(
  opts: ReuseOrphanOptions,
): Promise<ReuseAction> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readPid = opts.readPidFn ?? readBridgePid;
  const isAlive = opts.isAliveFn ?? isProcessAlive;
  const removePid = opts.removePidFn ?? removeBridgePid;
  const kill =
    opts.killFn ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const now = opts.nowFn ?? (() => Date.now());
  const sleep =
    opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const err = opts.stderr ?? (() => {});
  const reloadTimeout = opts.reloadTimeoutMs ?? DEFAULT_RELOAD_TIMEOUT_MS;
  const freeTimeout = opts.freeTimeoutMs ?? DEFAULT_FREE_TIMEOUT_MS;
  const poll = opts.pollMs ?? DEFAULT_POLL_MS;

  const pid = await readPid(opts.configDir);
  if (pid === null) {
    // No bridge we own is recorded. If the port is nonetheless taken it belongs
    // to an unknown process; the caller's port fallback handles that safely.
    return { action: "spawn", reason: "no_pid_file" };
  }

  if (!isAlive(pid)) {
    // Stale pid file: the process is gone but the file survived. Clean it up.
    await removePid(opts.configDir);
    return { action: "spawn", reason: "stale_pid" };
  }

  const cfg = await loadConfig(opts.configDir);
  const port = cfg.bridge_port;
  if (!port) {
    // Alive pid but we never recorded its port; can't safely target it.
    return { action: "spawn", reason: "no_recorded_port" };
  }

  // Confirm the alive pid is actually serving the bridge on the recorded port
  // before we touch it (guards against OS pid reuse pointing at an unrelated
  // process). 200 or 401 both mean "a bridge is listening here".
  const status = await probeStatus(fetchImpl, port);
  if (status === null) {
    return { action: "spawn", reason: "pid_alive_but_not_serving" };
  }

  // Option B: rotate the token in shared config, then SIGHUP the bridge so it
  // reloads the token in-memory without dropping the listener.
  await updateConfig({ pair_token: opts.token }, opts.configDir);
  try {
    kill(pid, "SIGHUP");
  } catch {
    // Could not signal it (race: it just exited). Fall back to a fresh spawn.
    await removePid(opts.configDir);
    return { action: "spawn", reason: "sighup_failed" };
  }

  // Confirm the new token is accepted (200) within the reload window.
  const reloadDeadline = now() + reloadTimeout;
  while (now() < reloadDeadline) {
    const s = await probeStatus(fetchImpl, port, opts.token);
    if (s === 200) {
      return { action: "reused", port };
    }
    await sleep(poll);
  }

  // Option A fallback: reload never took. Terminate the bridge we own and wait
  // for the port to free so the caller can bind it fresh (not the next port).
  err(
    "  Running bridge did not accept the rotated token; restarting it.\n",
  );
  try {
    kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  await removePid(opts.configDir);

  const freeDeadline = now() + freeTimeout;
  while (now() < freeDeadline) {
    const s = await probeStatus(fetchImpl, port);
    if (s === null) break; // Port stopped responding: it is free (or freeing).
    await sleep(poll);
  }
  return { action: "spawn", reason: "reload_failed_killed" };
}
