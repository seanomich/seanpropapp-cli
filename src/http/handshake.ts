import type { Context } from "hono";
import os from "node:os";
import { CLI_VERSION } from "../version.js";
import type { Provider, ProviderDetectResult } from "../providers/base.js";

export interface HandshakeResponse {
  version: string;
  providers: {
    claude: ProviderDetectResult;
    codex: ProviderDetectResult;
    gemini: ProviderDetectResult;
  };
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
  claude: Provider;
  codex: Provider;
}

export function makeHandshakeHandler(deps: HandshakeDeps) {
  return async (c: Context) => {
    const [claude, codex] = await Promise.all([
      deps.claude.detect(),
      deps.codex.detect(),
    ]);
    const body: HandshakeResponse = {
      version: CLI_VERSION,
      providers: {
        claude,
        codex,
        gemini: { installed: false, reason: "not yet supported" },
      },
      paired_at: deps.pairedAt(),
      device_name: deviceName(),
    };
    return c.json(body, 200);
  };
}
