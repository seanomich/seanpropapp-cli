import { describe, it, expect } from "vitest";
import {
  LineBuffer,
  newResearchParseState,
  researchArgs,
  searchHits,
  translateResearchEvent,
} from "../claude-research.js";
import { ClaudeProvider } from "../claude.js";
import { ClassifiedError, type AnthropicSSEEvent } from "../base.js";
import { FakeChildProcess } from "./test-helpers.js";

/**
 * Event shapes captured from Claude Code 2.1.285 on 2026-09-29 (proposition-
 * app#716), trimmed to the fields the translator reads. Session ids, uuids and
 * page content are removed; the STRUCTURE is exactly what the CLI emitted,
 * including the prose string mixed into a search's `results` array and the
 * plain-string `tool_use_result` of a failed fetch.
 */
const SEARCH_CALL = {
  type: "assistant",
  message: {
    content: [
      { type: "thinking", thinking: "" },
      { type: "tool_use", id: "toolu_search1", name: "WebSearch", input: { query: "Acme funding round 2026" } },
    ],
  },
};
const SEARCH_RESULT = {
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: "toolu_search1", content: 'Web search results for query: "Acme"\n\nLinks: [...]' },
    ],
  },
  tool_use_result: {
    query: "Acme funding round 2026",
    results: [
      {
        tool_use_id: "srvtoolu_x",
        content: [
          { title: "Acme raises Series B", url: "https://example.com/news/series-b" },
          { title: "Acme profile", url: "https://example.org/acme" },
        ],
      },
      "Based on the search results, Acme raised a Series B.",
    ],
  },
};
const FETCH_CALL = {
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id: "toolu_fetch1", name: "WebFetch", input: { url: "https://example.com/news/series-b", prompt: "What does it announce?" } },
    ],
  },
};
const FETCH_OK = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_fetch1", content: "# Acme Series B ..." }] },
  tool_use_result: { bytes: 147818, code: 200, codeText: "OK", result: "# Acme Series B ...", durationMs: 594, url: "https://example.com/news/series-b" },
};
const FETCH_404 = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_fetch1", content: "The server returned HTTP 404 Not Found." }] },
  tool_use_result: { bytes: 0, code: 404, codeText: "Not Found", result: "The server returned HTTP 404 Not Found.", durationMs: 594, url: "https://example.com/news/series-b" },
};
const FETCH_DNS_FAILURE = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_fetch1", content: "getaddrinfo ENOTFOUND nope.example", is_error: true }] },
  tool_use_result: "Error: getaddrinfo ENOTFOUND nope.example",
};
const RESULT_OK = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Acme raised a Series B.\n\nSources:\n- [Acme raises Series B](https://example.com/news/series-b) (2026-05-28)",
  usage: { input_tokens: 5283, output_tokens: 617 },
};

const FIXED_NOW = () => new Date("2026-09-29T21:00:00.000Z");

function blocks(events: AnthropicSSEEvent[]) {
  return events.flatMap((e) => (e.type === "content_block_start" ? [e.content_block] : []));
}

