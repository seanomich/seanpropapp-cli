import { spawn } from "node:child_process";
import { which } from "../providers/detect-util.js";

export interface InstallGuidance {
  platform: NodeJS.Platform;
  /** Shell command we can run for an automated install (macOS Homebrew). */
  autoCommand?: { binary: string; args: string[]; label: string };
  /** Human-readable instructions to print when we can't or won't auto-install. */
  manualMessage: string;
}

/**
 * Produce OS-aware install guidance for Claude CLI. Persona A typically has
 * Claude Pro via the web app but not the CLI; this is the inline guided
 * install hook called by `connect`.
 */
export async function planClaudeInstall(): Promise<InstallGuidance> {
  if (process.platform === "darwin") {
    const brew = await which("brew");
    if (brew) {
      return {
        platform: "darwin",
        autoCommand: {
          binary: brew,
          args: ["install", "anthropic-ai/claude/claude"],
          label: "brew install anthropic-ai/claude/claude",
        },
        manualMessage:
          "Install Claude CLI via Homebrew: brew install anthropic-ai/claude/claude",
      };
    }
    return {
      platform: "darwin",
      manualMessage:
        "Install Homebrew (https://brew.sh) then run: brew install anthropic-ai/claude/claude",
    };
  }

  if (process.platform === "linux") {
    return {
      platform: "linux",
      manualMessage:
        "See https://claude.ai/cli for the install command for your distro " +
        "(apt, pacman, or curl-bash).",
    };
  }

  if (process.platform === "win32") {
    return {
      platform: "win32",
      manualMessage:
        "Install Claude CLI from https://claude.ai/cli, then re-run `seanpropapp connect`.",
    };
  }

  return {
    platform: process.platform,
    manualMessage:
      "See https://claude.ai/cli for install instructions on your platform.",
  };
}

/**
 * Spawn an interactive install command, piping its stdout/stderr to the
 * user's terminal. Resolves with the exit code.
 */
export function runInstall(
  binary: string,
  args: string[],
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: "inherit" });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
}
