import { randomBytes } from "node:crypto";

export const PAIR_BASE_URL = "https://prop.seanoneill.com/pair";

/** Generate a 32-byte hex pair token (64 hex chars). */
export function generatePairToken(): string {
  return randomBytes(32).toString("hex");
}

/** Build the pair URL with token in the URL fragment (#t=...). */
export function pairUrl(token: string): string {
  return `${PAIR_BASE_URL}#t=${token}`;
}

const ESC = String.fromCharCode(0x1b);

/**
 * Wrap a URL in an OSC 8 hyperlink escape so supporting terminals render it
 * clickable. Non-supporting terminals fall back to plain text (the label).
 *
 * Sequence shape: ESC ] 8 ; ; URL ESC \  LABEL  ESC ] 8 ; ; ESC \
 */
export function osc8Link(url: string, label: string): string {
  const OSC = `${ESC}]8;;`;
  const ST = `${ESC}\\`;
  return `${OSC}${url}${ST}${label}${OSC}${ST}`;
}
