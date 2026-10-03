import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRateLimit, parseRetryAfter, parseResetTime, classifyThrottle, throttleHeadline } from "./rate-limit-detect.js";
export { detectRateLimit, parseRetryAfter };
import { spawn } from "node:child_process";
import {
  ClassifiedError,
  type AnthropicLikeRequest,
  type AnthropicSSEEvent,
  type Provider,
  type ProviderDetectResult,
} from "./base.js";
import { runCapture, which } from "./detect-util.js";
import {
  LineBuffer,
  newResearchParseState,
  researchArgs,
  translateResearchEvent,
} from "./claude-research.js";

/**
 * Override hooks for testing. The provider takes optional injectables so we
 * can mock subprocess behavior without complex module mocks.
 */
export interface ClaudeProviderDeps {
  whichFn?: (bin: string) => Promise<string | null>;
  runCaptureFn?: typeof runCapture;
  spawnFn?: typeof spawn;
  binaryName?: string;
}

const DEFAULT_BINARY = "claude";

/**
 * Map an incoming Anthropic-style model name (whatever the browser sends in
 * the POST body) to one of the three model tiers Claude CLI accepts on its
 * `--model` flag: `opus`, `sonnet`, `haiku`.
 *
 * Inputs we handle:
 *   - Bare CLI tier names (opus / sonnet / haiku) -> passthrough
 *   - Full Anthropic model IDs (claude-fable-5-1, claude-opus-5,
 *     claude-haiku-4-5-...) -> passthrough, verbatim
 *   - Other strings naming a tier (e.g. "Opus") -> matched by substring
 *   - The literal 'subscription' that proposition-app's
 *     src/lib/llm/models.ts has historically sent for all three
 *     local_bridge tiers -> default to 'sonnet' (the balanced tier
 *     subscriptions reliably have access to)
 *   - Anything unrecognized -> 'sonnet' (sensible fallback rather than
 *     letting Claude CLI reject the run)
 *
 * Future direction: the proposition-app models.ts is being updated to send
 * the actual tier name per modelTier. Once that lands and propagates,
 * 'subscription' will stop appearing in real traffic. The mapping stays as a
 * safety net for older clients.
 */
/** An empty working directory for module runs, so no project context leaks in. */
export function cleanWorkingDir(): string {
  const dir = join(tmpdir(), "seanpropapp-bridge-run");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** An MCP config with no servers, passed inline to `claude --mcp-config`. */
export const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

export function mapToClaudeCliModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized === "opus" || normalized === "sonnet" || normalized === "haiku") {
    return normalized;
  }
  // A full Anthropic model id goes to `claude --model` verbatim. The CLI
  // accepts full ids, and mapping them onto an alias is lossy: bridge Max sends
  // claude-fable-5-1, which the old substring match sent to 'sonnet' (Max ran
  // Sonnet while the app's provenance said Fable), and the Deep fallback rungs
  // claude-opus-5 / claude-opus-4-8 all collapsed back to 'opus'. An id this
  // Claude Code version does not know fails the run with the CLI's own
  // explanation rather than silently running a different model.
  if (/^claude-[a-z0-9.-]+$/.test(normalized)) return normalized;
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  // 'sonnet', 'subscription', 'claude-sonnet-*', and unrecognized values all
  // resolve to the balanced default tier.
  return "sonnet";
}

/** Flatten a message's string|block content into plain text. */
function messageText(m: AnthropicLikeRequest["messages"][number]): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * Build the single stdin prompt for `claude --print` from an Anthropic-style
 * messages array.
 *
 * Claude CLI's `--print` mode takes ONE prompt on stdin; it has no native
 * multi-turn input. A single user turn is sent verbatim — the overwhelmingly
 * common case (first module run, chat). For a multi-turn conversation we MUST
 * NOT send only the last turn: proposition-app's module RE-RUN packs the prior
 * output and the user's corrections into earlier turns, then ends with a short
 * "regenerate from the conversation above" instruction. Sending only that last
 * turn left the model with nothing to regenerate, so re-runs returned a stub
 * ("there's nothing above to regenerate or incorporate").
 *
 * Fix: flatten every turn into a role-labeled transcript (Human:/Assistant:)
 * so the full conversation reaches the model. The system prompt is passed
 * separately via --system-prompt and is not included here.
 *
 * Regression: proposition-app#446 / seanpropapp-cli#8 (shipped broken in
 * v0.1.0-beta.6 via the old lastUserText()).
 */
