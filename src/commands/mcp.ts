/**
 * `seanpropapp mcp` subcommand: launch the stdio MCP server.
 *
 * v0.1.0-alpha: minimal feature parity with the existing `@seanpropapp/mcp`
 * package. The full migration (streaming + caching + telemetry) is the v1.4.0
 * deliverable tracked in proposition-app#341.
 */
import { runMcpServer, type McpServerOptions } from "../mcp/server.js";

export interface McpCommandOptions {
  configDir?: string;
  baseUrl?: string;
}

export async function runMcpCommand(
  opts: McpCommandOptions = {},
): Promise<void> {
  const serverOpts: McpServerOptions = {};
  if (opts.configDir !== undefined) serverOpts.configDir = opts.configDir;
  if (opts.baseUrl !== undefined) serverOpts.baseUrl = opts.baseUrl;
  try {
    await runMcpServer(serverOpts);
  } catch (err) {
    process.stderr.write(
      `mcp: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
