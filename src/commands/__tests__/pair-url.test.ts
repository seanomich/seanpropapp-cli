import { describe, it, expect } from "vitest";
import {
  PAIR_BASE_URL,
  generatePairToken,
  osc8Link,
  pairUrl,
} from "../pair-url.js";

describe("pair-url", () => {
  it("generatePairToken returns 64 hex chars", () => {
    const t = generatePairToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generatePairToken is unique per call", () => {
    const a = generatePairToken();
    const b = generatePairToken();
    expect(a).not.toBe(b);
  });

  it("pairUrl uses URL fragment so the token never hits the server", () => {
    const t = "abc";
    expect(pairUrl(t)).toBe(`${PAIR_BASE_URL}#t=${t}`);
    // Fragments are never sent to the server.
    expect(pairUrl(t)).toContain("#t=");
    expect(pairUrl(t)).not.toContain("?t=");
  });

  it("osc8Link includes the URL and label", () => {
    const link = osc8Link("https://example.com", "https://example.com");
    expect(link).toContain("https://example.com");
    // The OSC 8 sequence starts with ESC (0x1b).
    expect(link.charCodeAt(0)).toBe(0x1b);
  });
});