export function buildClaudePrompt(req: AnthropicLikeRequest): string {
  const turns = req.messages.filter((m) => messageText(m).trim().length > 0);
  // Single turn (or none): send the message text verbatim — identical to the
  // pre-fix single-message behavior, so first runs and chat are unchanged.
  if (turns.length <= 1) {
    return turns.length === 1 ? messageText(turns[0]!) : "";
  }
  // Multi-turn: preserve the full conversation as a labeled transcript.
  return turns
    .map((m) => {
      const text = messageText(m);
      if (m.role === "assistant") return `Assistant: ${text}`;
      // 'system' messages don't normally appear here (the client sends system
      // separately), but if one does, include its text without a turn label.
      if (m.role === "system") return text;
      return `Human: ${text}`;
    })
    .join("\n\n");
}

export class ClaudeProvider implements Provider {
  public readonly name = "claude";
  private readonly deps: Required<Omit<ClaudeProviderDeps, "spawnFn">> & {
    spawnFn: typeof spawn;
  };

  constructor(deps: ClaudeProviderDeps = {}) {
    this.deps = {
      whichFn: deps.whichFn ?? which,
      runCaptureFn: deps.runCaptureFn ?? runCapture,
      spawnFn: deps.spawnFn ?? spawn,
      binaryName: deps.binaryName ?? DEFAULT_BINARY,
    };
  }

  async detect(): Promise<ProviderDetectResult> {
    const binary = await this.deps.whichFn(this.deps.binaryName);
    if (!binary) {
      return { installed: false, reason: "claude binary not found in PATH" };
    }
    const versionRun = await this.deps.runCaptureFn(binary, ["--version"], {
      timeoutMs: 5000,
    });
    const version =
      versionRun.stdout.trim().split(/\s+/).pop() || versionRun.stderr.trim();
    return { installed: true, binary, version: version || undefined };
  }

  async *stream(
    request: AnthropicLikeRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AnthropicSSEEvent> {
    const detected = await this.detect();
    if (!detected.installed || !detected.binary) {
      throw new ClassifiedError("Claude CLI not installed", {
        category: "cli_missing",
        provider: this.name,
      });
    }

    // Translate whatever the browser sent into a model the Claude CLI accepts:
    // an alias (opus | sonnet | haiku) or a full claude-* id. Passing the abstract
    // 'subscription' that proposition-app/src/lib/llm/models.ts has been
    // emitting causes Claude CLI to exit with:
    //   "There's an issue with the selected model (subscription). It may
    //    not exist or you may not have access to it."
    const cliModel = mapToClaudeCliModel(request.model);
    // A module run must never see the user's MCP servers (seanpropapp-cli#39).
    // With the claude.ai SeanPropApp connector loaded, "Run the Company Context
    // module" invited the model to call that tool, which cannot be approved in a
    // non-interactive session, and the permission meta-reply was saved as the
    // module output. --strict-mcp-config with an empty config drops configured
    // servers; ENABLE_CLAUDEAI_MCP_SERVERS=false drops claude.ai connectors.
    // Likewise the user's own Claude Code context: their CLAUDE.md, settings,
    // plugins and whatever project the bridge was launched from. Skipping the
    // "user" setting source and running in an empty directory keeps a module
    // run to the prompt SeanPropApp sent (auth is unaffected).
    const args = [
      "--print", "--model", cliModel,
      "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG,
      "--setting-sources", "project,local",
    ];
    if (request.system) {
      args.push("--system-prompt", request.system);
    }
    // proposition-app#716: a research run permits WebSearch and WebFetch and
    // switches to stream-json so the bridge can report what was retrieved. A
    // run WITHOUT `research` keeps exactly the arguments above.
    const research = request.research !== undefined;
    if (research) args.push(...researchArgs());
    const stdinPayload = buildClaudePrompt(request);

    const child = this.deps.spawnFn(detected.binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cleanWorkingDir(),
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    });

    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    const abortHandler = () => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abortHandler);

    if (child.stdin) {
      child.stdin.end(stdinPayload);
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    yield { type: "message_start", message: { id: messageId, model: request.model } };
    // In a research run the tool blocks come first and the text block last, so
    // its index is only known once the research is over.
    if (!research) {
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      };
    }

