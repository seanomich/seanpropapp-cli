import { randomBytes } from "node:crypto";

export const PROD_APP_URL = "https://prop.seanoneill.com";
export const PAIR_BASE_URL = `${PROD_APP_URL}/pair`;

/**
 * Base URL of the SeanPropApp web app the CLI pairs against. Defaults to
 * production. Override with the SEANPROPAPP_URL env var to point the connect /
 * pair / sample flows at a local dev server, e.g.:
 *
 *   SEANPROPAPP_URL=http://localhost:3000 npx @seanpropapp/cli connect
 *
 * This is what lets us run a real bridge pairing pass against localhost:3000
 * instead of always opening production. The bridge's CORS allow-list already
 * includes http://localhost:3000 (see src/http/cors.ts).
 */
export function appBaseUrl(): string {
  const override = process.env.SEANPROPAPP_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return PROD_APP_URL;
}

/** Generate a 32-byte hex pair token (64 hex chars). */
export function generatePairToken(): string {
  return randomBytes(32).toString("hex");
}

/** Build the pair URL with token in the URL fragment (#t=...). */
export function pairUrl(token: string): string {
  return `${appBaseUrl()}/pair#t=${token}`;
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
