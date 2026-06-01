#!/usr/bin/env node
import { Command, Option } from "commander";
import { CLI_VERSION } from "./version.js";
import { runConnect } from "./commands/connect.js";
import { runPair } from "./commands/pair.js";
import { runBridgeForeground, spawnBackgroundBridge } from "./commands/bridge.js";
import { loadConfig, updateConfig } from "./config.js";
import { runMcpCommand } from "./commands/mcp.js";
import { runDoctor } from "./commands/doctor.js";
import { installAutostart, uninstallAutostart } from "./commands/autostart.js";

const HELP_AFTER = `
Usage: seanpropapp <command>

Run SeanPropApp on your existing Claude Pro or ChatGPT Plus subscription.

Commands:
  connect    Start everything and pair with your browser (use this first)
  bridge     Run the bridge server explicitly
  pair       Generate a new pair URL
  mcp        Run as MCP stdio server (Claude Desktop, Cursor)
  doctor     Self-diagnostic
  autostart  Install OS-native auto-start

Global flags:
  --config <path>   Use custom config dir (default: ~/.seanpropapp/)
  --quiet           Suppress non-error output
  --json            Structured output for tooling
  --verbose         Debug-level diagnostics

Quick start: npx @seanpropapp/cli connect
`;

interface GlobalOptionsShape {
  config?: string;
  quiet?: boolean;
  json?: boolean;
  verbose?: boolean;
  telemetry?: boolean;
}

function getGlobalOpts(cmd: Command): GlobalOptionsShape {
  // Commander stores global opts on the root program. Walk up to find it.
  let cur: Command = cmd;
  while (cur.parent) cur = cur.parent;
  return cur.opts() as GlobalOptionsShape;
}

const program = new Command();

program
  .name("seanpropapp")
  .description(
    "Run SeanPropApp on your existing Claude Pro or ChatGPT Plus subscription.",
  )
  .version(CLI_VERSION)
  .addOption(
    new Option("--config <path>", "Use custom config dir").default(
      undefined,
      "~/.seanpropapp/",
    ),
  )
  .addOption(new Option("--quiet", "Suppress non-error output"))
  .addOption(new Option("--json", "Structured output for tooling"))
  .addOption(new Option("--verbose", "Debug-level diagnostics"))
  .addOption(
    new Option("--no-telemetry", "Suppress opt-in telemetry for this invocation"),
  )
  .addHelpText("after", HELP_AFTER);

program
  .command("connect")
  .description("Start everything and pair with your browser (use this first)")
  .option("--port <n>", "Override the starting bridge port", (v) => Number(v))
  .option("--no-bridge-fork", "Run the bridge inline instead of detaching it")
  .action(async (opts: { port?: number; bridgeFork: boolean }, cmd: Command) => {
    const g = getGlobalOpts(cmd);
    const connectOpts: Parameters<typeof runConnect>[0] = {};
    if (g.config !== undefined) connectOpts.configDir = g.config;
    if (opts.port !== undefined) connectOpts.port = opts.port;
    if (opts.bridgeFork === false) connectOpts.noBridgeFork = true;
    if (g.telemetry === false) connectOpts.noTelemetry = true;
    const result = await runConnect(connectOpts);
    if (!result.success) process.exitCode = 1;
  });

program
  .command("bridge")
  .description("Run the bridge server explicitly")
  .option("--port <n>", "Bridge port (default 17492)", (v) => Number(v))
  .option("--foreground", "Run inline; default backgrounds it")
  .option(
    "--no-token-rotation",
    "Use pre-seeded SEANPROPAPP_PRESEED_TOKEN (internal flag)",
  )
  .action(
    async (
      opts: { port?: number; foreground?: boolean; tokenRotation: boolean },
      cmd: Command,
    ) => {
      const g = getGlobalOpts(cmd);
      const preseed = process.env["SEANPROPAPP_PRESEED_TOKEN"];

      if (opts.foreground) {
        const bridgeOpts: Parameters<typeof runBridgeForeground>[0] = {
          reuseToken: opts.tokenRotation === false,
        };
        if (g.config !== undefined) bridgeOpts.configDir = g.config;
        if (opts.port !== undefined) bridgeOpts.port = opts.port;
        if (preseed) bridgeOpts.token = preseed;
        await runBridgeForeground(bridgeOpts);
        return;
      }

      // Background spawn (default).
      const cfg = await loadConfig(g.config);
      const token =
        preseed ??
        (opts.tokenRotation === false && cfg.pair_token
          ? cfg.pair_token
          : await (async () => {
              const { generatePairToken } = await import("./commands/pair-url.js");
              return generatePairToken();
            })());
      const spawnOpts: Parameters<typeof spawnBackgroundBridge>[0] = {
        token,
      };
      if (opts.port !== undefined) spawnOpts.port = opts.port;
      if (g.config !== undefined) spawnOpts.configDir = g.config;
      await spawnBackgroundBridge(spawnOpts);
      await updateConfig({ pair_token: token }, g.config);
      process.stdout.write(
        `Bridge spawned in background. Run \`seanpropapp doctor\` to see its status.\n`,
      );
    },
  );

program
  .command("pair")
  .description("Generate a new pair URL")
  .action(async (_opts, cmd: Command) => {
    const g = getGlobalOpts(cmd);
    const pairOpts: Parameters<typeof runPair>[0] = {};
    if (g.config !== undefined) pairOpts.configDir = g.config;
    await runPair(pairOpts);
  });

program
  .command("mcp")
  .description("Run as MCP stdio server (Claude Desktop, Cursor)")
  .action(async (_opts, cmd: Command) => {
    const g = getGlobalOpts(cmd);
    const mcpOpts: Parameters<typeof runMcpCommand>[0] = {};
    if (g.config !== undefined) mcpOpts.configDir = g.config;
    await runMcpCommand(mcpOpts);
  });

program
  .command("doctor")
  .description("Self-diagnostic")
  .action(async (_opts, cmd: Command) => {
    const g = getGlobalOpts(cmd);
    const dOpts: Parameters<typeof runDoctor>[0] = {};
    if (g.config !== undefined) dOpts.configDir = g.config;
    const res = await runDoctor(dOpts);
    if (!res.ok) process.exitCode = 1;
  });

const autostart = program
  .command("autostart")
  .description("Install OS-native auto-start (macOS LaunchAgent, Linux systemd, Windows Task Scheduler)");

autostart
  .command("install")
  .description("Install the OS-native supervisor entry")
  .option("--dry-run", "Write the unit/plist but skip launchctl/systemctl", false)
  .action(async (opts: { dryRun: boolean }) => {
    const installOpts: Parameters<typeof installAutostart>[0] = {};
    if (opts.dryRun) installOpts.dryRun = true;
    const res = await installAutostart(installOpts);
    if (!res.ok) process.exitCode = 1;
  });

autostart
  .command("uninstall")
  .description("Remove the OS-native supervisor entry")
  .option("--dry-run", "Delete the unit/plist file but skip launchctl/systemctl", false)
  .action(async (opts: { dryRun: boolean }) => {
    const unOpts: Parameters<typeof uninstallAutostart>[0] = {};
    if (opts.dryRun) unOpts.dryRun = true;
    const res = await uninstallAutostart(unOpts);
    if (!res.ok) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
