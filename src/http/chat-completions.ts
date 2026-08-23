import type { Context } from "hono";
import { z } from "zod";
import { ClassifiedError } from "../providers/base.js";
import type {
  AnthropicLikeRequest,
  AnthropicMessage,
  Provider,
} from "../providers/base.js";
import { streamingResponseCorsHeaders } from "./cors.js";
import { logProviderRun } from "./run-log.js";
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
  // May be async: routing the generic "subscription" model now awaits CLI
  // install-detection (#14), so the picker can return a Promise.
  pickProvider: (model: string) => Provider | Promise<Provider>;
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

    const ctx = {
      id: `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      model: request.model,
      created: Math.floor(Date.now() / 1000),
    };

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    (async () => {
      const startedAt = Date.now();
      let providerName = "unknown";
      try {
        // Pick the provider inside the stream so a routing failure (e.g. no CLI
        // installed, #14) surfaces as an error event instead of crashing.
        const provider = await deps.pickProvider(request.model);
        providerName = provider.name;
        for await (const event of provider.stream(anthropicRequest)) {
          const chunk = anthropicEventToOpenAIChunk(event, ctx);
          if (!chunk) continue;
          await writer.write(encodeOpenAIChunk(chunk));
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
        const message =
          err instanceof ClassifiedError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        const errBody = {
          error: {
            // Legacy wire value (see messages-endpoint): both throttling kinds
            // that used to be one still map to the same string.
            type:
              err instanceof ClassifiedError &&
              (err.category === "subscription_limit" || err.category === "rate_limited")
                ? "rate_limit_exceeded"
                : "internal_error",
            // ADDITIVE (CLI #27): precise category for clients that read it.
            category: err instanceof ClassifiedError ? err.category : undefined,
            message,
            retry_after_seconds:
              err instanceof ClassifiedError ? err.retryAfterSeconds : undefined,
          },
        };
        // See messages-endpoint.ts: this write can land on an already-dead
        // stream when the client disconnected mid-stream, and an un-awaited
        // rejection here kills the bridge process. Nobody is listening, so
        // swallow it.
        await writer
          .write(new TextEncoder().encode(`data: ${JSON.stringify(errBody)}\n\n`))
          .catch(() => undefined);
      } finally {
        await writer.close().catch(() => undefined);
      }
      // Backstop against any future un-awaited rejection escaping this task.
    })().catch(() => undefined);

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
