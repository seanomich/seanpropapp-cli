import { describe, it, expect, afterEach } from "vitest";
import {
  PAIR_BASE_URL,
  appBaseUrl,
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

  describe("SEANPROPAPP_URL override (local testing)", () => {
    const prev = process.env.SEANPROPAPP_URL;
    afterEach(() => {
      if (prev === undefined) delete process.env.SEANPROPAPP_URL;
      else process.env.SEANPROPAPP_URL = prev;
    });

    it("defaults to production when unset", () => {
      delete process.env.SEANPROPAPP_URL;
      expect(appBaseUrl()).toBe("https://prop.seanoneill.com");
      expect(pairUrl("abc")).toBe(`${PAIR_BASE_URL}#t=abc`);
    });

    it("points pair URL at the override (trailing slash trimmed)", () => {
      process.env.SEANPROPAPP_URL = "http://localhost:3000/";
      expect(appBaseUrl()).toBe("http://localhost:3000");
      expect(pairUrl("abc")).toBe("http://localhost:3000/pair#t=abc");
    });
  });

  it("osc8Link includes the URL and label", () => {
    const link = osc8Link("https://example.com", "https://example.com");
    expect(link).toContain("https://example.com");
    // The OSC 8 sequence starts with ESC (0x1b).
    expect(link.charCodeAt(0)).toBe(0x1b);
  });
});
