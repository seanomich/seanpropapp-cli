import type { ProviderDetectResult } from "./base.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";

export * from "./base.js";
export { ClaudeProvider } from "./claude.js";
export { CodexProvider } from "./codex.js";

export interface AllProvidersDetected {
  claude: ProviderDetectResult;
  codex: ProviderDetectResult;
  gemini: ProviderDetectResult;
}

/**
 * Detect every provider concurrently. Gemini is a known-stub for v1.4.0;
 * fast-follow in v1.4.x.
 */
export async function detectAllProviders(): Promise<AllProvidersDetected> {
  const [claude, codex] = await Promise.all([
    new ClaudeProvider().detect(),
    new CodexProvider().detect(),
  ]);
  return {
    claude,
    codex,
    gemini: { installed: false, reason: "not yet supported" },
  };
}
