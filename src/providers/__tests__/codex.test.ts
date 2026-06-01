import { describe, it, expect } from "vitest";
import { CodexProvider, anthropicToOpenAI } from "../codex.js";
import { ClassifiedError, type AnthropicSSEEvent } from "../base.js";
import { FakeChildProcess } from "./test-helpers.js";

describe("codex provider — anthropicToOpenAI", () => {
  it("moves Anthropic system field into a system message", () => {
    const out = anthropicToOpenAI({
      model: "gpt-4o",
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(out.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(out.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("flattens content block arrays into plain text", () => {
    const out = anthropicToOpenAI({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ],
        },
      ],
    });
    expect(out.messages[0]?.content).toBe("line 1\nline 2");
  });

  it("preserves assistant + user roles", () => {
    const out = anthropicToOpenAI({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: "q2" },
      ],
    });
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("forwards max_tokens + temperature + stream", () => {
    const out = anthropicToOpenAI({
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 256,
      temperature: 0.7,
      stream: true,
    });
    expect(out.max_tokens).toBe(256);
    expect(out.temperature).toBe(0.7);
    expect(out.stream).toBe(true);
  });
});

describe("codex provider — detect()", () => {
  it("returns installed=false when missing", async () => {
    const provider = new CodexProvider({ whichFn: async () => null });
    const res = await provider.detect();
    expect(res.installed).toBe(false);
  });

  it("returns installed=true when present", async () => {
    const provider = new CodexProvider({
      whichFn: async () => "/Users/x/.codex/bin/codex",
      runCaptureFn: async () => ({ code: 0, stdout: "codex 0.4.2\n", stderr: "" }),
    });
    const res = await provider.detect();
    expect(res.installed).toBe(true);
    expect(res.binary).toBe("/Users/x/.codex/bin/codex");
    expect(res.version).toBe("0.4.2");
  });
});

describe("codex provider — stream()", () => {
  async function collect(
    iter: AsyncIterable<AnthropicSSEEvent>,
  ): Promise<{ events: AnthropicSSEEvent[]; error?: ClassifiedError }> {
    const events: AnthropicSSEEvent[] = [];
    try {
      for await (const ev of iter) events.push(ev);
      return { events };
    } catch (err) {
      if (err instanceof ClassifiedError) return { events, error: err };
      throw err;
    }
  }

  it("happy path streams Anthropic SSE events", async () => {
    const fakes: FakeChildProcess[] = [];
    const provider = new CodexProvider({
      whichFn: async () => "/usr/local/bin/codex",
      runCaptureFn: async () => ({ code: 0, stdout: "codex 0.4.2", stderr: "" }),
      spawnFn: (() => {
        const f = new FakeChildProcess({
          stdoutChunks: ["Hi ", "there"],
          exitCode: 0,
        });
        fakes.push(f);
        return f;
      }) as never,
    });

    const { events, error } = await collect(
      provider.stream({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(error).toBeUndefined();
    expect(events[0]?.type).toBe("message_start");
    expect(events.at(-1)?.type).toBe("message_stop");
    const text = events
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e.type === "content_block_delta" ? e.delta.text : ""))
      .join("");
    expect(text).toBe("Hi there");

    // Stdin payload should be JSON in OpenAI shape.
    const f = fakes[0];
    expect(f).toBeDefined();
    const stdinJson = JSON.parse(f!.stdinData) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(stdinJson.model).toBe("gpt-4o");
    expect(stdinJson.messages[0]?.role).toBe("user");
    expect(stdinJson.messages[0]?.content).toBe("hello");
  });

  it("detects subscription rate-limit in stdout", async () => {
    const provider = new CodexProvider({
      whichFn: async () => "/usr/local/bin/codex",
      runCaptureFn: async () => ({ code: 0, stdout: "codex 0.4.2", stderr: "" }),
      spawnFn: (() =>
        new FakeChildProcess({
          stdoutChunks: ["quota exceeded retry-after: 42"],
          exitCode: 0,
        })) as never,
    });
    const { error } = await collect(
      provider.stream({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(error?.category).toBe("subscription_limit");
    expect(error?.retryAfterSeconds).toBe(42);
  });

  it("throws cli_missing when binary absent", async () => {
    const provider = new CodexProvider({ whichFn: async () => null });
    const { error } = await collect(
      provider.stream({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(error?.category).toBe("cli_missing");
  });
});
