import type { MiddlewareHandler } from "hono";

export const ALLOWED_ORIGINS = [
  "https://prop.seanoneill.com",
  "http://localhost:3000",
] as const;

export const PREFLIGHT_MAX_AGE_SECONDS = 86400;

export function isOriginAllowed(origin: string | null | undefined): boolean {
  if (!origin) return false;
  return (ALLOWED_ORIGINS as readonly string[]).includes(origin);
}

/**
 * Strict CORS middleware: only allows the SeanPropApp prod origin + local dev.
 * Rejects all other origins with 403. Preflights cached for 24h.
 */
export const corsMiddleware: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("Origin");

  // Same-origin / no-origin requests are allowed (e.g. curl during doctor checks).
  // Only enforce when an Origin header is present.
  if (origin !== undefined) {
    if (!isOriginAllowed(origin)) {
      return c.json({ error: { type: "forbidden_origin", message: "Origin not allowed" } }, 403);
    }
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Credentials", "false");
  }

  if (c.req.method === "OPTIONS") {
    c.header(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS",
    );
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    c.header("Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_SECONDS));
    return c.body(null, 204);
  }

  await next();
};
