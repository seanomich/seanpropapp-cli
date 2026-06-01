/**
 * `seanpropapp autostart install|uninstall`.
 *
 * macOS: writes a LaunchAgent plist + bootstraps it via `launchctl`.
 * Linux: writes a user systemd unit + enables it via `systemctl --user`.
 * Windows: prints the schtasks command (full Task Scheduler XML is deferred
 *          to v1.4.1; the printed command works for users who run it themselves).
 *
 * The command targets `seanpropapp bridge --foreground` so the OS supervisor
 * keeps the bridge alive across crashes / reboots.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const LAUNCHD_LABEL = "com.seanpropapp.bridge";
const SYSTEMD_UNIT = "seanpropapp-bridge.service";

export interface AutostartOptions {
  /** macOS / Linux / Windows; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Override the binary the supervisor invokes (used by tests). */
  binPath?: string;
  /** Override fs write/read (used by tests). */
  fsImpl?: typeof fs;
  /** Override spawn (used by tests). */
  spawnFn?: typeof spawn;
  /** Override stdout writer (used by tests). */
  stdout?: (line: string) => void;
  /** Override stderr writer (used by tests). */
  stderr?: (line: string) => void;
  /** Override $HOME (used by tests). */
  home?: string;
  /** Skip the launchctl / systemctl subprocess; useful in tests + dry-run. */
  dryRun?: boolean;
}

export type AutostartResult =
  | { ok: true; action: "install" | "uninstall"; path?: string; manual?: string[] }
  | { ok: false; reason: string };

function resolveBinPath(opts: AutostartOptions): string {
  if (opts.binPath) return opts.binPath;
  // Default: try to find seanpropapp on PATH. Fall back to a placeholder the
  // user must edit (this happens when someone runs autostart from a dev
  // checkout that hasn't been npm-linked).
  return "seanpropapp";
}

function macPlist(binPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
    <string>bridge</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/seanpropapp-bridge.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/seanpropapp-bridge.err.log</string>
</dict>
</plist>
`;
}

function systemdUnit(binPath: string): string {
  return `[Unit]
Description=SeanPropApp local bridge
After=network.target

[Service]
ExecStart=${binPath} bridge --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function runCmd(
  bin: string,
  args: string[],
  spawnFn: typeof spawn,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
    });
    child.once("close", (code) => resolve({ code, stderr }));
    child.once("error", (err) => resolve({ code: -1, stderr: err.message }));
  });
}