describe("claude research — translateResearchEvent", () => {
  it("re-emits a search as server_tool_use then web_search_tool_result, links only", () => {
    const state = newResearchParseState();
    const out = [
      ...translateResearchEvent(SEARCH_CALL, state, FIXED_NOW),
      ...translateResearchEvent(SEARCH_RESULT, state, FIXED_NOW),
    ];
    expect(blocks(out)).toEqual([
      { type: "server_tool_use", id: "toolu_search1", name: "web_search", input: { query: "Acme funding round 2026" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "toolu_search1",
        content: [
          { type: "web_search_result", url: "https://example.com/news/series-b", title: "Acme raises Series B" },
          { type: "web_search_result", url: "https://example.org/acme", title: "Acme profile" },
        ],
      },
    ]);
  });

  it("re-emits a successful fetch with its URL and a retrieval time, never the page text", () => {
    const state = newResearchParseState();
    const out = [
      ...translateResearchEvent(FETCH_CALL, state, FIXED_NOW),
      ...translateResearchEvent(FETCH_OK, state, FIXED_NOW),
    ];
    expect(blocks(out)[1]).toEqual({
      type: "web_fetch_tool_result",
      tool_use_id: "toolu_fetch1",
      content: { type: "web_fetch_result", url: "https://example.com/news/series-b", retrieved_at: "2026-09-29T21:00:00.000Z" },
    });
    expect(JSON.stringify(out)).not.toContain("Acme Series B ...");
  });

  // A 404 is a NORMAL tool result at the CLI level (code 404, bytes 0), not an
  // is_error one. Reading only is_error would record a page that was never read
  // as a retrieved source, which is the exact failure #702 exists to catch.
  it("reports a 404 as not accessible even though the CLI did not flag an error", () => {
    const state = newResearchParseState();
    translateResearchEvent(FETCH_CALL, state, FIXED_NOW);
    const out = translateResearchEvent(FETCH_404, state, FIXED_NOW);
    expect(blocks(out)[0]).toEqual({
      type: "web_fetch_tool_result",
      tool_use_id: "toolu_fetch1",
      content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" },
    });
  });

  it("reports a transport failure (string tool_use_result, is_error) as not accessible", () => {
    const state = newResearchParseState();
    translateResearchEvent(FETCH_CALL, state, FIXED_NOW);
    const out = translateResearchEvent(FETCH_DNS_FAILURE, state, FIXED_NOW);
    expect(blocks(out)[0]).toMatchObject({
      type: "web_fetch_tool_result",
      content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" },
    });
  });

  it("reports a failed search as an error object, not an empty result list", () => {
    const state = newResearchParseState();
    translateResearchEvent(SEARCH_CALL, state, FIXED_NOW);
    const out = translateResearchEvent(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_search1", content: "search failed", is_error: true }] }, tool_use_result: "Error: search failed" },
      state,
      FIXED_NOW,
    );
    expect(blocks(out)[0]).toEqual({
      type: "web_search_tool_result",
      tool_use_id: "toolu_search1",
      content: { type: "web_search_tool_result_error", error_code: "unavailable" },
    });
  });

  it("numbers blocks in emission order and ignores tools it does not know", () => {
    const state = newResearchParseState();
    const out = [
      ...translateResearchEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "ls" } }] } }, state),
      ...translateResearchEvent(SEARCH_CALL, state),
      ...translateResearchEvent(SEARCH_RESULT, state),
    ];
    const starts = out.filter((e) => e.type === "content_block_start");
    expect(starts.map((e) => (e.type === "content_block_start" ? e.index : -1))).toEqual([0, 1]);
  });

  it("captures the final answer and usage from the result event, emitting nothing for it", () => {
    const state = newResearchParseState();
    expect(translateResearchEvent(RESULT_OK, state)).toEqual([]);
    expect(state.final).toEqual({ text: RESULT_OK.result, isError: false, outputTokens: 617, inputTokens: 5283 });
  });

  // Measured on a real run: usage.input_tokens read 26 for a run that consumed
  // thousands of input tokens, because it leaves out cached input.
  it("reports whole-run tokens from modelUsage, cache reads and writes included", () => {
    const state = newResearchParseState();
    translateResearchEvent(
      {
        ...RESULT_OK,
        usage: { input_tokens: 26, output_tokens: 617 },
        modelUsage: {
          "claude-haiku-4-5-20251001": { inputTokens: 460, cacheReadInputTokens: 12000, cacheCreationInputTokens: 4000, outputTokens: 952 },
        },
      },
      state,
    );
    expect(state.final).toMatchObject({ inputTokens: 16460, outputTokens: 952 });
  });

  it("ignores system, thinking and rate-limit events, and malformed input", () => {
    const state = newResearchParseState();
    for (const evt of [{ type: "system", subtype: "init" }, { type: "rate_limit_event" }, null, "text", 7, { type: "assistant" }]) {
      expect(translateResearchEvent(evt, state)).toEqual([]);
    }
  });
});

describe("claude research — searchHits", () => {
  it("skips prose entries and anything that is not an http(s) link", () => {
    expect(
      searchHits({ results: ["prose", { content: [{ title: "a", url: "javascript:alert(1)" }, { url: "https://ok.example/x" }] }] }),
    ).toEqual([{ url: "https://ok.example/x" }]);
  });
  it("returns nothing for a failure string or an unexpected shape", () => {
    expect(searchHits("Error: boom")).toEqual([]);
    expect(searchHits({ results: "nope" })).toEqual([]);
    expect(searchHits(undefined)).toEqual([]);
  });
});

