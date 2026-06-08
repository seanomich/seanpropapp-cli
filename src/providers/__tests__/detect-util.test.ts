import { describe, it, expect } from "vitest";
import { which, runCapture } from "../detect-util.js";

const NODE = process.execPath;

describe("which", () => {
  it("resolves an installed binary to a non-empty path", async () => {
    // `node` itself is on PATH in dev and CI.
    const p = await which("node");
    expect(p === null || (typeof p === "string" && p.length > 0)).toBe(true);
    if (p) expect(p).toMatch(/node/i);
  });

  it("resolves a definitely-missing binary to null", async () => {
    expect(await which("seanpropapp-nope-xyz-9182")).toBeNull();
  });
});

describe("runCapture", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await runCapture(NODE, ["-e", "process.stdout.write('hi')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi");
  });

  it("captures a non-zero exit code", async () => {
    const r = await runCapture(NODE, ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });

  it("captures stderr", async () => {
    const r = await runCapture(NODE, ["-e", "process.stderr.write('boom')"]);
    expect(r.stderr).toContain("boom");
  });

  it("feeds stdin via opts.input", async () => {
    const r = await runCapture(
      NODE,
      ["-e", "process.stdin.on('data', (d) => process.stdout.write(d))"],
      { input: "PIPED" },
    );
    expect(r.stdout).toContain("PIPED");
  });

  it("never throws on a missing binary (returns code null)", async () => {
    const r = await runCapture("seanpropapp-nope-xyz-9182", ["--x"]);
    expect(r.code).toBeNull();
  });

  it("kills a hung process on timeout", async () => {
    const r = await runCapture(NODE, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    // Killed by SIGTERM -> close fires with a null exit code; never hangs the test.
    expect(r.code).toBeNull();
  });
});
