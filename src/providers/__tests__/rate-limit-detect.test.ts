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
import {
  detectRateLimit,
  parseRetryAfter,
  classifyThrottle,
  throttleHeadline,
} from "../rate-limit-detect.js";

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

/**
 * Three-way throttle classification (CLI #27).
 *
 * These three imply three different user actions, so collapsing them is not a
 * cosmetic wording issue: a user with 5% of their weekly allowance used was told
 * to wait for a subscription window to reset, beside a button offering to sell
 * them an upgrade that would have fixed nothing.
 */
describe('classifyThrottle separates the three causes', () => {
  it.each([
    // The user's own allowance. Claude CLI's real wording for a window cap.
    ['Usage limit reached. Your limits will reset at 04:00 UTC.', 'subscription_limit'],
    ['You have reached your usage limit for this 5-hour window', 'subscription_limit'],
    ['Weekly limit reached', 'subscription_limit'],
    ['You have exceeded your current plan limit', 'subscription_limit'],
    ['Upgrade your plan to continue', 'subscription_limit'],
    // Provider over capacity.
    ['API Error: 529 Overloaded', 'overloaded'],
    ['The service is overloaded, please retry', 'overloaded'],
    // Provider throttling this request.
    ['Number of requests has exceeded your rate limit', 'rate_limited'],
    ['Rate limit exceeded', 'rate_limited'],
    ['429 Too Many Requests', 'rate_limited'],
    ['quota exceeded', 'rate_limited'],
  ])('%s -> %s', (text, kind) => {
    expect(classifyThrottle(text)).toBe(kind);
  });

  it('prefers the subscription reading when both nouns appear', () => {
    // Order is load-bearing: the specific claim wins. A window-cap message that
    // also happens to say "rate limit" is still the user's allowance, and telling
    // them to "just retry" would send them in circles.
    expect(classifyThrottle('Rate limit hit: your weekly limit reached, resets Monday')).toBe(
      'subscription_limit',
    );
  });

  it('keys on the NOUN, not the verb, which is what distinguishes the two', () => {
    // "exceeded your X limit" means different things for X = usage vs X = rate.
    expect(classifyThrottle('exceeded your usage limit')).toBe('subscription_limit');
    expect(classifyThrottle('exceeded your rate limit')).toBe('rate_limited');
  });

  it('returns null for prose that merely discusses limits', () => {
    // Same guarantee as detectRateLimit: a limit must be CLAIMED, not discussed.
    expect(classifyThrottle('Competitor APIs impose a rate limit of 1,000 rpm')).toBeNull();
    expect(classifyThrottle('Datadog reached $429M ARR')).toBeNull();
    expect(classifyThrottle('subscription limits vary by plan')).toBeNull();
    expect(classifyThrottle('hello world')).toBeNull();
  });

  it('does not fire on a bare 529 in prose, only alongside the word', () => {
    // Same lesson as the bare /429/ that caused the original incident.
    expect(classifyThrottle('Revenue rose to $529M last year')).toBeNull();
    expect(classifyThrottle('529 Overloaded')).toBe('overloaded');
  });

  it('keeps detectRateLimit in agreement with classifyThrottle', () => {
    // detectRateLimit is derived, so the boolean gate cannot drift from the
    // three-way classification the way the two pattern lists once did.
    for (const t of ['Usage limit reached', '529 Overloaded', 'Rate limit exceeded', 'hello']) {
      expect(detectRateLimit(t)).toBe(classifyThrottle(t) !== null);
    }
  });
});

describe('throttleHeadline states the actual cause', () => {
  it('never calls a provider-side problem a subscription limit', () => {
    // The exact misdirection being fixed.
    expect(throttleHeadline('rate_limited', 'Claude')).not.toMatch(/subscription/i);
    expect(throttleHeadline('overloaded', 'Claude')).not.toMatch(/subscription/i);
    expect(throttleHeadline('subscription_limit', 'Claude')).toMatch(/subscription/i);
  });

  it('has no em dashes (project copy rule)', () => {
    for (const k of ['subscription_limit', 'rate_limited', 'overloaded'] as const) {
      expect(throttleHeadline(k, 'Claude')).not.toMatch(/—|–/);
    }
  });
});
