import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, "..", "..", "dist", "index.js");

describe("CLI plumbing (requires `npm run build` first)", () => {
  it("--help lists all six commands + quick start", () => {
    if (!existsSync(distEntry)) {
      // Build hasn't run yet — skip rather than fail in dev loop.
      return;
    }
    const res = spawnSync(process.execPath, [distEntry, "--help"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/connect/);
    expect(res.stdout).toMatch(/bridge/);
    expect(res.stdout).toMatch(/pair\b/);
    expect(res.stdout).toMatch(/mcp/);
    expect(res.stdout).toMatch(/doctor/);
    expect(res.stdout).toMatch(/autostart/);
    expect(res.stdout).toMatch(/Quick start: npx @seanpropapp\/cli connect/);
  });

  it("doctor runs the real diagnostic and prints section headings", () => {
    if (!existsSync(distEntry)) return;
    const res = spawnSync(process.execPath, [distEntry, "doctor"], {
      encoding: "utf8",
    });
    // Exit code may be 0 or 1 depending on whether the host has Claude CLI
    // installed + pairing complete. We only verify the diagnostic actually ran.
    expect(res.stdout).toMatch(/System\n/);
    expect(res.stdout).toMatch(/Providers\n/);
    expect(res.stdout).toMatch(/Bridge ports\n/);
    expect(res.stdout).toMatch(/Config\n/);
    expect(res.stdout).toMatch(/Bridge health\n/);
  });
});
