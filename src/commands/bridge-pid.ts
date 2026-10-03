/**
 * Bridge PID file helpers (#1).
 *
 * The foreground bridge records its own PID to `<configDir>/bridge.pid` on
 * start and removes the file on graceful shutdown. `connect` reads this file to
 * decide whether a running (possibly orphaned) bridge already exists before it
 * spawns a new one, so a leftover detached bridge is reused/reset instead of a
 * second bridge being spawned on the next free port with a fresh token.
 *
 * The file holds only the integer PID (conventional `.pid` format). Age is
 * derived from the file's mtime so `doctor` can report how long the bridge has
 * been running without a second timestamp source of truth.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getConfigDir, ensureConfigDir } from "../config.js";

const PID_FILE_NAME = "bridge.pid";

export function bridgePidPath(configDir?: string): string {
  return path.join(getConfigDir(configDir), PID_FILE_NAME);
}

/** Write the current (or given) PID to the bridge PID file. */
export async function writeBridgePid(
  pid: number,
  configDir?: string,
): Promise<void> {
  await ensureConfigDir(configDir);
  await fs.writeFile(bridgePidPath(configDir), `${pid}\n`, { mode: 0o600 });
}

/** Read the recorded bridge PID, or null when the file is absent/unreadable. */
export async function readBridgePid(configDir?: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.readFile(bridgePidPath(configDir), "utf8");
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Remove the bridge PID file. Never throws (absent file is fine). */
export async function removeBridgePid(configDir?: string): Promise<void> {
  try {
    await fs.rm(bridgePidPath(configDir), { force: true });
  } catch {
    // Best-effort: a missing or unremovable pid file is non-fatal.
  }
}

/** Age of the bridge PID file in ms (from mtime), or null when absent. */
export async function bridgePidAgeMs(configDir?: string): Promise<number | null> {
  try {
    const stat = await fs.stat(bridgePidPath(configDir));
    // Clamp at 0: filesystem mtime precision can read microscopically ahead of
    // Date.now(), which would otherwise yield a nonsensical negative age.
    return Math.max(0, Date.now() - stat.mtimeMs);
  } catch {
    return null;
  }
}

/**
 * True when a process with the given PID currently exists and is signalable by
 * this user. Uses signal 0 (the POSIX "does this process exist?" probe), which
 * never actually delivers a signal.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it (still "alive").
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
