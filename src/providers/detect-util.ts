import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Cross-platform binary lookup. Returns absolute path or null.
 * Uses POSIX `which` / Windows `where`.
 */
export async function which(binary: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const child = spawn(cmd, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
      resolve(first?.trim() ?? null);
    });
  });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a binary with args, capturing stdout/stderr. Never throws.
 */
export async function runCapture(
  binary: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, opts.timeoutMs);
    }
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || String(err) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
