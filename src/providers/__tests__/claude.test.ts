import { describe, it, expect } from "vitest";
import {
  ClaudeProvider,
  detectRateLimit,
  parseRetryAfter,
  mapToClaudeCliModel,
  buildClaudePrompt,
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

  // Regression for v0.1.0-beta.4 production bug: proposition-app's models.ts
  // emits 'subscription' as the model name for all three local_bridge tiers.
  // Passing that straight to `claude --model` fails because Claude CLI only
  // recognizes opus / sonnet / haiku. Translation defaults 'subscription' to
  // 'sonnet' (the balanced tier subscriptions reliably have).
  describe("mapToClaudeCliModel", () => {
    it("passes through opus / sonnet / haiku verbatim (case-insensitive)", () => {
      expect(mapToClaudeCliModel("opus")).toBe("opus");
      expect(mapToClaudeCliModel("sonnet")).toBe("sonnet");
      expect(mapToClaudeCliModel("haiku")).toBe("haiku");
      expect(mapToClaudeCliModel("OPUS")).toBe("opus");
      expect(mapToClaudeCliModel("Sonnet")).toBe("sonnet");
    });
    it("maps Anthropic API model IDs to the matching tier", () => {
      expect(mapToClaudeCliModel("claude-opus-4-7")).toBe("opus");
      expect(mapToClaudeCliModel("claude-sonnet-4-6")).toBe("sonnet");
      expect(mapToClaudeCliModel("claude-haiku-4-5-20251001")).toBe("haiku");
    });
    it("maps the literal 'subscription' to 'sonnet' (the bug catcher)", () => {
      expect(mapToClaudeCliModel("subscription")).toBe("sonnet");
    });
    it("falls back to 'sonnet' for unknown values rather than rejecting the run", () => {
      expect(mapToClaudeCliModel("gpt-4o")).toBe("sonnet");
      expect(mapToClaudeCliModel("")).toBe("sonnet");
      expect(mapToClaudeCliModel("random-string")).toBe("sonnet");
    });
  });

  // Regression for proposition-app#446 / seanpropapp-cli#8 (shipped broken in
  // v0.1.0-beta.6): the bridge piped only the LAST user message to
  // `claude --print`, so module RE-RUNS — which carry the prior output and the
  // user's corrections in earlier turns and end with a short "regenerate from
  // the conversation above" instruction — arrived with no conversation. The
  // model then returned a stub ("nothing above to regenerate").
  describe("buildClaudePrompt", () => {
    it("sends a single user turn verbatim (no role label)", () => {
      const out = buildClaudePrompt({
        model: "sonnet",
        messages: [{ role: "user", content: "Analyze Acme Corp." }],
      });
      expect(out).toBe("Analyze Acme Corp.");
    });

    it("flattens string-array (block) content for a single turn", () => {
      const out = buildClaudePrompt({
        model: "sonnet",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Line one" },
              { type: "image" },
              { type: "text", text: "Line two" },
            ],
          },
        ],
      });
      expect(out).toBe("Line one\nLine two");
    });

    it("preserves EVERY turn on a multi-turn re-run, not just the last", () => {
      const out = buildClaudePrompt({
        model: "sonnet",
        messages: [
          { role: "user", content: "Run the Company Context module." },
          { role: "assistant", content: "PRIOR OUTPUT: Acme is B2B SaaS." },
          { role: "user", content: "Correction: Acme is B2B2C." },
          { role: "user", content: "Now regenerate incorporating the above." },
        ],
      });
      // The prior output and the correction (earlier turns) must survive —
      // dropping them is the exact bug.
      expect(out).toContain("PRIOR OUTPUT: Acme is B2B SaaS.");
      expect(out).toContain("Correction: Acme is B2B2C.");
      expect(out).toContain("Now regenerate incorporating the above.");
      // Turns are role-labeled so the model can read it as a conversation.
      expect(out).toContain("Assistant: PRIOR OUTPUT: Acme is B2B SaaS.");
      expect(out).toContain("Human: Correction: Acme is B2B2C.");
    });

    it("skips empty turns and returns '' for an empty conversation", () => {
      expect(
        buildClaudePrompt({ model: "sonnet", messages: [{ role: "user", content: "   " }] }),
      ).toBe("");
    });
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

  it("writes the FULL multi-turn conversation to the CLI stdin (not just the last turn)", async () => {
    let child: FakeChildProcess | undefined;
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "claude 1.0.5", stderr: "" }),
      spawnFn: (() => {
        child = new FakeChildProcess({ stdoutChunks: ["ok"], exitCode: 0 });
        return child;
      }) as never,
    });

    await collect(
      provider.stream({
        model: "claude-3-5-sonnet",
        system: "You are a proposition analyst.",
        messages: [
          { role: "user", content: "Run the Company Context module." },
          { role: "assistant", content: "PRIOR OUTPUT: Acme is B2B SaaS." },
          { role: "user", content: "Correction: Acme is B2B2C." },
          { role: "user", content: "Now regenerate incorporating the above." },
        ],
      }),
    );

    // The subprocess must receive the prior output + correction, or the model
    // has nothing to regenerate (the proposition-app#446 stub bug).
    expect(child?.stdinData).toContain("PRIOR OUTPUT: Acme is B2B SaaS.");
    expect(child?.stdinData).toContain("Correction: Acme is B2B2C.");
    expect(child?.stdinData).toContain("Now regenerate incorporating the above.");
  });

  // REWRITTEN 2026-07-25. The previous version of this test asserted that
  // limit-shaped stdout with exitCode 0 must become a subscription_limit, i.e.
  // it ENCODED the defect that broke two production runs: grading the model's
  // own prose on a run the CLI reported as successful. `claude --print` emits the
  // entire answer as ONE stdout chunk, so "the output contains a limit phrase"
  // and "the answer discusses limits" are indistinguishable at that layer. The
  // exit code is now the only trigger.
  it("does NOT reclassify a successful run whose output discusses limits", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawnFn: (() =>
        new FakeChildProcess({
          // Exit 0 means the CLI did the work. This is an ANSWER about rate
          // limits, not a refusal.
          stdoutChunks: ["Rate limit exceeded is the error competitors return at 429."],
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
    const text = events
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e.type === "content_block_delta" ? e.delta.text : ""))
      .join("");
    expect(text).toContain("Rate limit exceeded");
  });

  it("DOES classify a limit once the CLI reports failure (non-zero exit)", async () => {
    // Measured behaviour: this CLI writes failures to STDOUT with exit=1 and
    // leaves stderr empty, so stdout must still be readable as evidence, but
    // only after the exit code says the run failed.
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawnFn: (() =>
        new FakeChildProcess({
          stdoutChunks: ["Rate limit exceeded. Retry-After: 1640"],
          exitCode: 1,
        })) as never,
    });

    const { error } = await collect(
      provider.stream({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(error).toBeInstanceOf(ClassifiedError);
    // CLI #27: "Rate limit exceeded" names the RATE limit, so it is provider-side
    // throttling, NOT the user's subscription allowance running out. Reporting it
    // as a subscription limit is what told a user with 5% of their weekly
    // allowance used to wait for a window reset or buy an upgrade.
    expect(error?.category).toBe("rate_limited");
    expect(error?.retryAfterSeconds).toBe(1640);
    // The error must carry what the provider actually said. The old bare
    // "Subscription rate limit" string left an incident with zero evidence.
    expect(error?.message).toContain("Rate limit exceeded");
    expect(error?.message).not.toMatch(/subscription/i);
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

  it("classifies a 429 on stderr as rate_limited, not subscription_limit (CLI #27)", async () => {
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
    expect(error?.category).toBe("rate_limited");
    expect(error?.retryAfterSeconds).toBe(30);
  });

  // CLI #27: the three throttling kinds imply three different user actions, so
  // they must not collapse into one. These are end-to-end through the provider,
  // not just the classifier, because the category the browser receives is what
  // decides which recovery UI it can offer.
  it.each([
    {
      kind: "subscription_limit",
      stderr: "Usage limit reached. Your limits will reset at 04:00 UTC.",
      why: "the user's own weekly/window allowance is spent; waiting or upgrading is the fix",
    },
    {
      kind: "overloaded",
      stderr: "API Error: 529 Overloaded",
      why: "the provider is over capacity; retry, and it is the right trigger for a model fallback",
    },
    {
      kind: "rate_limited",
      stderr: "Number of requests has exceeded your rate limit",
      why: "the provider is throttling this request; nothing is wrong with the plan",
    },
  ])("reports $kind because $why", async ({ kind, stderr }) => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "claude 2.1.0", stderr: "" }),
      spawnFn: (() =>
        new FakeChildProcess({ stdoutChunks: [], stderrChunks: [stderr], exitCode: 1 })) as never,
    });
    const { error } = await collect(
      provider.stream({ model: "opus", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error?.category).toBe(kind);
    // Evidence still travels, so an incident is diagnosable from the report alone.
    expect(error?.message).toContain(stderr.slice(0, 20));
  });
});