export async function installAutostart(
  opts: AutostartOptions = {},
): Promise<AutostartResult> {
  const platform = opts.platform ?? process.platform;
  const fsImpl = opts.fsImpl ?? fs;
  const spawnFn = opts.spawnFn ?? spawn;
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const home = opts.home ?? os.homedir();
  const bin = resolveBinPath(opts);

  if (platform === "darwin") {
    const plistDir = path.join(home, "Library", "LaunchAgents");
    const plistPath = path.join(plistDir, `${LAUNCHD_LABEL}.plist`);
    try {
      await fsImpl.mkdir(plistDir, { recursive: true });
      await fsImpl.writeFile(plistPath, macPlist(bin), { mode: 0o644 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`Could not write ${plistPath}: ${msg}\n`);
      return { ok: false, reason: msg };
    }
    out(`Wrote LaunchAgent: ${plistPath}\n`);
    if (opts.dryRun) {
      return { ok: true, action: "install", path: plistPath };
    }
    const uid = process.getuid?.() ?? 0;
    const cmd = await runCmd(
      "launchctl",
      ["bootstrap", `gui/${uid}`, plistPath],
      spawnFn,
    );
    if (cmd.code !== 0) {
      err(
        `launchctl bootstrap exited ${cmd.code}: ${cmd.stderr.trim() || "(no stderr)"}\n` +
          `If you see "service already loaded", run \`seanpropapp autostart uninstall\` first.\n`,
      );
      return { ok: false, reason: cmd.stderr || `exit ${cmd.code}` };
    }
    out(`Bootstrapped LaunchAgent ${LAUNCHD_LABEL}.\n`);
    return { ok: true, action: "install", path: plistPath };
  }

  if (platform === "linux") {
    const unitDir = path.join(home, ".config", "systemd", "user");
    const unitPath = path.join(unitDir, SYSTEMD_UNIT);
    try {
      await fsImpl.mkdir(unitDir, { recursive: true });
      await fsImpl.writeFile(unitPath, systemdUnit(bin), { mode: 0o644 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`Could not write ${unitPath}: ${msg}\n`);
      return { ok: false, reason: msg };
    }
    out(`Wrote systemd unit: ${unitPath}\n`);
    if (opts.dryRun) {
      return { ok: true, action: "install", path: unitPath };
    }
    const enable = await runCmd(
      "systemctl",
      ["--user", "enable", "--now", SYSTEMD_UNIT],
      spawnFn,
    );
    if (enable.code !== 0) {
      err(
        `systemctl --user exited ${enable.code}: ${enable.stderr.trim() || "(no stderr)"}\n` +
          `If you're on a server without lingering enabled, run: \`sudo loginctl enable-linger $USER\`\n`,
      );
      return { ok: false, reason: enable.stderr || `exit ${enable.code}` };
    }
    out(`Enabled ${SYSTEMD_UNIT}.\n`);
    return { ok: true, action: "install", path: unitPath };
  }

  if (platform === "win32") {
    // TODO v1.4.1: emit a Task Scheduler XML and import it via `schtasks /create /XML`.
    const cmd = `schtasks /create /SC ONLOGON /RL HIGHEST /TN "SeanPropApp Bridge" /TR "${bin} bridge --foreground"`;
    out(
      "Windows full auto-install is deferred to v1.4.1. Run this once to register the task:\n\n  " +
        cmd +
        "\n\nOr open Task Scheduler and create a new task pointing at the same command.\n",
    );
    return { ok: true, action: "install", manual: [cmd] };
  }

  err(`Unsupported platform: ${platform}\n`);
  return { ok: false, reason: `unsupported platform ${platform}` };
}

export async function uninstallAutostart(
  opts: AutostartOptions = {},
): Promise<AutostartResult> {
  const platform = opts.platform ?? process.platform;
  const fsImpl = opts.fsImpl ?? fs;
  const spawnFn = opts.spawnFn ?? spawn;
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const home = opts.home ?? os.homedir();

  if (platform === "darwin") {
    const plistPath = path.join(
      home,
      "Library",
      "LaunchAgents",
      `${LAUNCHD_LABEL}.plist`,
    );
    if (!opts.dryRun) {
      const uid = process.getuid?.() ?? 0;
      const cmd = await runCmd(
        "launchctl",
        ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`],
        spawnFn,
      );
      if (cmd.code !== 0 && !/No such process/i.test(cmd.stderr)) {
        err(`launchctl bootout warning (continuing): ${cmd.stderr.trim()}\n`);
      }
    }
    try {
      await fsImpl.unlink(plistPath);
      out(`Removed ${plistPath}\n`);
    } catch {
      out(`No plist at ${plistPath}; nothing to remove.\n`);
    }
    return { ok: true, action: "uninstall", path: plistPath };
  }

  if (platform === "linux") {
    const unitPath = path.join(
      home,
      ".config",
      "systemd",
      "user",
      SYSTEMD_UNIT,
    );
    if (!opts.dryRun) {
      await runCmd(
        "systemctl",
        ["--user", "disable", "--now", SYSTEMD_UNIT],
        spawnFn,
      );
    }
    try {
      await fsImpl.unlink(unitPath);
      out(`Removed ${unitPath}\n`);
    } catch {
      out(`No unit at ${unitPath}; nothing to remove.\n`);
    }
    return { ok: true, action: "uninstall", path: unitPath };
  }

  if (platform === "win32") {
    const cmd = 'schtasks /delete /TN "SeanPropApp Bridge" /F';
    out(
      "Windows uninstall is deferred to v1.4.1. Run this once to remove the task:\n\n  " +
        cmd +
        "\n",
    );
    return { ok: true, action: "uninstall", manual: [cmd] };
  }

  err(`Unsupported platform: ${platform}\n`);
  return { ok: false, reason: `unsupported platform ${platform}` };
}
