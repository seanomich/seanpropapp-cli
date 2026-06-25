import { describe, it, expect } from "vitest";
import {
  PROVIDER_REGISTRY,
  buildProviders,
  descriptorForModel,
  genericOrder,
} from "../registry.js";
import { GeminiProvider } from "../gemini.js";
import { ClassifiedError, type AnthropicSSEEvent } from "../base.js";

describe("provider registry", () => {
  it("routes an explicit model prefix to its provider", () => {
    expect(descriptorForModel("claude-sonnet-4")?.id).toBe("claude");
    expect(descriptorForModel("gpt-5")?.id).toBe("codex");
    expect(descriptorForModel("o3-mini")?.id).toBe("codex");
    expect(descriptorForModel("gemini-2.5-pro")?.id).toBe("gemini");
  });

  it("returns null for the generic 'subscription' model (routed by install-detection)", () => {
    expect(descriptorForModel("subscription")).toBeNull();
  });

  it("orders the generic route by precedence (Claude first)", () => {
    expect(genericOrder().map((d) => d.id)).toEqual(["claude", "codex", "gemini"]);
  });

  it("builds an instance per registry id and honors overrides", () => {
    const fake = { name: "codex" } as never;
    const map = buildProviders({ codex: fake });
    expect([...map.keys()].sort()).toEqual(["claude", "codex", "gemini"]);
    expect(map.get("codex")).toBe(fake);
    expect(map.get("claude")).not.toBe(fake);
  });

  it("every descriptor has a unique id and a factory", () => {
    const ids = PROVIDER_REGISTRY.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of PROVIDER_REGISTRY) expect(typeof d.create).toBe("function");
  });
});

describe("gemini stub provider", () => {
  it("detects as not-yet-supported (reserves the slot without claiming support)", async () => {
    const res = await new GeminiProvider().detect();
    expect(res.installed).toBe(false);
    expect(res.reason).toMatch(/not yet supported/i);
  });

  it("stream() throws a vendor-neutral cli_missing instead of pretending to run", async () => {
    const events: AnthropicSSEEvent[] = [];
    let err: ClassifiedError | undefined;
    try {
      for await (const e of new GeminiProvider().stream({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
      })) {
        events.push(e);
      }
    } catch (e) {
      if (e instanceof ClassifiedError) err = e;
      else throw e;
    }
    expect(err?.category).toBe("cli_missing");
    expect(err?.message).toMatch(/not yet supported/i);
    expect(events).toHaveLength(0);
  });
});
