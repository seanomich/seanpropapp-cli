/**
 * End-to-end cover for mitigation 2 of the 2026-07-25 incident: generated
 * content is only trusted as a refusal signal BEFORE the run has emitted real
 * output.
 *
 * This is the mitigation that actually killed the production run. The user's
 * Competitive Landscape module streamed a real analysis, that analysis discussed
 * competitor rate limits, and the detector reading the content stream converted
 * a working run into "Subscription rate limit" against a healthy subscription.
 *
 * Pattern tightening alone is not sufficient, which is why this is tested
 * separately: prose can legitimately contain a refusal-shaped phrase (a module
 * quoting "customers who have reached their plan limits"). The content gate is
 * what makes that survivable.
 */
import { describe, it, expect } from "vitest";
import { ClaudeProvider } from "../claude.js";
import { CodexProvider } from "../codex.js";
import { FakeChildProcess } from "./test-helpers.js";
import { ClassifiedError } from "../index.js";
import type { AnthropicSSEEvent } from "../types.js";

async function collect(iter: AsyncIterable<AnthropicSSEEvent>) {
  const events: AnthropicSSEEvent[] = [];
  try {
    for await (const ev of iter) events.push(ev);
    return { events, error: undefined as ClassifiedError | undefined };
  } catch (err) {
    if (err instanceof ClassifiedError) return { events, error: err };
    throw err;
  }
}

function textOf(events: AnthropicSSEEvent[]): string {
  return events
    .filter((e) => e.type === "content_block_delta")
    .map((e) => (e.type === "content_block_delta" ? e.delta.text : ""))
    .join("");
}

function claudeWith(stdoutChunks: string[], exitCode = 0, stderrChunks: string[] = []) {
  return new ClaudeProvider({
    whichFn: async () => "/usr/local/bin/claude",
    runCaptureFn: async () => ({ code: 0, stdout: "claude 2.1.0", stderr: "" }),
    spawnFn: (() => new FakeChildProcess({ stdoutChunks, stderrChunks, exitCode })) as never,
  });
}

const REQ = { model: "opus", messages: [{ role: "user" as const, content: "analyze" }] };

describe("claude: an analysis that DISCUSSES limits must still complete", () => {
  it("does not abort a run whose prose mentions competitor rate limits", async () => {
    // Verbatim shape of the module that broke in production.
    const analysis =
      "## Competitive Landscape\n\n" +
      "Datadog reached $429M ARR in observability. Its public API enforces a " +
      "rate limit of 1,000 requests per minute, and subscription limits differ " +
      "by plan tier. Customers hitting HTTP 429 are throttled, not blocked.\n";
    const { events, error } = await collect(claudeWith([analysis]).stream(REQ));

    expect(error).toBeUndefined();
    expect(textOf(events)).toBe(analysis);
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  it("survives a refusal-SHAPED phrase once real content is already flowing", async () => {
    // The case pattern-tightening alone cannot catch: legitimate prose that
    // literally matches a refusal pattern. The content gate carries it.
    const { events, error } = await collect(
      claudeWith([
        "## Pricing pressure\n\nMid-market buyers churn when they ",
        "have reached their plan limits mid-quarter.\n",
      ]).stream(REQ),
    );

    expect(error).toBeUndefined();
    expect(textOf(events)).toContain("reached their plan limits");
  });
});

describe("claude: a genuine refusal is still caught", () => {
  it("classifies a limit notice that arrives INSTEAD of content", async () => {
    // No content precedes it, which is what a real refusal looks like.
    const { error } = await collect(
      claudeWith(["Usage limit reached. Your limits will reset at 04:00 UTC.\n"]).stream(REQ),
    );

    expect(error).toBeDefined();
    expect(error!.category).toBe("subscription_limit");
  });

  it("trusts stderr even when the run produced output", async () => {
    // stderr never carries analysis prose, so it stays fully trusted. Without
    // this the tightening would cost us real detections on mid-run terminations.
    const { error } = await collect(
      claudeWith(
        ["Partial analysis of the landscape"],
        1,
        ["Error: usage limit reached for this account.\n"],
      ).stream(REQ),
    );

    expect(error).toBeDefined();
    expect(error!.category).toBe("subscription_limit");
  });
});

describe("codex: a SUCCESSFUL run is never reclassified as a refusal", () => {
  function codexWith(stdoutChunks: string[], exitCode = 0) {
    return new CodexProvider({
      whichFn: async () => "/usr/local/bin/codex",
      runCaptureFn: async () => ({ code: 0, stdout: "codex 0.139.0", stderr: "" }),
      spawnFn: (() => new FakeChildProcess({ stdoutChunks, exitCode })) as never,
    });
  }

  it("keeps a finished analysis that mentions rate limits", async () => {
    // The worst of the two bugs: codex ran this check on a ZERO exit, so a
    // completed analysis was thrown away and reported as a provider limit.
    const text = "Competitors publish a rate limit of 1,000 rpm; 429 responses are retried.";
    const { events, error } = await collect(
      codexWith([
        '{"type":"turn.started"}\n',
        `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(text)}}}\n`,
        '{"type":"turn.completed","usage":{"output_tokens":40}}\n',
      ]).stream({ model: "subscription", messages: [{ role: "user", content: "analyze" }] }),
    );

    expect(error).toBeUndefined();
    expect(textOf(events)).toBe(text);
  });

  it("still catches a refusal emitted with no agent output at all", async () => {
    const { error } = await collect(
      codexWith(
        ['{"type":"error","message":"Rate limit exceeded. Try again in 600s."}\n'],
        1,
      ).stream({ model: "subscription", messages: [{ role: "user", content: "analyze" }] }),
    );

    expect(error).toBeDefined();
    expect(error!.category).toBe("subscription_limit");
    expect(error!.retryAfterSeconds).toBe(600);
  });
});
