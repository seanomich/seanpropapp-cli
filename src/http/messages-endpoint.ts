import type { Context } from "hono";
import { z } from "zod";
import { ClassifiedError } from "../providers/base.js";
import type { Provider } from "../providers/base.js";
import { encodeAnthropicSSE } from "./sse.js";
import { streamingResponseCorsHeaders } from "./cors.js";
import { logProviderRun } from "./run-log.js";

const MessagesRequestSchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  system: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.union([
          z.string(),
          z.array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
            }),
          ),
        ]),
      }),
    )
    .min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
});

export type MessagesRequest = z.infer<typeof MessagesRequestSchema>;

export interface MessagesDeps {
  // May be async: routing the generic "subscription" model now awaits CLI
  // install-detection (#14), so the picker can return a Promise.
  pickProvider: (model: string) => Provider | Promise<Provider>;
}

function errorEventBytes(err: ClassifiedError): Uint8Array {
  return encodeAnthropicSSE({
    type: "error",
    error: {
      // Legacy wire value, kept so an older browser build keeps behaving. Both
      // throttling kinds that used to be one still map to the same string here.
      type:
        err.category === "subscription_limit" || err.category === "rate_limited"
          ? "rate_limit_exceeded"
          : err.category,
      // ADDITIVE (CLI #27): the precise category, so a current browser can tell
      // "your allowance is spent" from "the provider is throttling or overloaded"
      // and offer the right recovery. Additive on purpose: changing `type` would
      // break older paired bridges/clients mid-upgrade.
      category: err.category,
      message: err.message,
      retry_after_seconds: err.retryAfterSeconds,
    },
  });
}

export function makeMessagesHandler(deps: MessagesDeps) {
  return async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { type: "invalid_request", message: "Body must be JSON" } },
        400,
      );
    }
    const parsed = MessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request",
            message: parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          },
        },
        400,
      );
    }

    const request = parsed.data;

    // Stream Anthropic-format SSE back to the browser. We set the response
    // headers immediately and then push events through a TransformStream so
    // the runtime flushes per chunk.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    // Kick off the pipe in the background; never await it before returning.
    (async () => {
      const startedAt = Date.now();
      let providerName = "unknown";
      try {
        // Pick the provider inside the stream so a routing failure (e.g. no CLI
        // installed, #14) surfaces as an SSE error event the browser can read,
        // rather than an unhandled rejection or a crash into a missing binary.
        const provider = await deps.pickProvider(request.model);
        providerName = provider.name;
        for await (const event of provider.stream(request)) {
          await writer.write(encodeAnthropicSSE(event));
        }
        logProviderRun({
          provider: providerName,
          model: request.model,
          durationMs: Date.now() - startedAt,
          outcome: "ok",
        });
      } catch (err) {
        logProviderRun({
          provider: providerName,
          model: request.model,
          durationMs: Date.now() - startedAt,
          outcome: "error",
          category: err instanceof ClassifiedError ? err.category : "unknown",
        });
        if (err instanceof ClassifiedError) {
          await writer.write(errorEventBytes(err));
        } else {
          const message = err instanceof Error ? err.message : String(err);
          await writer.write(
            encodeAnthropicSSE({
              type: "error",
              error: { type: "internal_error", message },
            }),
          );
        }
      } finally {
        await writer.close().catch(() => undefined);
      }
    })();

    // The raw `new Response()` here bypasses Hono's response builder, so the
    // CORS headers set by corsMiddleware on the context never reach the wire.
    // We must inject them inline; otherwise the browser blocks the streaming
    // response with "No Access-Control-Allow-Origin header is present" even
    // though the preflight succeeded.
    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        ...streamingResponseCorsHeaders(c.req.header("Origin")),
      },
    });
  };
}
