import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time Bearer-token check. Token is held in-memory only; never logged.
 *
 * `expectedToken` accepts either a literal string (the v0.1.0-alpha behavior)
 * or a getter function. The getter form is used by the bridge process so it
 * can pick up a rotated token on SIGHUP without restarting the HTTP server.
 */
export function makeAuthMiddleware(
  expectedToken: string | (() => string),
): MiddlewareHandler {
  const getToken =
    typeof expectedToken === "function" ? expectedToken : () => expectedToken;

  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json(
        { error: { type: "unauthorized", message: "Missing Bearer token" } },
        401,
      );
    }
    const provided = header.slice("Bearer ".length).trim();
    const providedBuf = Buffer.from(provided, "utf8");
    const expectedBuf = Buffer.from(getToken(), "utf8");

    let ok = false;
    if (providedBuf.length === expectedBuf.length) {
      ok = timingSafeEqual(providedBuf, expectedBuf);
    }
    if (!ok) {
      return c.json(
        { error: { type: "unauthorized", message: "Invalid Bearer token" } },
        401,
      );
    }
    await next();
  };
}
