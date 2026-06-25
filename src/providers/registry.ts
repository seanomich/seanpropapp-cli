import type { Provider } from "./base.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { GeminiProvider } from "./gemini.js";

/**
 * Single source of truth for the CLI providers the bridge supports.
 *
 * Detection, model routing, the /v1/handshake response, and the connect-flow
 * messaging all derive from this list. Adding a new vendor CLI (Gemini, Llama,
 * etc.) is: implement a `Provider` (detect + stream), then add ONE descriptor
 * here — no edits scattered across server.ts / handshake.ts / index.ts.
 */
export interface ProviderDescriptor {
  /** Stable id, also the handshake/registry key (e.g. "claude", "codex"). */
  id: string;
  /** Human-facing label (e.g. "Claude CLI"). */
  displayName: string;
  /**
   * Explicit-model routing: a request whose model starts with one of these
   * prefixes is sent to this provider regardless of what else is installed.
   * The bridge's generic `subscription` model matches none of these and is
   * routed by install-detection + precedence instead.
   */
  modelPrefixes: string[];
  /**
   * Generic-route precedence when MORE THAN ONE provider is installed and the
   * model is the generic `subscription`. Lower wins. Claude stays first to
   * preserve historical behavior; bridge-driven user selection is tracked in
   * proposition-app vendor work (#16).
   */
  precedence: number;
  /** Factory for a fresh provider instance. */
  create: () => Provider;
}

export const PROVIDER_REGISTRY: ProviderDescriptor[] = [
  {
    id: "claude",
    displayName: "Claude CLI",
    modelPrefixes: ["claude-"],
    precedence: 0,
    create: () => new ClaudeProvider(),
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    modelPrefixes: ["gpt-", "o3", "o1"],
    precedence: 1,
    create: () => new CodexProvider(),
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    modelPrefixes: ["gemini-"],
    precedence: 2,
    create: () => new GeminiProvider(),
  },
];

/**
 * Instantiate every registered provider, keyed by id. `overrides` lets tests
 * (or the server) substitute a provider instance for a given id; any id not
 * overridden is created from its descriptor.
 */
export function buildProviders(
  overrides: Record<string, Provider | undefined> = {},
): Map<string, Provider> {
  const map = new Map<string, Provider>();
  for (const d of PROVIDER_REGISTRY) {
    map.set(d.id, overrides[d.id] ?? d.create());
  }
  return map;
}

/**
 * The descriptor whose modelPrefixes match `model`, or null when the model is
 * generic (e.g. `subscription`) and should be routed by install-detection.
 */
export function descriptorForModel(model: string): ProviderDescriptor | null {
  const m = model.toLowerCase();
  return (
    PROVIDER_REGISTRY.find((d) =>
      d.modelPrefixes.some((p) => m.startsWith(p)),
    ) ?? null
  );
}

/** Registry ordered by ascending precedence (generic-route preference order). */
export function genericOrder(): ProviderDescriptor[] {
  return [...PROVIDER_REGISTRY].sort((a, b) => a.precedence - b.precedence);
}
