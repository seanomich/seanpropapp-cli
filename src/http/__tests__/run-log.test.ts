import { describe, it, expect } from "vitest";
import { formatRunLog, logProviderRun } from "../run-log.js";

describe("bridge run log", () => {
  it("emits a structured, parseable line with provider/model/ms/outcome", () => {
    const line = formatRunLog({
      provider: "codex",
      model: "subscription",
      durationMs: 1234,
      outcome: "ok",
    });
    expect(line.startsWith("[bridge-run] ")).toBe(true);
    const json = JSON.parse(line.slice("[bridge-run] ".length));
    expect(json).toEqual({ provider: "codex", model: "subscription", ms: 1234, outcome: "ok" });
  });

  it("includes the error category on failures", () => {
    const line = formatRunLog({
      provider: "claude",
      model: "subscription",
      durationMs: 5,
      outcome: "error",
      category: "cli_crashed",
    });
    expect(JSON.parse(line.slice("[bridge-run] ".length)).category).toBe("cli_crashed");
  });

  it("never includes prompt/response content (only metadata fields)", () => {
    const line = formatRunLog({
      provider: "codex",
      model: "subscription",
      durationMs: 9,
      outcome: "ok",
    });
    const keys = Object.keys(JSON.parse(line.slice("[bridge-run] ".length)));
    // The allowed fields are strictly metadata; no content channel exists.
    expect(keys.sort()).toEqual(["model", "ms", "outcome", "provider"]);
  });

  it("writes through the injected writer", () => {
    const lines: string[] = [];
    logProviderRun(
      { provider: "codex", model: "subscription", durationMs: 1, outcome: "ok" },
      (l) => lines.push(l),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"provider":"codex"');
  });
});
