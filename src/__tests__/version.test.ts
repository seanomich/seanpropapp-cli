import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CLI_VERSION } from "../version.js";

// Drift guard: `src/version.ts` is hand-bumped and reported by `--version` and
// the bridge handshake. On 2026-06-14, package.json was bumped to beta.8 but
// CLI_VERSION was left at beta.7, so `seanpropapp --version` misreported the
// installed version. This test fails if the two ever diverge again.
const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
    "utf8",
  ),
) as { version: string };

describe("version", () => {
  it("CLI_VERSION matches package.json version", () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
