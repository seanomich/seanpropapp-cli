import type { Context } from "hono";
import { z } from "zod";
import { ClassifiedError } from "../providers/base.js";
import type { Provider } from "../providers/base.js";
import { encodeAnthropicSSE } from "./sse.js";

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
  pickProvider: (model: string) => Provider;
}

function errorEventBytes(err: ClassifiedError): Uint8Array {
  return encodeAnthropicSSE({
    type: "error",
    error: {
      type:
        err.category === "subscription_limit"
          ? "rate_limit_exceeded"
          : err.category,
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
    const provider = deps.pickProvider(request.model);

    // Stream Anthropic-format SSE back to the browser. We set the response
    // headers immediately and then push events through a TransformStream so
    // the runtime flushes per chunk.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    // Kick off the pipe in the background; never await it before returning.
    (async () => {
      try {
        for await (const event of provider.stream(request)) {
          await writer.write(encodeAnthropicSSE(event));
        }
      } catch (err) {
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

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  };
}
