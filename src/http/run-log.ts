export interface ProviderRunLog {
  /** Registry provider id that served the run (claude, codex, ...). */
  provider: string;
  /** The requested model label (usually the generic `subscription`). */
  model: string;
  durationMs: number;
  outcome: "ok" | "error";
  /** ClassifiedError category on failure (cli_crashed, auth_required, ...). */
  category?: string;
}

/**
 * Structured, CONTENT-FREE per-run log line for the bridge.
 *
 * One line per provider run so ANY vendor's bridge activity is debuggable the
 * same way — the shared logging surface every current and future provider gets
 * for free (it lives at the endpoint, not inside each provider). It records only
 * the provider id, the (generic) model label, duration, outcome, and error
 * category. It MUST NEVER include the prompt, the response, or any analysis
 * content — that is the bridge's confidentiality commitment.
 */
export function formatRunLog(entry: ProviderRunLog): string {
  return (
    "[bridge-run] " +
    JSON.stringify({
      provider: entry.provider,
      model: entry.model,
      ms: entry.durationMs,
      outcome: entry.outcome,
      ...(entry.category ? { category: entry.category } : {}),
    })
  );
}

export function logProviderRun(
  entry: ProviderRunLog,
  write: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): void {
  write(formatRunLog(entry));
}