describe("claude research — LineBuffer", () => {
  it("reassembles a line split across chunks", () => {
    const b = new LineBuffer();
    expect(b.push('{"a":')).toEqual([]);
    expect(b.push('1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(b.push(":3}")).toEqual([]);
    expect(b.flush()).toEqual(['{"c":3}']);
    expect(b.flush()).toEqual([]);
  });
});

describe("claude provider — research run", () => {
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
  function provider(stdoutChunks: string[], exitCode = 0, seen?: { args?: string[] }) {
    return new ClaudeProvider({
      whichFn: async () => "/usr/local/bin/claude",
      runCaptureFn: async () => ({ code: 0, stdout: "2.1.285 (Claude Code)", stderr: "" }),
      spawnFn: ((_bin: string, args: string[]) => {
        if (seen) seen.args = args;
        return new FakeChildProcess({ stdoutChunks, exitCode });
      }) as never,
    });
  }
  const jsonl = (...evts: unknown[]) => evts.map((e) => JSON.stringify(e)).join("\n") + "\n";

  it("permits only the two web tools and asks for stream-json", async () => {
    const seen: { args?: string[] } = {};
    await collect(provider([jsonl(RESULT_OK)], 0, seen).stream({ model: "haiku", messages: [{ role: "user", content: "x" }], research: {} }));
    const args = seen.args!;
    expect(args.slice(-researchArgs().length)).toEqual(researchArgs());
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
    // The isolation flags from seanpropapp-cli#39 still apply to a research run.
    expect(args).toContain("--strict-mcp-config");
  });

  // The research flags must never leak into an ordinary run: `--tools` changes
  // what the model can do, and stream-json would put raw JSON into the module.
  it("leaves a run WITHOUT research on exactly the arguments it had before", async () => {
    const seen: { args?: string[] } = {};
    await collect(provider(["ok"], 0, seen).stream({ model: "haiku", system: "sys", messages: [{ role: "user", content: "x" }] }));
    expect(seen.args).toEqual([
      "--print", "--model", "haiku",
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
      "--setting-sources", "project,local",
      "--system-prompt", "sys",
    ]);
  });

  it("streams the tool blocks, then the final answer as the only text", async () => {
    const all = jsonl({ type: "system", subtype: "init" }, SEARCH_CALL, SEARCH_RESULT, FETCH_CALL, FETCH_OK, RESULT_OK);
    // Split mid-line on purpose: stdout chunks do not respect line boundaries.
    const cut = Math.floor(all.length / 3);
    const { events, error } = await collect(
      provider([all.slice(0, cut), all.slice(cut, cut * 2), all.slice(cut * 2)]).stream({
        model: "haiku", messages: [{ role: "user", content: "x" }], research: { max_searches: 5 },
      }),
    );
    expect(error).toBeUndefined();
    expect(blocks(events).map((b) => b.type)).toEqual([
      "server_tool_use", "web_search_tool_result", "server_tool_use", "web_fetch_tool_result", "text",
    ]);
    const text = events.flatMap((e) => (e.type === "content_block_delta" ? [e.delta.text] : [])).join("");
    expect(text).toBe(RESULT_OK.result);
    // No raw JSON reached the text channel, which is what gets saved as the module.
    expect(text).not.toContain('"type"');
    const delta = events.find((e) => e.type === "message_delta");
    expect(delta).toMatchObject({ usage: { output_tokens: 617, input_tokens: 5283 } });
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  it("fails the run when the result event reports an error, even on exit 0", async () => {
    const { error, events } = await collect(
      provider([jsonl({ type: "result", subtype: "error_during_execution", is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' })]).stream({
        model: "haiku", messages: [{ role: "user", content: "x" }], research: {},
      }),
    );
    expect(error?.category).toBe("overloaded");
    expect(events.some((e) => e.type === "message_stop")).toBe(false);
  });

  it("fails the run when no result event arrived at all", async () => {
    const { error } = await collect(
      provider([jsonl(SEARCH_CALL, SEARCH_RESULT)]).stream({ model: "haiku", messages: [{ role: "user", content: "x" }], research: {} }),
    );
    expect(error?.category).toBe("cli_crashed");
  });

  it("keeps plain-text CLI output as failure evidence on a non-zero exit", async () => {
    const { error } = await collect(
      provider(["There's an issue with the selected model (nope).\n"], 1).stream({ model: "haiku", messages: [{ role: "user", content: "x" }], research: {} }),
    );
    expect(error?.category).toBe("cli_crashed");
    expect(error?.message).toContain("issue with the selected model");
  });
});
