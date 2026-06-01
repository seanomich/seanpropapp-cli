/**
 * Minimal MCP stdio server for `seanpropapp mcp`.
 *
 * v0.1.0-alpha scope:
 *  - Reads bearer token from `~/.seanpropapp/config.json` (`mcp_token` field)
 *    or `SEANPROPAPP_MCP_TOKEN` env override.
 *  - Exposes one tool (`run_module`) plus one prompt per methodology module,
 *    mirroring the existing `@seanpropapp/mcp` surface so Claude Desktop /
 *    Cursor configs continue to work.
 *  - Routes every assemble call to the production prompt-assembly endpoint
 *    (`/api/mcp/assemble-prompt`). The server never sees the LLM response;
 *    the host's LLM does inference using the user's own subscription.
 *
 * Out of scope (deferred to v1.4.0 full migration):
 *  - Streaming, multi-region routing, local methodology caching.
 *  - Telemetry beyond stderr session-ready line.
 *
 * Migration tracker: see proposition-app#341 + the README "MCP" section.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MODULES } from "./manifest.js";
import { loadConfig } from "../config.js";
import { CLI_VERSION } from "../version.js";

interface AssembleArgs {
  moduleId: string;
  company: string;
  persona?: string;
  initiative?: string;
  keyQuestion?: string;
  priorOutputs?: Record<string, string>;
}

interface AssembledPrompt {
  systemPrompt: string;
  userMessage: string;
  methodologyVersion: string;
  wordLimit: number;
  warnings: string[];
}

export interface McpServerOptions {
  /** Override config dir (used by tests). */
  configDir?: string;
  /** Override base URL (used by tests + dev). */
  baseUrl?: string;
  /** Override fetch (used by tests). */
  fetchImpl?: typeof fetch;
  /** Override stderr writer (used by tests). */
  stderr?: (line: string) => void;
}

export interface ResolvedToken {
  token: string;
  source: "env" | "config";
}

/**
 * Resolve the MCP bearer token from env > config. Throws a clear error if
 * neither source has one.
 */
export async function resolveMcpToken(
  opts: McpServerOptions = {},
): Promise<ResolvedToken> {
  const env = process.env["SEANPROPAPP_MCP_TOKEN"];
  if (env && env.trim()) return { token: env.trim(), source: "env" };
  const cfg = await loadConfig(opts.configDir);
  if (cfg.mcp_token && cfg.mcp_token.trim()) {
    return { token: cfg.mcp_token.trim(), source: "config" };
  }
  throw new Error(
    "No MCP token found. Generate one at https://prop.seanoneill.com/mcp-setup, " +
      'then either set SEANPROPAPP_MCP_TOKEN or run `seanpropapp pair` and paste the token into ~/.seanpropapp/config.json under "mcp_token".',
  );
}

/**
 * Run the stdio MCP server until the transport closes.
 *
 * Returns when the transport disconnects (which under stdio means stdin EOF).
 */
export async function runMcpServer(
  opts: McpServerOptions = {},
): Promise<void> {
  const baseUrl = (
    opts.baseUrl ??
    process.env["SEANPROPAPP_MCP_URL"] ??
    "https://prop.seanoneill.com"
  ).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  const { token, source } = await resolveMcpToken(opts);

  // One id per process launch, forwarded on every call. Lets the server count
  // distinct sessions without PII.
  const sessionId = randomUUID();

  const server = new McpServer({
    name: "SeanPropApp",
    version: CLI_VERSION,
  });

  function callerHost(): string {
    return server.server.getClientVersion()?.name ?? "unknown";
  }

  async function assemble(args: AssembleArgs): Promise<AssembledPrompt> {
    const res = await fetchImpl(`${baseUrl}/api/mcp/assemble-prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-MCP-Session": sessionId,
        "X-MCP-Client": callerHost(),
        "X-MCP-Transport": "seanpropapp-cli",
      },
      body: JSON.stringify({
        moduleId: args.moduleId,
        company: args.company,
        persona: args.persona,
        initiativeName: args.initiative,
        investorQuestions: args.keyQuestion,
        priorOutputs: args.priorOutputs,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      const detail = err.message || err.error || `request failed (${res.status})`;
      throw new Error(`SeanPropApp: ${detail}`);
    }
    return (await res.json()) as AssembledPrompt;
  }

  const moduleIds = MODULES.map((m) => m.id);

  server.registerTool(
    "run_module",
    {
      title: "Run a SeanPropApp methodology module",
      description:
        "Assemble a SeanPropApp proposition-analysis module and return its instructions for you to execute. " +
        "Run SETUP first for any new company. Pass `initiative` to focus on a specific What-If; pass `keyQuestion` to anchor the analysis. " +
        "For continuity, pass earlier module outputs in `priorOutputs`. " +
        `Available modules: ${moduleIds.join(", ")}.`,
      inputSchema: {
        moduleId: z
          .enum(moduleIds as [string, ...string[]])
          .describe("Which methodology module to run (start with SETUP)"),
        company: z.string().describe("The company or product being analyzed"),
        persona: z
          .enum(["internal_leader", "investor"])
          .optional()
          .describe("Analysis lens; defaults to internal_leader."),
        initiative: z
          .string()
          .optional()
          .describe("Optional What-If hypothesis to focus the analysis on."),
        keyQuestion: z
          .string()
          .optional()
          .describe("Optional key question the user wants answered."),
        priorOutputs: z
          .record(z.string(), z.string())
          .optional()
          .describe("Map of prior module id to its output text."),
      },
    },
    async ({
      moduleId,
      company,
      persona,
      initiative,
      keyQuestion,
      priorOutputs,
    }) => {
      const a = await assemble({
        moduleId,
        company,
        persona,
        initiative,
        keyQuestion,
        priorOutputs,
      });
      const text = [a.systemPrompt, "", "---", "", a.userMessage].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  // Prompt surface (Claude Desktop menu): one prompt per module.
  for (const m of MODULES) {
    server.registerPrompt(
      m.id,
      {
        title: m.displayName,
        description: m.description,
        argsSchema: {
          company: z.string().describe("The company or product being analyzed"),
          persona: z.enum(["internal_leader", "investor"]).optional(),
          initiative: z.string().optional(),
          keyQuestion: z.string().optional(),
        },
      },
      async ({ company, persona, initiative, keyQuestion }) => {
        const a = await assemble({
          moduleId: m.id,
          company,
          persona,
          initiative,
          keyQuestion,
        });
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `${a.systemPrompt}\n\n${a.userMessage}`,
              },
            },
          ],
        };
      },
    );
  }

  await server.connect(new StdioServerTransport());
  stderr(
    `SeanPropApp MCP server ready (${baseUrl}, session ${sessionId}, token from ${source}).\n`,
  );
}
