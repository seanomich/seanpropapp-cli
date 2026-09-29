/**
 * Research mode for the Claude provider (proposition-app#716).
 *
 * A module run with `research` set spawns Claude Code with its WebSearch and
 * WebFetch tools permitted and `--output-format stream-json`, then re-emits what
 * the CLI did in the SAME wire shape the Anthropic Messages API uses for its
 * server-side web tools (`server_tool_use`, `web_search_tool_result`,
 * `web_fetch_tool_result`). The app therefore needs one parser and builds one
 * retrieval ledger, whether the run went through an API key or this bridge.
 *
 * Every shape below was MEASURED against Claude Code 2.1.285 on 2026-09-29, not
 * inferred (the rule this repo learned on the rate-limit content gate):
 *
 *   assistant  message.content[] carries `tool_use` blocks
 *              { id, name: "WebSearch", input: { query } }
 *              { id, name: "WebFetch",  input: { url, prompt } }
 *   user       carries the result twice: a `tool_result` block (text for the
 *              model) and a structured top-level `tool_use_result`:
 *                WebSearch  { query, results: [ { tool_use_id, content: [ { title, url } ] }, "prose" ] }
 *                WebFetch   { bytes, code, codeText, result, durationMs, url }
 *                failure    a plain string ("Error: getaddrinfo ENOTFOUND ..."),
 *                           with `is_error: true` on the tool_result block
 *              A 404 is NOT an error at this level: it arrives as a normal
 *              WebFetch result with `code: 404` and `bytes: 0`.
 *   result     { is_error, subtype, result: "<final answer text>", usage }
 *
 * Only URLs, titles and timestamps are forwarded. Page content never leaves the
 * CLI process: the app's ledger records WHAT was retrieved, and forwarding the
 * text would multiply the stream size for nothing the app uses.
 */
import type { AnthropicSSEEvent } from "./base.js";

/** Claude Code tool names, mapped to the Anthropic server-tool names. */
const TOOL_NAME_MAP: Record<string, "web_search" | "web_fetch"> = {
  WebSearch: "web_search",
  WebFetch: "web_fetch",
};

/** The flags that turn a plain `--print` run into a research run. */
export function researchArgs(): string[] {
  return [
    // Restricts the built-in tool set to these two, so a research run cannot
    // read files or run commands on the user's machine.
    "--tools", "WebSearch,WebFetch",
    // Permits them without a prompt nobody is there to answer.
    "--allowedTools", "WebSearch,WebFetch",
    "--output-format", "stream-json",
    // stream-json requires --verbose in print mode.
    "--verbose",
  ];
}

interface SearchHit { title?: string; url?: string }

/** Pull `{title,url}` hits out of a WebSearch `tool_use_result`. */
export function searchHits(toolUseResult: unknown): SearchHit[] {
  if (!toolUseResult || typeof toolUseResult !== "object") return [];
  const results = (toolUseResult as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const r of results) {
    // The array mixes structured entries with prose strings; only the
    // structured ones carry links.
    if (!r || typeof r !== "object") continue;
    const content = (r as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const { title, url } = c as SearchHit;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        hits.push({ url, ...(typeof title === "string" ? { title } : {}) });
      }
    }
  }
  return hits;
}

export interface ResearchParseState {
  /** Next content block index to emit. */
  index: number;
  /** tool_use id -> what was called, so a result can be paired with its call. */
  calls: Map<string, { name: "web_search" | "web_fetch"; url?: string }>;
  /** Set once the `result` event arrives. */
  final: {
    text: string;
    isError: boolean;
    outputTokens: number;
    inputTokens: number;
  } | null;
}

export function newResearchParseState(): ResearchParseState {
  // Index 0 is reserved for nothing in particular; blocks are numbered in the
  // order they are emitted, as the Messages API does.
  return { index: 0, calls: new Map(), final: null };
}

/**
 * Translate ONE parsed stream-json event into zero or more Anthropic-shape
 * events. Pure apart from `state`, so it is unit-tested against captured lines.
 *
 * `now` is injectable so a fetch's `retrieved_at` is deterministic in tests.
 */
