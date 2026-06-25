import { describe, it, expect } from "vitest";
import {
  CodexProvider,
  buildCodexPrompt,
  buildCodexExecArgs,
  agentTextFromEvent,
} from "../codex.js";
import { ClassifiedError, type AnthropicSSEEvent } from "../base.js";
import { FakeChildProcess } from "./test-helpers.js";

describe("codex provider — buildCodexPrompt", () => {
  it("passes a single user turn through verbatim", () => {
    expect(
      buildCodexPrompt({ model: "subscription", messages: [{ role: "user", content: "hello" }] }),
    ).toBe("hello");
  });

  it("prepends the system prompt", () => {
    expect(
      buildCodexPrompt({
        model: "subscription",
        system: "You are helpful.",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toBe("You are helpful.\n\nhi");
  });

  it("role-labels multi-turn conversations", () => {
    const out = buildCodexPrompt({
      model: "subscription",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: "q2" },
      ],
    });
    expect(out).toBe("user: q\n\nassistant: a\n\nuser: q2");
  });

  it("flattens content-block arrays to text", () => {
    expect(
      buildCodexPrompt({
        model: "subscription",
        messages: [
          { role: "user", content: [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ] },
        ],
      }),
    ).toBe("line 1\nline 2");
  });
});

describe("codex provider — buildCodexExecArgs", () => {
  it("runs `codex exec` non-interactively with JSONL, no git requirement, read-only sandbox", () => {
    const args = buildCodexExecArgs();
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args.join(" ")).toContain("--sandbox read-only");
    // No -m: the bridge sends the generic 'subscription' model; Codex uses the
    // user's configured default (bridge-driven model selection is #16).
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--json-input"); // the old, broken flag
  });
});

describe("codex provider — agentTextFromEvent", () => {
  it("extracts text from an agent_message item.completed event", () => {
    expect(
      agentTextFromEvent({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
    ).toBe("hi");
  });
  it("ignores non-agent_message events", () => {
    expect(agentTextFromEvent({ type: "turn.started" })).toBeNull();
    expect(agentTextFromEvent({ type: "item.completed", item: { type: "reasoning", text: "x" } })).toBeNull();
    expect(agentTextFromEvent({ type: "turn.completed", usage: { output_tokens: 3 } })).toBeNull();
  });
});

describe("codex provider — detect()", () => {
  it("returns installed=false when missing", async () => {
    const res = await new CodexProvider({ whichFn: async () => null }).detect();
    expect(res.installed).toBe(false);
  });
  it("returns installed=true when present", async () => {
    const res = await new CodexProvider({
      whichFn: async () => "/Users/x/.codex/bin/codex",
      runCaptureFn: async () => ({ code: 0, stdout: "codex-cli 0.139.0\n", stderr: "" }),
    }).detect();
    expect(res.installed).toBe(true);
    expect(res.version).toBe("0.139.0");
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

  const JSONL = [
    '{"type":"thread.started","thread_id":"t1"}\n',
    '{"type":"turn.started"}\n',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello world"}}\n',
    '{"type":"turn.completed","usage":{"output_tokens":6}}\n',
  ];

  it("parses codex exec --json JSONL into Anthropic SSE + sends the plain prompt on stdin", async () => {
    const fakes: FakeChildProcess[] = [];
    const provider = new CodexProvider({
      whichFn: async () => "/usr/local/bin/codex",
      runCaptureFn: async () => ({ code: 0, stdout: "codex 0.139.0", stderr: "" }),
      spawnFn: (() => {
        const f = new FakeChildProcess({ stdoutChunks: JSONL, exitCode: 0 });
        fakes.push(f);
        return f;
      }) as never,
    });

    const { events, error } = await collect(
      provider.stream({ model: "subscription", messages: [{ role: "user", content: "hello" }] }),
    );
    expect(error).toBeUndefined();
    expect(events[0]?.type).toBe("message_start");
    expect(events.at(-1)?.type).toBe("message_stop");
    const text = events
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e.type === "content_block_delta" ? e.delta.text : ""))
      .join("");
    expect(text).toBe("hello world");
    const usage = events.find((e) => e.type === "message_delta");
    expect(usage?.type === "message_delta" ? usage.usage?.output_tokens : undefined).toBe(6);
    // stdin is the PLAIN prompt, not an OpenAI JSON payload (the old broken contract).
    expect(fakes[0]!.stdinData).toBe("hello");
  });

  it("tolerates JSONL split across stdout chunk boundaries", async () => {
    const provider = new CodexProvider({
      whichFn: async () => "/usr/local/bin/codex",
      runCaptureFn: async () => ({ code: 0, stdout: "codex 0.139.0", stderr: "" }),
      spawnFn: (() =>
        new FakeChildProcess({
          // agent_message line split mid-JSON across two chunks
          stdoutChunks: [
            '{"type":"item.completed","item":{"type":"agent_me',
            'ssage","text":"split ok"}}\n',
          ],
          exitCode: 0,
        })) as never,
    });
    const { events } = await collect(
      provider.stream({ model: "subscription", messages: [{ role: "user", content: "x" }] }),
    );
    const text = events
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e.type === "content_block_delta" ? e.delta.text : ""))
      .join("");
    expect(text).toBe("split ok");
  });

  it("throws cli_missing when the binary is absent", async () => {
    const { error } = await collect(
      new CodexProvider({ whichFn: async () => null }).stream({
        model: "subscription",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(error?.category).toBe("cli_missing");
  });

  it("classifies a non-zero exit as cli_crashed with stderr", async () => {
    const { error } = await collect(
      new CodexProvider({
        whichFn: async () => "/usr/local/bin/codex",
        runCaptureFn: async () => ({ code: 0, stdout: "codex 0.139.0", stderr: "" }),
        spawnFn: (() =>
          new FakeChildProcess({ stderrChunks: ["boom: something broke"], exitCode: 2 })) as never,
      }).stream({ model: "subscription", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error?.category).toBe("cli_crashed");
    expect(error?.message).toContain("boom");
  });

  it("classifies a rate-limit exit as subscription_limit with retry-after", async () => {
    const { error } = await collect(
      new CodexProvider({
        whichFn: async () => "/usr/local/bin/codex",
        runCaptureFn: async () => ({ code: 0, stdout: "codex 0.139.0", stderr: "" }),
        spawnFn: (() =>
          new FakeChildProcess({
            stderrChunks: ["usage limit reached, retry-after: 42"],
            exitCode: 1,
          })) as never,
      }).stream({ model: "subscription", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error?.category).toBe("subscription_limit");
    expect(error?.retryAfterSeconds).toBe(42);
  });

  it("classifies a not-logged-in exit as auth_required", async () => {
    const { error } = await collect(
      new CodexProvider({
        whichFn: async () => "/usr/local/bin/codex",
        runCaptureFn: async () => ({ code: 0, stdout: "codex 0.139.0", stderr: "" }),
        spawnFn: (() =>
          new FakeChildProcess({
            stderrChunks: ["You are not logged in. Run codex login."],
            exitCode: 1,
          })) as never,
      }).stream({ model: "subscription", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error?.category).toBe("auth_required");
  });
});
