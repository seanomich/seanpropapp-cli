import { describe, it, expect } from "vitest";
import {
  ClaudeProvider,
  detectRateLimit,
  parseRetryAfter,
} from "../claude.js";
import { ClassifiedError, type AnthropicSSEEvent } from "../base.js";
import { FakeChildProcess } from "./test-helpers.js";

describe("claude provider — helpers", () => {
  it("detectRateLimit matches common patterns", () => {
    expect(detectRateLimit("Rate limit exceeded")).toBe(true);
    expect(detectRateLimit("429 Too Many Requests")).toBe(true);
    expect(detectRateLimit("subscription limit reached")).toBe(true);
    expect(detectRateLimit("hello world")).toBe(false);
  });

  it("parseRetryAfter pulls seconds from common phrasings", () => {
    expect(parseRetryAfter("Retry-After: 60s")).toBe(60);
    expect(parseRetryAfter("retry-after 1800")).toBe(1800);
    expect(parseRetryAfter("try again in 90s")).toBe(90);
    expect(parseRetryAfter("nothing here")).toBeUndefined();
  });
});

describe("claude provider — detect()", () => {
  it("returns installed=false when binary missing", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => null,
    });
    const res = await provider.detect();
    expect(res.installed).toBe(false);
    expect(res.reason).toMatch(/not found/i);
  });

  it("returns installed=true + version when CLI present", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({
        code: 0,
        stdout: "claude 1.0.5\n",
        stderr: "",
      }),
    });
    const res = await provider.detect();
    expect(res.installed).toBe(true);
    expect(res.binary).toBe("/usr/local/bin/claude");
    expect(res.version).toBe("1.0.5");
  });
});

describe("claude provider — stream()", () => {
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

  it("yields message_start → deltas → message_stop on happy path", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "claude 1.0.5", stderr: "" }),
      spawnFn: (() =>
        new FakeChildProcess({
          stdoutChunks: ["Hello ", "world"],
          exitCode: 0,
        })) as never,
    });

    const { events, error } = await collect(
      provider.stream({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(error).toBeUndefined();
    expect(events[0]?.type).toBe("message_start");
    expect(events[1]?.type).toBe("content_block_start");
    const deltaTexts = events
      .filter((e) => e.type === "content_block_delta")
      .map((e) =>
        e.type === "content_block_delta" ? e.delta.text : "",
      );
    expect(deltaTexts.join("")).toBe("Hello world");
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  it("emits ClassifiedError(subscription_limit) when output contains 429", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawnFn: (() =>
        new FakeChildProcess({
          stdoutChunks: ["Rate limit exceeded. Retry-After: 1640"],
          exitCode: 0,
        })) as never,
    });

    const { error } = await collect(
      provider.stream({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(error).toBeInstanceOf(ClassifiedError);
    expect(error?.category).toBe("subscription_limit");
    expect(error?.retryAfterSeconds).toBe(1640);
  });

  it("throws ClassifiedError(cli_missing) when CLI not installed", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => null,
    });
    const { error } = await collect(
      provider.stream({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(error).toBeInstanceOf(ClassifiedError);
    expect(error?.category).toBe("cli_missing");
  });

  it("classifies non-zero exit with rate-limit stderr as subscription_limit", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "claude 1.0.5", stderr: "" }),
      spawnFn: (() =>
        new FakeChildProcess({
          stdoutChunks: [],
          stderrChunks: ["429 Too Many Requests retry-after: 30"],
          exitCode: 1,
        })) as never,
    });
    const { error } = await collect(
      provider.stream({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(error?.category).toBe("subscription_limit");
    expect(error?.retryAfterSeconds).toBe(30);
  });
});
