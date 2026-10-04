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
import { parsePlainResult } from "../claude-research.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    // proposition-app v1.15.0 (#708): bridge Max sends claude-fable-5-1 and the
    // Deep fallback ladder sends claude-opus-5 then claude-opus-4-8. The old
    // substring mapping sent Fable to 'sonnet' (so Max ran Sonnet while the
    // provenance said Fable) and collapsed every Opus rung back to 'opus'.
    // `claude --model` accepts full ids, so they pass through verbatim.
    it("passes full claude-* model IDs through verbatim, so Max really runs Fable", () => {
      expect(mapToClaudeCliModel("claude-fable-5-1")).toBe("claude-fable-5-1");
      expect(mapToClaudeCliModel("claude-fable-5")).toBe("claude-fable-5");
      expect(mapToClaudeCliModel("claude-opus-5")).toBe("claude-opus-5");
      expect(mapToClaudeCliModel("claude-opus-4-8")).toBe("claude-opus-4-8");
      expect(mapToClaudeCliModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    });
    it("lower-cases a full id before passing it through", () => {
      expect(mapToClaudeCliModel("Claude-Fable-5-1")).toBe("claude-fable-5-1");
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

  // seanpropapp-cli#39: the bridge spawned `claude --print` with the user's
  // full MCP configuration, including claude.ai connectors. With the SeanPropApp
  // connector present the model called it instead of writing the module, and the
  // "tool requires permission" meta-reply was saved as the module output. A
  // module run must never see the user's MCP servers.
  it("spawns claude with no user MCP servers (strict empty config, claude.ai connectors off)", async () => {
    let seen: { args: string[]; opts: { env?: Record<string, string | undefined> } } | undefined;
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "claude 1.0.5", stderr: "" }),
      spawnFn: ((_bin: string, args: string[], opts: never) => {
        seen = { args, opts };
        return new FakeChildProcess({ stdoutChunks: ["ok"], exitCode: 0 });
      }) as never,
    });
    await collect(provider.stream({ model: "opus", messages: [{ role: "user", content: "Run the Company Context module." }] }));
    const args = seen!.args;
    expect(args).toContain("--strict-mcp-config");
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(args[i + 1]!)).toEqual({ mcpServers: {} });
    expect(seen!.opts.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    // And none of the user's own Claude Code context: no user setting source
    // (CLAUDE.md, plugins), and an empty working directory, not the folder the
    // bridge was launched from.
    const j = args.indexOf("--setting-sources");
    expect(args[j + 1]).toBe("project,local");
    expect((seen!.opts as { cwd?: string }).cwd).toMatch(/seanpropapp-bridge-run$/);
    expect((seen!.opts as { cwd?: string }).cwd).not.toBe(process.cwd());
    // The rest of the environment still reaches the CLI (auth, PATH).
    expect(seen!.opts.env?.PATH).toBe(process.env.PATH);
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

  // VERBATIM from a real run, 2026-10-03, plain --print path: the CLI printed
  // this on stdout and exited 1. The bridge reported `cli_crashed`, and because
  // stdout was forwarded as it arrived, the app received the sentence as the
  // first text of the module and then an error for the same run.
  const SESSION_LIMIT = "You've hit your session limit · resets 10:10pm (Europe/London)";

  it("classifies a spent session window as subscription_limit, with the reset time, and sends none of it as text", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawnFn: (() => new FakeChildProcess({ stdoutChunks: [SESSION_LIMIT + "\n"], exitCode: 1 })) as never,
    });
    const { events, error } = await collect(
      provider.stream({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error).toBeInstanceOf(ClassifiedError);
    expect(error?.category).toBe("subscription_limit");
    expect(error?.resetsAt).toBe("10:10pm (Europe/London)");
    expect(error?.message).toContain("session limit");
    // The limit sentence never reaches the client as module text.
    expect(events.filter((e) => e.type === "content_block_delta")).toEqual([]);
    // And the stream did not also report success.
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });

  it("holds the answer until the exit code is known, then sends all of it in order", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawnFn: (() => new FakeChildProcess({ stdoutChunks: ["First. ", "Second. ", "Third."], exitCode: 0 })) as never,
    });
    const { events, error } = await collect(
      provider.stream({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error).toBeUndefined();
    const text = events.map((e) => (e.type === "content_block_delta" ? e.delta.text : "")).join("");
    expect(text).toBe("First. Second. Third.");
    expect(events.map((e) => e.type).filter((t) => t !== "content_block_delta")).toEqual([
      "message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop",
    ]);
  });

  it("a failed run of any kind sends no text: a crash explanation is evidence, not content", async () => {
    const provider = new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawnFn: (() => new FakeChildProcess({ stdoutChunks: ["There's an issue with the selected model (nope).\n"], exitCode: 1 })) as never,
    });
    const { events, error } = await collect(
      provider.stream({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error?.category).toBe("cli_crashed");
    expect(error?.resetsAt).toBeUndefined();
    expect(events.filter((e) => e.type === "content_block_delta")).toEqual([]);
  });

  // The plain (tool-less) path reported usage 0/0 because `claude --print`
  // prints text only. It now asks for the JSON result. The two fixtures are
  // REAL output of Claude Code 2.1.289, captured 2026-10-04 with the bridge's
  // own flags (session id removed): a one-word answer, and a model that does
  // not exist (exit 1).
  describe("plain path: usage from the CLI's JSON result", () => {
    const fixture = (name: string) =>
      readFileSync(join(__dirname, "fixtures", `plain-result-${name}.json`), "utf8");
    const providerWith = (stdoutChunks: string[], exitCode: number, onSpawn?: (args: string[]) => void) =>
      new ClaudeProvider({
        whichFn: async () => "/usr/local/bin/claude",
        runCaptureFn: async () => ({ code: 0, stdout: "", stderr: "" }),
        spawnFn: ((_bin: string, args: string[]) => {
          onSpawn?.(args);
          return new FakeChildProcess({ stdoutChunks, exitCode });
        }) as never,
      });
    const run = (p: ClaudeProvider, research?: boolean) =>
      collect(p.stream({
        model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }],
        ...(research ? { research: { maxSearches: 1, maxFetches: 1 } } : {}),
      } as never));

    it("parsePlainResult reads the real success: the answer, and input that counts the cached tokens", () => {
      const r = parsePlainResult(fixture("success"));
      // usage.input_tokens alone is 9; the run consumed 9 + 14,976 cache creation.
      expect(r).toEqual({ text: "pong", isError: false, inputTokens: 14985, outputTokens: 45 });
    });

    it("parsePlainResult reads the real failure as an error with the CLI's explanation", () => {
      const r = parsePlainResult(fixture("bad-model"));
      expect(r?.isError).toBe(true);
      expect(r?.text).toContain("There's an issue with the selected model (nosuchmodel-zz)");
      expect(r).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    });

    it("parsePlainResult returns null for anything that is not the result object", () => {
      expect(parsePlainResult("Hello world")).toBeNull();
      expect(parsePlainResult("")).toBeNull();
      expect(parsePlainResult('{"tam": "$9B"}')).toBeNull();
      expect(parsePlainResult('{"type":"result"}')).toBeNull();
      expect(parsePlainResult("{not json")).toBeNull();
      // An array of events (some CLI versions): the result event is taken from it.
      expect(parsePlainResult('[{"type":"system"},{"type":"result","result":"x","usage":{"input_tokens":3,"output_tokens":2}}]'))
        .toEqual({ text: "x", isError: false, inputTokens: 3, outputTokens: 2 });
    });

    it("a plain run asks for JSON, sends the answer as text and reports the real usage", async () => {
      let args: string[] = [];
      // Split mid-object, as a pipe would.
      const raw = fixture("success");
      const { events, error } = await run(providerWith([raw.slice(0, 700), raw.slice(700)], 0, (a) => { args = a; }));
      expect(error).toBeUndefined();
      expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "json"]);
      const text = events.map((e) => (e.type === "content_block_delta" ? e.delta.text : "")).join("");
      expect(text).toBe("pong");
      const delta = events.find((e) => e.type === "message_delta");
      expect(delta).toMatchObject({ usage: { output_tokens: 45, input_tokens: 14985 } });
      expect(events.map((e) => e.type)).toEqual([
        "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
      ]);
    });

    it("a research run keeps stream-json and never gets the plain flag", async () => {
      let args: string[] = [];
      await run(providerWith([], 1, (a) => { args = a; }), true);
      expect(args).toContain("stream-json");
      expect(args).not.toContain("json");
    });

    it("the real failed run: classified from what the CLI said, and none of it sent as text", async () => {
      const { events, error } = await run(providerWith([fixture("bad-model")], 1));
      expect(error?.category).toBe("cli_crashed");
      expect(error?.message).toContain("There's an issue with the selected model (nosuchmodel-zz)");
      // The evidence is the explanation, not the JSON around it.
      expect(error?.message).not.toContain("duration_api_ms");
      expect(events.filter((e) => e.type === "content_block_delta")).toEqual([]);
      expect(events.some((e) => e.type === "message_stop")).toBe(false);
    });

    it("a spent session window inside the JSON result is still subscription_limit with its reset time", async () => {
      // Constructed: the real failure object with the real limit sentence in
      // `result`. No real capture of this exists (it needs a spent window).
      const obj = { ...JSON.parse(fixture("bad-model")), result: SESSION_LIMIT, api_error_status: 429 };
      const { events, error } = await run(providerWith([JSON.stringify(obj)], 1));
      expect(error?.category).toBe("subscription_limit");
      expect(error?.resetsAt).toBe("10:10pm (Europe/London)");
      expect(events.filter((e) => e.type === "content_block_delta")).toEqual([]);
    });

    it("the numbers in a failed result's JSON are not read as a throttle", async () => {
      // api_error_status 404 and the usage block sit beside the message. Only
      // the message is evidence.
      const obj = { ...JSON.parse(fixture("bad-model")), api_error_status: 429, result: "Something else went wrong." };
      const { error } = await run(providerWith([JSON.stringify(obj)], 1));
      expect(error?.category).toBe("cli_crashed");
    });

    it("is_error with exit 0 is still a failure", async () => {
      const obj = { ...JSON.parse(fixture("bad-model")) };
      const { events, error } = await run(providerWith([JSON.stringify(obj)], 0));
      expect(error).toBeInstanceOf(ClassifiedError);
      expect(events.filter((e) => e.type === "content_block_delta")).toEqual([]);
    });

    it("stdout that is not the result object is the text, with no usage (an older CLI)", async () => {
      const { events, error } = await run(providerWith(['{"tam": ', '"$9B"}'], 0));
      expect(error).toBeUndefined();
      expect(events.map((e) => (e.type === "content_block_delta" ? e.delta.text : "")).join("")).toBe('{"tam": "$9B"}');
      expect(events.find((e) => e.type === "message_delta")).toMatchObject({ usage: { output_tokens: 0 } });
    });
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
