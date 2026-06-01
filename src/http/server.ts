import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { corsMiddleware } from "./cors.js";
import { makeAuthMiddleware } from "./auth-middleware.js";
import { makeHandshakeHandler } from "./handshake.js";
import { makeMessagesHandler } from "./messages-endpoint.js";
import { makeChatCompletionsHandler } from "./chat-completions.js";
import { ClaudeProvider, CodexProvider } from "../providers/index.js";
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
  /** Optional provider overrides for testing. */
  providers?: {
    claude?: Provider;
    codex?: Provider;
  };
  /** Optional override for the paired_at value surfaced in /v1/handshake. */
  pairedAt?: () => string | null;
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
  const claude = opts.providers?.claude ?? new ClaudeProvider();
  const codex = opts.providers?.codex ?? new CodexProvider();

  function pickProviderForModel(model: string): Provider {
    const m = model.toLowerCase();
    if (m.startsWith("claude-")) return claude;
    if (m.startsWith("gpt-") || m.startsWith("o3") || m.startsWith("o1")) {
      return codex;
    }
    // Generic "subscription" pseudo-model: route by what's installed; default to claude.
    return claude;
  }

  const app = new Hono();

  app.use("*", corsMiddleware);

  app.get(
    "/v1/handshake",
    makeAuthMiddleware(opts.token),
    makeHandshakeHandler({
      pairedAt: opts.pairedAt ?? (() => null),
      claude,
      codex,
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
