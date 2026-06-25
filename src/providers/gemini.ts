import {
  ClassifiedError,
  type AnthropicLikeRequest,
  type AnthropicSSEEvent,
  type Provider,
  type ProviderDetectResult,
} from "./base.js";

/**
 * Gemini CLI provider — STUB.
 *
 * It reserves the `gemini` id, display name, and model routing in the registry
 * so detection, the /v1/handshake response, and the browser /pair screen all
 * surface Gemini as a known-but-not-yet-supported provider. Enabling Gemini for
 * real then means implementing detect() + stream() HERE (mirroring CodexProvider)
 * — not threading a new vendor through routing, handshake, and the UI. That is
 * the whole point of the provider registry.
 */
export class GeminiProvider implements Provider {
  public readonly name = "gemini";

  async detect(): Promise<ProviderDetectResult> {
    return { installed: false, reason: "Gemini CLI bridge not yet supported" };
  }

  async *stream(
    _request: AnthropicLikeRequest,
    _signal?: AbortSignal,
  ): AsyncIterable<AnthropicSSEEvent> {
    throw new ClassifiedError("Gemini CLI bridge is not yet supported.", {
      category: "cli_missing",
      provider: this.name,
    });
  }
}
