import type { Context } from "hono";
import { z } from "zod";
import { ClassifiedError } from "../providers/base.js";
import type {
  AnthropicLikeRequest,
  AnthropicMessage,
  Provider,
} from "../providers/base.js";
import { streamingResponseCorsHeaders } from "./cors.js";
import {
  anthropicEventToOpenAIChunk,
  encodeOpenAIChunk,
} from "./sse.js";

const ChatCompletionsRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
});

export type ChatCompletionsRequest = z.infer<typeof ChatCompletionsRequestSchema>;

export interface ChatCompletionsDeps {
  pickProvider: (model: string) => Provider;
}

/**
 * Translate inbound OpenAI Chat Completions shape to Anthropic shape so a
 * single provider abstraction can serve it.
 */
export function openaiToAnthropic(req: ChatCompletionsRequest): AnthropicLikeRequest {
  let system: string | undefined;
  const messages: AnthropicMessage[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    });
  }
  const out: AnthropicLikeRequest = {
    model: req.model,
    messages,
    stream: req.stream,
  };
  if (system) out.system = system;
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  return out;
}

export function makeChatCompletionsHandler(deps: ChatCompletionsDeps) {
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
    const parsed = ChatCompletionsRequestSchema.safeParse(body);
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
    const anthropicRequest = openaiToAnthropic(request);
    const provider = deps.pickProvider(request.model);

    const ctx = {
      id: `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      model: request.model,
      created: Math.floor(Date.now() / 1000),
    };

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    (async () => {
      try {
        for await (const event of provider.stream(anthropicRequest)) {
          const chunk = anthropicEventToOpenAIChunk(event, ctx);
          if (!chunk) continue;
          await writer.write(encodeOpenAIChunk(chunk));
        }
      } catch (err) {
        const message =
          err instanceof ClassifiedError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        const errBody = {
          error: {
            type:
              err instanceof ClassifiedError &&
              err.category === "subscription_limit"
                ? "rate_limit_exceeded"
                : "internal_error",
            message,
            retry_after_seconds:
              err instanceof ClassifiedError ? err.retryAfterSeconds : undefined,
          },
        };
        await writer.write(
          new TextEncoder().encode(`data: ${JSON.stringify(errBody)}\n\n`),
        );
      } finally {
        await writer.close().catch(() => undefined);
      }
    })();

    // See messages-endpoint.ts for the same rationale: the raw `new Response()`
    // bypasses Hono's middleware-set headers, so CORS must be injected inline.
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
