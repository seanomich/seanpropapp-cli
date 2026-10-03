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
 * WHICH kind of throttling a message describes (CLI #27).
 *
 * Three outcomes because they imply three different user actions:
 *
 *   subscription_limit  the user's own allowance is spent. Wait for the window,
 *                       or upgrade. A model fallback cannot help.
 *   rate_limited        the provider is throttling this request (429). Retry
 *                       shortly. Nothing is wrong with the plan.
 *   overloaded          the provider is overloaded (529). Retry, and this is the
 *                       correct trigger for a within-class model fallback.
 *
 * Collapsing all three into subscription_limit is what told a user with 5% of
 * their weekly allowance used to "wait for the subscription window to reset, or
 * upgrade your plan", beside an UPGRADE SUBSCRIPTION button that would have fixed
 * nothing (2026-07-26 Opus 5 incident).
 *
 * Order is significant: subscription wording is checked FIRST because it is the
 * most specific. Claude's CLI says "usage limit reached" and "your limits will
 * reset at HH:MM" for the subscription window, whereas a raw provider 429 says
 * "exceeded your RATE limit". The distinguishing signal is the noun, not the verb.
 */
export type ThrottleKind = 'subscription_limit' | 'rate_limited' | 'overloaded';

/** The user's own plan allowance. Claude CLI and Codex CLI wording. */
const SUBSCRIPTION_PATTERNS: RegExp[] = [
  /\b(?:usage|subscription|plan|weekly|daily|hourly|5-hour)\s+limits?\s+(?:has been\s+|have been\s+|was\s+|were\s+)?(?:reached|exceeded)\b/i,
  /\breached\s+(?:your\s+|their\s+|the\s+)?(?:current\s+)?(?:usage|subscription|plan|weekly|daily)\s+limits?\b/i,
  /\bexceeded\s+(?:your\s+)?(?:current\s+)?(?:usage|subscription|plan)\s+limits?\b/i,
  // A reset time is only ever quoted for a window cap.
  /\blimits?\s+will\s+reset\s+(?:at|in)\b/i,
  // Claude Code's current wording for the 5-hour window, verbatim from a real
  // run on 2026-10-03: "You've hit your session limit · resets 10:10pm
  // (Europe/London)". None of the patterns above read it (the verb is "hit",
  // the noun is "session", the reset is "resets"), so the run was reported as
  // `cli_crashed` and the app showed a crash to a user whose window was spent.
  /\b(?:hit|reached|exceeded)\s+(?:your\s+|the\s+)?(?:current\s+)?(?:session|usage|weekly|daily|hourly|5-hour|opus|sonnet)\s+limits?\b/i,
  // The same family names a reset straight after the limit.
  /\blimits?\b[^\n]{0,24}\bresets\s+(?:at\s+|in\s+)?\d/i,
  /\bupgrade\s+(?:your\s+)?plan\b/i,
];

/** The provider is over capacity. HTTP 529 on the Anthropic API. */
const OVERLOADED_PATTERNS: RegExp[] = [
  /\boverloaded\b/i,
  // Only alongside the word, never a bare number: "529" appears in prose.
  /\b529\s+overloaded\b/i,
];

/** Provider-side throttling of this request. HTTP 429. */
const RATE_LIMIT_ONLY_PATTERNS: RegExp[] = [
  /\brate\s+limits?\s+(?:has been\s+|have been\s+|was\s+|were\s+)?(?:reached|exceeded)\b/i,
  /\bexceeded\s+(?:your\s+)?(?:current\s+)?rate\s+limits?\b/i,
  /\breached\s+(?:your\s+|their\s+|the\s+)?(?:current\s+)?rate\s+limits?\b/i,
  /\btoo many requests\b/i,
  /\bquota\s+exceeded\b/i,
];

/**
 * Classify a throttling message, or null when the text does not claim one.
 *
 * Same two safety properties as `detectRateLimit`: a limit must be CLAIMED rather
 * than merely discussed, and the caller must only pass generated model output when
 * the CLI has already reported failure (see the module docstring).
 */
export function classifyThrottle(text: string): ThrottleKind | null {
  if (SUBSCRIPTION_PATTERNS.some((re) => re.test(text))) return 'subscription_limit';
  if (OVERLOADED_PATTERNS.some((re) => re.test(text))) return 'overloaded';
  if (RATE_LIMIT_ONLY_PATTERNS.some((re) => re.test(text))) return 'rate_limited';
  return null;
}

/** Human-readable lead-in per kind, so the app never has to invent the wording. */
export function throttleHeadline(kind: ThrottleKind, provider: string): string {
  switch (kind) {
    case 'subscription_limit':
      return `${provider} subscription limit reached`;
    case 'overloaded':
      return `${provider} is overloaded right now`;
    case 'rate_limited':
      return `${provider} rate limit on this request`;
  }
}

/*
 * The old flat RATE_LIMIT_PATTERNS list is gone. It is now three ordered lists
 * (SUBSCRIPTION_PATTERNS / OVERLOADED_PATTERNS / RATE_LIMIT_ONLY_PATTERNS) above,
 * because a single list could say "this is a throttle" but never which kind, and
 * every match was reported as the user's subscription running out.
 */

/**
 * True when `text` claims a rate/usage limit was hit.
 *
 * Safe to run on stderr and on a non-zero-exit dump. When running it over
 * generated model output, gate the call on "nothing has been emitted yet" (see
 * the module docstring, mitigation 2).
 */
export function detectRateLimit(text: string): boolean {
  // Derived from classifyThrottle so the boolean gate and the three-way
  // classification can never disagree about whether a message is a throttle.
  return classifyThrottle(text) !== null;
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

/**
 * When the window resets, as the CLI wrote it: "10:10pm (Europe/London)",
 * "3am", "at 14:30". Passed to the client verbatim so the app can tell the user
 * when to come back; it is not parsed into a time, because the CLI states it in
 * the user's own zone and a guess at the date would be wrong across midnight.
 */
export function parseResetTime(text: string): string | undefined {
  const m = /\bresets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s?(?:am|pm)?(?:\s*\([^)\n]{1,40}\))?)/i.exec(text);
  if (!m) return undefined;
  const when = m[1].trim();
  // A bare number with neither minutes nor am/pm is not a time of day ("resets 5 ...").
  return /:\d{2}|am|pm/i.test(when) ? when : undefined;
}
