import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { corsMiddleware } from "./cors.js";
import { makeAuthMiddleware } from "./auth-middleware.js";
import { makeHandshakeHandler } from "./handshake.js";
import { makeMessagesHandler } from "./messages-endpoint.js";
import { makeChatCompletionsHandler } from "./chat-completions.js";
import {
  buildProviders,
  descriptorForModel,
  genericOrder,
} from "../providers/registry.js";
import { ClassifiedError } from "../providers/base.js";
import type { Provider } from "../providers/base.js";

export const DEFAULT_BRIDGE_PORT = 17492;
export const MAX_PORT_FALLBACK = 17500;

export interface StartServerOptions {
  port?: number;
  /**
   * Either a literal token (the simple v0.1.0-alpha shape) or a getter that
   * returns the current token. The getter form lets the bridge process
   * rotate tokens on SIGHUP without restarting the HTTP listener.
   */
  token: string | (() => string);
  /** Optional provider overrides for testing, keyed by registry id (e.g. claude, codex). */
  providers?: Record<string, Provider>;
  /** Optional override for the paired_at value surfaced in /v1/handshake. */
  pairedAt?: () => string | null;
  /**
   * Invoked when a browser-originated handshake authenticates (#3). Wired by
   * the bridge to persist paired_at so `connect` can detect a successful pair.
   */
  onBrowserPair?: () => void | Promise<void>;
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Build the Hono app. Exposed for tests so they can run the app directly
 * via `app.request(...)` without binding to a real socket.
 */
export function createApp(opts: StartServerOptions) {
  // All providers come from the registry (single source of truth); tests can
  // override an instance by id via opts.providers.
  const providers = buildProviders(opts.providers ?? {});

  // Memoized install detection across the registry so the generic "subscription"
  // model can route by what is ACTUALLY installed instead of blind-defaulting to
  // one vendor (#14). Cached for the process lifetime; re-pairing / restarting
  // the bridge re-detects. detect() failures degrade to "nothing installed" so a
  // flaky probe never wrongly spawns a missing CLI.
  let installedCache: Promise<Map<string, boolean>> | null = null;
  function detectInstalled(): Promise<Map<string, boolean>> {
    if (!installedCache) {
      installedCache = Promise.all(
        [...providers.entries()].map(
          async ([id, p]) => [id, (await p.detect()).installed] as const,
        ),
      )
        .then((entries) => new Map(entries))
        .catch(() => new Map<string, boolean>());
    }
    return installedCache;
  }

  async function pickProviderForModel(model: string): Promise<Provider> {
    // Explicit model prefix (claude-* / gpt-* / gemini-*) routes directly.
    const explicit = descriptorForModel(model);
    if (explicit) {
      const p = providers.get(explicit.id);
      if (p) return p;
    }
    // Generic "subscription" pseudo-model — what the SeanPropApp bridge always
    // sends for a local_bridge run. Route by what is installed, in precedence
    // order (Claude first, historically). NEVER blind-spawn one vendor for a
    // user who only has another (#14: "Claude CLI exited with code 1" for Codex
    // users). If nothing is installed, surface a vendor-neutral error.
    const installed = await detectInstalled();
    for (const d of genericOrder()) {
      const p = providers.get(d.id);
      if (p && installed.get(d.id)) return p;
    }
    throw new ClassifiedError(
      "No supported CLI detected on this device. Install a supported CLI (Claude or Codex), then re-pair.",
      { category: "cli_missing" },
    );
  }

  const app = new Hono();

  app.use("*", corsMiddleware);

  app.get(
    "/v1/handshake",
    makeAuthMiddleware(opts.token),
    makeHandshakeHandler({
      pairedAt: opts.pairedAt ?? (() => null),
      providers,
      ...(opts.onBrowserPair ? { onBrowserPair: opts.onBrowserPair } : {}),
    }),
  );

  app.post(
    "/v1/messages",
    makeAuthMiddleware(opts.token),
    makeMessagesHandler({ pickProvider: pickProviderForModel }),
  );

  app.post(
    "/v1/chat/completions",
    makeAuthMiddleware(opts.token),
    makeChatCompletionsHandler({ pickProvider: pickProviderForModel }),
  );

  return app;
}

/**
 * Try to bind to `port`. Resolves with the actual port on success or null
 * if the port is in use. Other errors reject.
 */
function tryListen(app: Hono, port: number): Promise<RunningServer | null> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port, hostname: "127.0.0.1" },
      (info: AddressInfo) => {
        resolve({
          port: info.port,
          url: `http://127.0.0.1:${info.port}`,
          close: () =>
            new Promise<void>((res) => {
              server.close(() => res());
            }),
        });
      },
    );
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(null);
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Bind the server, falling back through ports 17492..17500 if the requested
 * port is taken. When a non-default port is explicitly supplied, fall back
 * up to 8 ports above the requested port (matches the default range width)
 * so explicit ports get the same graceful behavior.
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const app = createApp(opts);
  const startPort = opts.port ?? DEFAULT_BRIDGE_PORT;
  const endPort =
    startPort === DEFAULT_BRIDGE_PORT
      ? MAX_PORT_FALLBACK
      : startPort + (MAX_PORT_FALLBACK - DEFAULT_BRIDGE_PORT);
  for (let port = startPort; port <= endPort; port++) {
    const running = await tryListen(app, port);
    if (running) return running;
  }
  throw new Error(
    `No available port in range ${startPort}-${endPort}. Stop another process or pass --port.`,
  );
}
