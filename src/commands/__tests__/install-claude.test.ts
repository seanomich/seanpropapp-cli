import { describe, it, expect } from "vitest";
import { planClaudeInstall } from "../install-claude.js";

describe("planClaudeInstall", () => {
  it("returns a plan with platform + manualMessage for current platform", async () => {
    const plan = await planClaudeInstall();
    expect(plan.platform).toBe(process.platform);
    expect(plan.manualMessage.length).toBeGreaterThan(0);
  });

  it("references the Anthropic install path on macOS", async () => {
    if (process.platform !== "darwin") return;
    const plan = await planClaudeInstall();
    expect(plan.manualMessage).toMatch(/anthropic-ai\/claude\/claude/);
  });

  it("references claude.ai/cli on linux", async () => {
    if (process.platform !== "linux") return;
    const plan = await planClaudeInstall();
    expect(plan.manualMessage).toMatch(/claude\.ai\/cli/);
  });

  it("references claude.ai/cli on win32", async () => {
    if (process.platform !== "win32") return;
    const plan = await planClaudeInstall();
    expect(plan.manualMessage).toMatch(/claude\.ai\/cli/);
  });
});
