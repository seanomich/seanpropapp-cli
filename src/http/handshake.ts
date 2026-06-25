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
}

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
    };
    return c.json(body, 200);
  };
}
