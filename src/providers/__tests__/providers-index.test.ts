import { describe, it, expect } from "vitest";
import { detectAllProviders } from "../index.js";
import { ClassifiedError } from "../base.js";

describe("detectAllProviders", () => {
  it("returns claude, codex, and the gemini stub; never throws regardless of what is installed", async () => {
    const all = await detectAllProviders();
    expect(typeof all.claude.installed).toBe("boolean");
    expect(typeof all.codex.installed).toBe("boolean");
    // Gemini is a known stub for v1.4.0.
    expect(all.gemini.installed).toBe(false);
    expect(all.gemini.reason).toBeTruthy();
  });
});

describe("ClassifiedError", () => {
  it("carries category, retryAfterSeconds, and provider; is an Error", () => {
    const e = new ClassifiedError("rate limited", {
      category: "subscription_limit",
      retryAfterSeconds: 30,
      provider: "claude",
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ClassifiedError");
    expect(e.message).toBe("rate limited");
    expect(e.category).toBe("subscription_limit");
    expect(e.retryAfterSeconds).toBe(30);
    expect(e.provider).toBe("claude");
  });

  it("allows optional fields to be absent", () => {
    const e = new ClassifiedError("x", { category: "unknown" });
    expect(e.retryAfterSeconds).toBeUndefined();
    expect(e.provider).toBeUndefined();
  });
});
