import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time Bearer-token check. Token is held in-memory only; never logged.
 */
export function makeAuthMiddleware(expectedToken: string): MiddlewareHandler {
  const expectedBuf = Buffer.from(expectedToken, "utf8");

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
