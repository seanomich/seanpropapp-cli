/**
 * Regression tests for the 2026-07-25 production incident.
 *
 * A live analysis died on the Competitive Landscape module and told the user
 * "Subscription rate limit" while their Claude subscription was demonstrably
 * healthy: Opus and Sonnet both answered a probe three minutes later, and a
 * genuine 5-hour window does not clear in three minutes.
 *
 * Cause: the detector ran a loose pattern set (including a bare /429/ and a bare
 * /rate.?limit/i) over the MODEL'S OWN streamed prose. Any analysis that
 * discussed rate limiting, quotas, or happened to contain the digits 429 was
 * killed and blamed on the provider. A pricing, market-sizing, or competitive
 * module is close to a worst case for that.
 *
 * The two mitigations are tested separately here because either alone still
 * leaves a hole:
 *   1. a limit must be CLAIMED, not merely discussed;
 *   2. generated content is only consulted before real output was emitted.
 */
import { describe, it, expect } from "vitest";
import { detectRateLimit, parseRetryAfter } from "../rate-limit-detect.js";

describe("detectRateLimit: real refusals still detected", () => {
  // These are the phrasings a CLI actually uses when refusing work. Losing any
  // of them costs the user the specific "wait for your window" advice.
  it.each([
    "Rate limit exceeded",
    "429 Too Many Requests",
    "subscription limit reached",
    "You have reached your usage limit for this 5-hour window",
    "Weekly limit reached. Your limits will reset at 03:00 UTC.",
    "You have exceeded your current plan limit",
    "quota exceeded",
    "Your limits will reset in 42 minutes",
  ])("detects: %s", (s) => {
    expect(detectRateLimit(s)).toBe(true);
  });
});

describe("detectRateLimit: analysis prose must NOT be read as a refusal", () => {
  // Every string below is realistic output from a Competitive Landscape,
  // Pricing, or Market Sizing module. ALL of these killed a run before the fix.
  it.each([
    // The bare /429/ pattern. Any dollar figure or count containing 429.
    "Datadog reached $429M ARR in the observability segment, growing 24% YoY.",
    "Serviceable market sized at 429 mid-market accounts in EMEA.",
    "HTTP 429 handling is a differentiator: Stripe retries transparently.",
    // The bare /rate.?limit/i pattern. Discussing a competitor's API limits.
    "Competitor APIs impose a rate limit of 1,000 requests per minute on the free tier.",
    "The incumbent's rate limiting is per-key rather than per-org.",
    // The /subscription.*limit/i pattern. Any SaaS pricing discussion.
    "Twilio subscription limits vary by plan; the Flex subscription limit is 5,000 seats.",
    "Pricing is subscription-based with no hard limit on seats.",
    // The /window.*capped/i pattern.
    "The renewal window is capped at 12 months for enterprise accounts.",
  ])("does not fire on: %s", (s) => {
    expect(detectRateLimit(s)).toBe(false);
  });

  it("does not fire on a whole paragraph of competitive prose", () => {
    // The per-chunk reality: a streamed chunk is prose, not a single sentence.
    const chunk = [
      "## Competitive Landscape",
      "",
      "Datadog reached $429M ARR in observability. Its API enforces a rate limit",
      "of 1,000 requests per minute, and subscription limits differ by plan tier.",
      "Customers hitting HTTP 429 are throttled rather than blocked.",
    ].join("\n");
    expect(detectRateLimit(chunk)).toBe(false);
  });

  it("still fires when a refusal is embedded in a larger stderr dump", () => {
    // Tightening must not cost us detection inside real CLI noise.
    const stderr = [
      "[debug] resolving model alias",
      "Error: usage limit reached for this account.",
      "Your limits will reset at 04:00 UTC.",
    ].join("\n");
    expect(detectRateLimit(stderr)).toBe(true);
  });
});

describe("the boundary the incident sat on", () => {
  it("separates 'the limit was hit' from 'the topic is limits'", () => {
    // Same noun, opposite meaning. This distinction IS the fix.
    expect(detectRateLimit("usage limit reached")).toBe(true);
    expect(detectRateLimit("usage limits are generous on the Pro plan")).toBe(false);

    expect(detectRateLimit("rate limit exceeded")).toBe(true);
    expect(detectRateLimit("they publish their rate limit openly")).toBe(false);
  });

  it("a bare status number is never sufficient on its own", () => {
    // The single worst pattern in the old set: three digits anywhere in a
    // financial document.
    expect(detectRateLimit("429")).toBe(false);
    expect(detectRateLimit("$429M")).toBe(false);
    // ...but the literal HTTP reason phrase still counts.
    expect(detectRateLimit("429 Too Many Requests")).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  it("pulls seconds from common phrasings", () => {
    expect(parseRetryAfter("Retry-After: 60s")).toBe(60);
    expect(parseRetryAfter("retry-after 1800")).toBe(1800);
    expect(parseRetryAfter("try again in 90s")).toBe(90);
    expect(parseRetryAfter("nothing here")).toBeUndefined();
  });

  it("returns undefined rather than guessing when the CLI gave no number", () => {
    // "will reset at 03:00 UTC" carries no seconds. Reporting a wrong wait is
    // worse than reporting none, since the app renders it as a countdown.
    expect(parseRetryAfter("Your limits will reset at 03:00 UTC")).toBeUndefined();
  });
});