export function translateResearchEvent(
  evt: unknown,
  state: ResearchParseState,
  now: () => Date = () => new Date(),
): AnthropicSSEEvent[] {
  if (!evt || typeof evt !== "object") return [];
  const e = evt as {
    type?: string;
    message?: { content?: unknown };
    tool_use_result?: unknown;
    is_error?: boolean;
    result?: unknown;
    usage?: { output_tokens?: number; input_tokens?: number };
    modelUsage?: unknown;
  };
  const out: AnthropicSSEEvent[] = [];

  if (e.type === "assistant" && Array.isArray(e.message?.content)) {
    for (const b of e.message.content as Array<Record<string, unknown>>) {
      if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
      const name = TOOL_NAME_MAP[String(b.name)];
      if (!name) continue;
      const input = (b.input ?? {}) as { query?: unknown; url?: unknown };
      const url = typeof input.url === "string" ? input.url : undefined;
      state.calls.set(b.id, { name, url });
      const index = state.index++;
      out.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "server_tool_use",
          id: b.id,
          name,
          input:
            name === "web_search"
              ? { query: typeof input.query === "string" ? input.query : "" }
              : { url: url ?? "" },
        },
      });
      out.push({ type: "content_block_stop", index });
    }
    return out;
  }

  if (e.type === "user" && Array.isArray(e.message?.content)) {
    for (const b of e.message.content as Array<Record<string, unknown>>) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const call = state.calls.get(b.tool_use_id);
      if (!call) continue;
      const failed = b.is_error === true || typeof e.tool_use_result === "string";
      const index = state.index++;
      if (call.name === "web_search") {
        out.push({
          type: "content_block_start",
          index,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: b.tool_use_id,
            content: failed
              ? { type: "web_search_tool_result_error", error_code: "unavailable" }
              : searchHits(e.tool_use_result).map((h) => ({
                  type: "web_search_result" as const,
                  url: h.url as string,
                  ...(h.title ? { title: h.title } : {}),
                })),
          },
        });
      } else {
        const r = (failed ? {} : e.tool_use_result ?? {}) as { code?: unknown; url?: unknown };
        const code = typeof r.code === "number" ? r.code : null;
        const ok = !failed && code !== null && code >= 200 && code < 300;
        const url = typeof r.url === "string" ? r.url : call.url ?? "";
        out.push({
          type: "content_block_start",
          index,
          content_block: {
            type: "web_fetch_tool_result",
            tool_use_id: b.tool_use_id,
            content: ok
              ? { type: "web_fetch_result", url, retrieved_at: now().toISOString() }
              : { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" },
          },
        });
      }
      out.push({ type: "content_block_stop", index });
    }
    return out;
  }

  if (e.type === "result") {
    const total = totalUsage(e.modelUsage);
    state.final = {
      text: typeof e.result === "string" ? e.result : "",
      isError: e.is_error === true,
      outputTokens: total?.output ?? e.usage?.output_tokens ?? 0,
      inputTokens: total?.input ?? e.usage?.input_tokens ?? 0,
    };
  }
  return out;
}

/**
 * Whole-run token totals from the result event's `modelUsage`.
 *
 * `usage.input_tokens` is NOT the run's input: measured on a real research run
 * it read 26 while the run had consumed thousands, because it excludes cached
 * input and covers only part of a multi-step run. `modelUsage` is per model
 * across every step, with cache reads and writes reported separately, so the
 * run's real input is the three added together.
 */
export function totalUsage(modelUsage: unknown): { input: number; output: number } | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  let input = 0;
  let output = 0;
  let seen = false;
  for (const m of Object.values(modelUsage as Record<string, unknown>)) {
    if (!m || typeof m !== "object") continue;
    const u = m as Record<string, unknown>;
    const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
    input += n("inputTokens") + n("cacheReadInputTokens") + n("cacheCreationInputTokens");
    output += n("outputTokens");
    seen = true;
  }
  return seen ? { input, output } : null;
}

/**
 * Split a byte stream into complete lines. stdout chunk boundaries do not
 * respect JSONL line boundaries, and a search result line is several kB, so a
 * line regularly arrives in pieces.
 */
export class LineBuffer {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    return lines.filter((l) => l.trim().length > 0);
  }
  /** Whatever is left once the stream ends (a final line with no newline). */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}
