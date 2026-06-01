/**
 * Placeholder implementations for commands implemented in Lane C-Polish.
 * They print a clear message so users running pre-release builds aren't
 * left wondering.
 */

const COMING_SOON =
  "Coming in Lane C-Polish: see TODOS in the v1.4.0 release PR.\n";

export function runAutostartPlaceholder(): void {
  process.stdout.write(`autostart: ${COMING_SOON}`);
}