    try {
      let totalOut = "";
      const researchState = newResearchParseState();
      if (research && child.stdout) {
        const lines = new LineBuffer();
        const translate = (line: string): AnthropicSSEEvent[] => {
          let evt: unknown;
          try {
            evt = JSON.parse(line);
          } catch {
            // Not JSON: keep it as failure evidence. The CLI prints a bad
            // --model or an auth failure as plain text even in stream-json mode.
            totalOut += line + "\n";
            return [];
          }
          return translateResearchEvent(evt, researchState);
        };
        for await (const chunk of child.stdout as AsyncIterable<Buffer | string>) {
          const text = typeof chunk === "string" ? chunk : chunk.toString();
          for (const line of lines.push(text)) yield* translate(line);
        }
        for (const line of lines.flush()) yield* translate(line);
        // The final answer is failure evidence too when the run reports an error.
        if (researchState.final) totalOut += researchState.final.text;
      }
      // NO rate-limit inspection of the content stream. `claude --print` is not
      // incremental: it emits the ENTIRE answer as a single stdout chunk (proven
      // by measurement, 1 chunk). So any "only look before real content arrives"
      // guard is vacuous here, and pattern-matching this chunk means grading the
      // model's own prose. That is what killed two production runs on the
      // Competitive Landscape module. Classification happens ONLY after a
      // non-zero exit, below.
      //
      // And NOTHING is sent to the client until the exit code is known. The CLI
      // reports a failure by printing it on stdout and exiting 1 (a spent
      // session window prints "You've hit your session limit · resets 10:10pm
      // (Europe/London)"). Forwarding stdout as it arrived sent that sentence
      // to the app as the first text of the module and THEN an error event,
      // so the client saw content and a failure for the same run. Since the
      // whole answer is one chunk at the end anyway, holding it for the exit
      // code costs no latency.
      const held: string[] = [];
      if (!research && child.stdout) {
        for await (const chunk of child.stdout as AsyncIterable<Buffer | string>) {
          const text = typeof chunk === "string" ? chunk : chunk.toString();
          if (text.length === 0) continue;
          totalOut += text;
          held.push(text);
        }
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once("close", (code) => resolve(code));
      });

      const stderr = stderrChunks.join("");
      // stream-json reports a failed run in its `result` event, and a run that
      // produced no `result` at all did not finish, whatever the exit code says.
      const researchFailed =
        research && (researchState.final === null || researchState.final.isError);
      if (exitCode !== 0 || researchFailed) {
        // The exit code is the ONLY trigger. Measured behaviour: the Claude CLI
        // reports failures on STDOUT with exit=1 and leaves stderr EMPTY (a bad
        // --model prints the explanation to stdout, stderr ""). So scanning
        // stderr alone would detect nothing real, and scanning stdout is only
        // safe once the CLI has already told us the run failed. A false positive
        // here can only mislabel an already-failed run; it can no longer destroy
        // a successful one.
        const evidence = [stderr, totalOut].filter(Boolean).join("\n").trim();
        const throttle = classifyThrottle(evidence);
        if (throttle) {
          throw new ClassifiedError(
            // Carry what the provider ACTUALLY said. The old message was the
            // bare string "Subscription rate limit", which is what the app
            // showed as "Raw provider response" too, so an incident left no
            // evidence at all and had to be reproduced to diagnose.
            //
            // The headline now matches the actual cause (CLI #27): a provider-side
            // 429 or 529 is NOT the user's subscription running out, and saying so
            // sent a user with 5% of their allowance used to go buy an upgrade.
            `${throttleHeadline(throttle, "Claude")} (exit ${exitCode}): ${evidence.slice(0, 300)}`,
            {
              category: throttle,
              retryAfterSeconds: parseRetryAfter(evidence),
              // Only the user's own window has a reset to wait for.
              resetsAt: throttle === "subscription_limit" ? parseResetTime(evidence) : undefined,
              provider: this.name,
            },
          );
        }
        throw new ClassifiedError(
          // stdout included deliberately: that is where this CLI explains
          // itself, so a stderr-only message was usually empty and useless.
          `Claude CLI exited with code ${exitCode}: ${(evidence || "(no output)").slice(0, 500)}`,
          { category: "cli_crashed", provider: this.name },
        );
      }

      // The run succeeded: now, and only now, the answer goes to the client.
      for (const text of held) {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
      }

      if (research && researchState.final) {
        const index = researchState.index;
        yield { type: "content_block_start", index, content_block: { type: "text", text: "" } };
        yield {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: researchState.final.text },
        };
        yield { type: "content_block_stop", index };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            output_tokens: researchState.final.outputTokens,
            input_tokens: researchState.final.inputTokens,
          },
        };
        yield { type: "message_stop" };
        return;
      }
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      };
      yield { type: "message_stop" };
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }
  }
}
