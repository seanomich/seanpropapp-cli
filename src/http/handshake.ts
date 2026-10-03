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
  /**
   * Invoked when a BROWSER-originated handshake authenticates (#3). The browser
   * pair page is cross-origin (it carries an allowlisted Origin header that
   * already cleared CORS), whereas `connect`'s own local healthcheck poll and
   * `doctor` send no Origin. Gating on Origin lets the bridge record the pair
   * completion (paired_at) on the real user confirmation only, not on the
   * parent's healthcheck. Fired best-effort; failures never fail the handshake.
   */
  onBrowserPair?: () => void | Promise<void>;
}

export function makeHandshakeHandler(deps: HandshakeDeps) {
  return async (c: Context) => {
    // Provider detection runs at REQUEST time (#2), not at server start, so a
    // CLI installed after the bridge came up is still reported, and the result
    // matches what `connect` detected moments earlier in the same environment.
    const entries = await Promise.all(
      [...deps.providers.entries()].map(
        async ([id, p]) => [id, await p.detect()] as const,
      ),
    );

    // Record the pair completion when this handshake came from the browser.
    // Auth middleware has already validated the token by the time we run.
    if (deps.onBrowserPair && c.req.header("Origin")) {
      try {
        await deps.onBrowserPair();
      } catch {
        // Non-fatal: the handshake still succeeds; the parent falls back to its
        // poll timeout if the paired_at write never lands.
      }
    }
    const body: HandshakeResponse = {
      version: CLI_VERSION,
      providers: Object.fromEntries(entries),
      paired_at: deps.pairedAt(),
      device_name: deviceName(),
    };
    return c.json(body, 200);
  };
}
