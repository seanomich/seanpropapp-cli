/**
 * Shared subscription-rate-limit detection for the CLI providers.
 *
 * WHY THIS EXISTS (production incident 2026-07-25): both providers ran a loose
 * pattern set over the model's own streamed output, so an analysis that merely
 * TALKED about rate limits was killed and reported to the user as "Subscription
 * rate limit". A real production run died on the Competitive Landscape module
 * while the user's Claude subscription was demonstrably healthy (Opus and Sonnet
 * both answered a probe three minutes later; a genuine 5-hour window does not
 * clear in three minutes).
 *
 * The old patterns included a bare /429/ and a bare /rate.?limit/i, matched
 * against every chunk of generated prose. Six of seven realistic competitive
 * analysis sentences tripped them, including "$429M ARR", "429 mid-market
 * accounts", and "competitor APIs impose a rate limit of 1,000 requests per
 * minute". A market-sizing or pricing module is close to a worst case.
 *
 * Two independent mitigations, because either alone still leaves a hole:
 *
 *   1. A limit must be CLAIMED, not merely discussed. Every pattern requires an
 *      explicit hit phrase (reached / exceeded / will reset / too many
 *      requests). Topic mentions no longer match.
 *   2. The caller only consults generated content BEFORE the run has emitted
 *      real output (see `looksLikeLimitNotice` usage in the providers). A CLI
 *      refusing on a limit emits the notice INSTEAD of an answer; it never
 *      arrives two thousand words into one. stderr and a non-zero exit stay
 *      fully trusted, because analysis prose never reaches stderr.
 *
 * Deliberate tradeoff: a real limit message whose wording we do not match now
 * degrades to a generic `cli_crashed` error (honest, less specific advice)
 * instead of the previous behavior, which killed good runs and misattributed
 * the cause. Losing advice specificity on a rare miss beats fabricating a
 * provider limit on a healthy account.
 */

/**
 * Phrases a CLI uses when it is actually refusing work. Each requires an
 * explicit hit phrase, so prose that merely discusses rate limiting, quotas, or
 * the number 429 does not match.
 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  // "<kind> limit reached" / "<kind> limits exceeded"
  /\b(?:rate|usage|subscription|plan|weekly|daily|hourly|5-hour)\s+limits?\s+(?:has been\s+|have been\s+|was\s+|were\s+)?(?:reached|exceeded)\b/i,
  // "exceeded your current usage limit"
  /\bexceeded\s+(?:your\s+)?(?:current\s+)?(?:rate|usage|subscription|plan)\s+limits?\b/i,
  // Reverse word order: "You've reached your usage limit for this 5-hour
  // window". Claude's CLI phrases it this way, and a verb-first pattern is the
  // one a noun-first rule misses. Note this CAN match prose such as
  // "competitors have reached their plan limits". What covers that differs by
  // provider: claude never inspects the content stream at all (the exit code is
  // its only trigger, because `claude --print` single-chunks the whole answer),
  // while codex still uses the no-output-yet gate, which is meaningful there
  // because it emits real per-line JSONL events.
  /\breached\s+(?:your\s+|their\s+|the\s+)?(?:current\s+)?(?:rate|usage|subscription|plan|weekly|daily)\s+limits?\b/i,
  // The literal HTTP 429 reason phrase. A bare "429" is NOT enough.
  /\btoo many requests\b/i,
  /\bquota\s+exceeded\b/i,
  // Claude CLI's reset wording, e.g. "Your limits will reset at 03:00 UTC".
  /\blimits?\s+will\s+reset\s+(?:at|in)\b/i,
];

/**
 * True when `text` claims a rate/usage limit was hit.
 *
 * Safe to run on stderr and on a non-zero-exit dump. When running it over
 * generated model output, gate the call on "nothing has been emitted yet" (see
 * the module docstring, mitigation 2).
 */
export function detectRateLimit(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

const RETRY_AFTER_PATTERNS: RegExp[] = [
  /retry.?after[:\s]+(\d+)\s*s/i,
  /retry.?after[:\s]+(\d+)/i,
  /try again in\s+(\d+)\s*s/i,
];

/** Seconds to wait, when the provider stated one. */
export function parseRetryAfter(text: string): number | undefined {
  for (const re of RETRY_AFTER_PATTERNS) {
    const m = re.exec(text);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}
