import type { Context } from "hono";
import os from "node:os";
import { CLI_VERSION } from "../version.js";
import type { Provider, ProviderDetectResult } from "../providers/base.js";

export interface HandshakeResponse {
  version: string;
  /** Detection result per registry provider id (claude, codex, gemini, ...). */
  providers: Record<string, ProviderDetectResult>;
  paired_at: string | null;
  device_name: string;
  /**
   * What this bridge can do beyond a plain run, so the app asks only for what
   * will actually happen (proposition-app#716). `research` lists the provider
   * ids whose runs can search and fetch the web. Absent on bridges before
   * beta.19, which the app reads as "no research".
   */
  capabilities: { research: string[] };
}

/** Provider ids that implement `request.research`. */
export const RESEARCH_PROVIDERS: readonly string[] = ["claude"];

export function deviceName(): string {
  const host = os.hostname();
  const plat = process.platform === "darwin" ? "macOS" : process.platform;
  const rel = os.release();
  return `${host} (${plat} ${rel})`;
}

export interface HandshakeDeps {
  pairedAt: () => string | null;
  /** Registry providers keyed by id; every one is detected and reported. */
  providers: Map<string, Provider>;
}

export function makeHandshakeHandler(deps: HandshakeDeps) {
  return async (c: Context) => {
    const entries = await Promise.all(
      [...deps.providers.entries()].map(
        async ([id, p]) => [id, await p.detect()] as const,
      ),
    );
    const body: HandshakeResponse = {
      version: CLI_VERSION,
      providers: Object.fromEntries(entries),
      paired_at: deps.pairedAt(),
      device_name: deviceName(),
      capabilities: {
        // Only providers that are actually installed: advertising research for
        // a CLI the user does not have would promise a run that cannot happen.
        research: entries
          .filter(([id, d]) => RESEARCH_PROVIDERS.includes(id) && d.installed)
          .map(([id]) => id),
      },
    };
    return c.json(body, 200);
  };
}
